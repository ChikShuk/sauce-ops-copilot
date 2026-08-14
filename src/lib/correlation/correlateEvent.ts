import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/pgError";
import { logJson } from "../log";
import { fetchEvidence, fetchRecurrenceCounts, type SqlExecutor } from "./evidence";
import { scorePriority, type Priority, type PriorityDriver } from "./priority";
import { classifyAgainstWindow, summarizeEvidence } from "./window";

const OPEN_FINDING_CONSTRAINT = "findings_restaurant_id_open_key";

export type CorrelationOutcome = "created" | "attached" | "replaced" | "already_attached";

export type CorrelationResult = {
  findingId: string;
  outcome: CorrelationOutcome;
  version: number;
  priority: Priority | null;
  drivers: PriorityDriver[];
  eventCount: number;
  // Set only on "replaced".
  closedFindingId: string | null;
};

export type CorrelatableEvent = {
  id: string;
  restaurantId: string;
  orderId: string | null;
  occurredAt: Date;
};

type OpenFinding = {
  id: string;
  first_event_at: string;
  last_event_at: string;
};

async function runCorrelationTxn(event: CorrelatableEvent): Promise<CorrelationResult> {
  return db.transaction(async (tx) => {
    const exec = tx as unknown as SqlExecutor;

    // Redelivery guard. Not just an optimization: without it, a redelivered
    // event whose original finding has since closed would find no open finding,
    // create a new one, then no-op on finding_events_event_id_key — leaving a
    // finding with zero evidence.
    const existing = await exec.execute<{ finding_id: string; version: number; event_count: number; priority: string | null }>(sql`
      SELECT fe.finding_id, f.version, f.event_count, f.priority
      FROM finding_events fe
      JOIN findings f ON f.id = fe.finding_id
      WHERE fe.event_id = ${event.id};
    `);
    if (existing.length > 0) {
      const row = existing[0];
      return {
        findingId: row.finding_id,
        outcome: "already_attached",
        version: row.version,
        priority: row.priority as Priority | null,
        drivers: [],
        eventCount: row.event_count,
        closedFindingId: null,
      };
    }

    // Row-lock the open finding. Two workers attaching to the same finding
    // serialize here; a worker that finds nothing takes the create path, where
    // the partial unique index is what arbitrates instead.
    const open = await exec.execute<OpenFinding>(sql`
      SELECT id, first_event_at, last_event_at
      FROM findings
      WHERE restaurant_id = ${event.restaurantId} AND closed_at IS NULL
      FOR UPDATE;
    `);

    let findingId: string;
    let outcome: CorrelationOutcome;
    let closedFindingId: string | null = null;

    if (open.length === 0) {
      findingId = await insertFinding(exec, event, { bornClosed: false });
      outcome = "created";
    } else {
      const current = open[0];
      const relation = classifyAgainstWindow(
        {
          firstEventAt: new Date(current.first_event_at),
          lastEventAt: new Date(current.last_event_at),
        },
        event.occurredAt,
      );

      if (relation === "inside") {
        findingId = current.id;
        outcome = "attached";
      } else if (relation === "future_side") {
        // The window genuinely lapsed: close the stale finding and open its
        // replacement. Two ordered statements in one transaction, deliberately
        // NOT one CTE statement — CTEs share a snapshot, so the partial unique
        // index would still see the pre-close row as a live conflict and the
        // insert would raise 23505 against a row we just closed ourselves.
        await exec.execute(sql`
          UPDATE findings SET closed_at = now()
          WHERE id = ${current.id} AND closed_at IS NULL
          RETURNING id;
        `);
        closedFindingId = current.id;
        findingId = await insertFinding(exec, event, { bornClosed: false });
        outcome = "replaced";
      } else {
        // past_side: a backfill. Closing is driven by elapsed time since the
        // finding's OWN last_event_at, never by an unrelated old event
        // arriving — so the live finding is left untouched and this event gets
        // its own finding, born closed because its window is already past.
        // The partial index only covers closed_at IS NULL, so a born-closed row
        // never conflicts and this path cannot raise 23505.
        findingId = await insertFinding(exec, event, { bornClosed: true });
        outcome = "created";
      }
    }

    // Idempotent attach. Bare DO NOTHING with no conflict target: both the
    // composite PK and finding_events_event_id_key can fire here and both mean
    // the same thing — this evidence is already recorded.
    const attached = await exec.execute<{ event_id: string }>(sql`
      INSERT INTO finding_events (finding_id, event_id)
      VALUES (${findingId}, ${event.id})
      ON CONFLICT DO NOTHING
      RETURNING event_id;
    `);

    if (attached.length === 0) {
      // Unreachable given the redelivery guard above; if it happens an
      // assumption broke and it should be visible, not swallowed.
      logJson({
        msg: "correlation.attach_noop_unexpected",
        event_id: event.id,
        finding_id: findingId,
      });
      const [row] = await exec.execute<{ version: number; event_count: number; priority: string | null }>(sql`
        SELECT version, event_count, priority FROM findings WHERE id = ${findingId};
      `);
      return {
        findingId,
        outcome: "already_attached",
        version: row.version,
        priority: row.priority as Priority | null,
        drivers: [],
        eventCount: row.event_count,
        closedFindingId,
      };
    }

    const evidence = await fetchEvidence(exec, findingId);
    const summary = summarizeEvidence(evidence);
    const recurrence = await fetchRecurrenceCounts(exec, event.restaurantId, summary.lastEventAt);
    const { priority, drivers } = scorePriority({
      evidence,
      recurrenceByIssueClass: recurrence,
    });

    // Denormalized fields are recomputed from the evidence set rather than
    // incremented, so they converge after a partially applied run instead of
    // drifting permanently.
    //
    // priority_drivers is written here and nowhere else, in the same statement
    // as priority itself — the two are one decision and must not be able to
    // disagree.
    const [updated] = await exec.execute<{ version: number }>(sql`
      UPDATE findings
      SET version = version + 1,
          event_count = ${summary.eventCount},
          first_event_at = ${summary.firstEventAt.toISOString()},
          last_event_at = ${summary.lastEventAt.toISOString()},
          order_id = COALESCE(order_id, ${summary.orderId}),
          priority = ${priority},
          priority_drivers = ${JSON.stringify(drivers)}::jsonb
      WHERE id = ${findingId}
      RETURNING version;
    `);

    return {
      findingId,
      outcome,
      version: updated.version,
      priority,
      drivers,
      eventCount: summary.eventCount,
      closedFindingId,
    };
  });
}

async function insertFinding(
  exec: SqlExecutor,
  event: CorrelatableEvent,
  opts: { bornClosed: boolean },
): Promise<string> {
  const occurred = event.occurredAt.toISOString();
  const rows = await exec.execute<{ id: string }>(sql`
    INSERT INTO findings (restaurant_id, order_id, status, event_count, first_event_at, last_event_at, closed_at)
    VALUES (${event.restaurantId}, ${event.orderId}, 'accepted', 0, ${occurred}, ${occurred},
            ${opts.bornClosed ? sql`now()` : sql`NULL`})
    RETURNING id;
  `);
  return rows[0].id;
}

// A 23505 aborts the whole transaction, so the retry must be a NEW transaction
// rather than a continuation. Exactly one: the winner's finding is committed and
// visible to a fresh snapshot, so the retry takes the attach path. A second
// failure means an assumption is wrong, not that the database is busy — let it
// reach the worker's retry/backoff/DLQ machinery instead of spinning here.
export async function correlateEvent(event: CorrelatableEvent): Promise<CorrelationResult> {
  try {
    return await runCorrelationTxn(event);
  } catch (err) {
    if (!isUniqueViolation(err, OPEN_FINDING_CONSTRAINT)) throw err;
    logJson({
      msg: "correlation.insert_race_retry",
      event_id: event.id,
      restaurant_id: event.restaurantId,
    });
    return runCorrelationTxn(event);
  }
}
