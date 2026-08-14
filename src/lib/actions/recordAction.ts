import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../correlation/evidence";
import { db } from "../db/client";
import { logJson } from "../log";
import type { OperatorActionInput, OperatorActionType } from "./schema";

export type RecordedAction = {
  findingId: string;
  actionType: OperatorActionType;
  version: number;
  reviewedAt: string | null;
  resolvedAt: string | null;
};

type FindingSnapshotRow = {
  version: number;
  priority: string | null;
  status: string;
  issue: string | null;
  summary: string | null;
  summary_source: string | null;
  llm_model: string | null;
  recommended_actions: unknown;
  cited_event_ids: unknown;
};

// Which columns each action owns. mark_reviewed and mark_resolved are both
// first-write-wins via COALESCE: `reviewed_at` then means "when this was first
// triaged", which is the useful reading, and a double-click cannot move it.
// The audit row is appended either way — see below.
const STATE_UPDATES: Record<OperatorActionType, ReturnType<typeof sql> | null> = {
  mark_reviewed: sql`reviewed_at = COALESCE(reviewed_at, now())`,
  // Resolving closes the finding for correlation as well (docs/decisions.md):
  // the operator is done with it, so the next event at this restaurant should
  // start a fresh one rather than reopening this. Setting closed_at REMOVES the
  // row from findings_restaurant_id_open_key — a partial index over
  // `closed_at IS NULL` — so this can never raise 23505.
  mark_resolved: sql`resolved_at = COALESCE(resolved_at, now()),
                     closed_at = COALESCE(closed_at, now())`,
  // Feedback changes no finding state. It is an observation about the prose,
  // not a decision about the incident.
  thumbs_down: null,
};

/**
 * Build the snapshot stored on the audit row.
 *
 * Prose is copied, evidence is referenced by id. The reason is in the schema
 * comment on `operator_actions.context`, and it is the difference between a
 * usable eval example and a row saying "someone disliked something, once": the
 * summary being judged is overwritten by the next enrichment, while `events`
 * rows never change.
 */
async function buildContext(
  exec: SqlExecutor,
  findingId: string,
  actionType: OperatorActionType,
  row: FindingSnapshotRow,
): Promise<Record<string, unknown>> {
  const base = {
    version: row.version,
    priority: row.priority,
    status: row.status,
  };

  if (actionType !== "thumbs_down") {
    return base;
  }

  const evidence = await exec.execute<{ event_id: string }>(sql`
    SELECT fe.event_id
    FROM finding_events fe
    JOIN events e ON e.id = fe.event_id
    WHERE fe.finding_id = ${findingId}
    ORDER BY e.occurred_at ASC, e.id ASC;
  `);

  return {
    ...base,
    issue: row.issue,
    summary: row.summary,
    summary_source: row.summary_source,
    llm_model: row.llm_model,
    recommended_actions: row.recommended_actions,
    cited_event_ids: row.cited_event_ids,
    // Ids, not copies. Same order the model was issued them in, so E1..En can be
    // reconstructed exactly.
    evidence_event_ids: evidence.map((item) => item.event_id),
  };
}

/**
 * Persist one operator action.
 *
 * The audit row and the finding's state fields are written in a single
 * transaction, so `operator_actions` and `findings.reviewed_at` can never
 * disagree about what happened.
 *
 * Every call appends a row. There is deliberately no unique constraint on
 * (finding_id, action_type): `operator_actions` is an append-only audit log and
 * an operator reviewing a finding again after new evidence is a real event that
 * a log should not silently drop. Current state lives on `findings` instead,
 * which is what makes the duplicate harmless rather than merely tolerated.
 */
export async function recordAction(
  findingId: string,
  input: OperatorActionInput,
): Promise<RecordedAction | null> {
  return db.transaction(async (tx) => {
    const exec = tx as unknown as SqlExecutor;

    // FOR UPDATE so the snapshot below and the state write see the same row —
    // enrichment can be rewriting this finding's prose concurrently, and the
    // context has to record what the operator actually saw.
    const rows = await exec.execute<FindingSnapshotRow>(sql`
      SELECT version, priority, status, issue, summary, summary_source, llm_model,
             recommended_actions, cited_event_ids
      FROM findings
      WHERE id = ${findingId}
      FOR UPDATE;
    `);

    if (rows.length === 0) {
      return null;
    }

    const context = await buildContext(exec, findingId, input.action_type, rows[0]);

    await exec.execute(sql`
      INSERT INTO operator_actions (finding_id, action_type, note, context)
      VALUES (${findingId}, ${input.action_type}, ${input.note ?? null},
              ${JSON.stringify(context)}::jsonb);
    `);

    const stateUpdate = STATE_UPDATES[input.action_type];
    let reviewedAt: string | null = null;
    let resolvedAt: string | null = null;

    if (stateUpdate) {
      const [updated] = await exec.execute<{
        reviewed_at: string | null;
        resolved_at: string | null;
      }>(sql`
        UPDATE findings
        SET ${stateUpdate}
        WHERE id = ${findingId}
        RETURNING reviewed_at, resolved_at;
      `);
      reviewedAt = updated.reviewed_at;
      resolvedAt = updated.resolved_at;
    } else {
      const [current] = await exec.execute<{
        reviewed_at: string | null;
        resolved_at: string | null;
      }>(sql`SELECT reviewed_at, resolved_at FROM findings WHERE id = ${findingId};`);
      reviewedAt = current.reviewed_at;
      resolvedAt = current.resolved_at;
    }

    logJson({
      msg: "operator.action_recorded",
      finding_id: findingId,
      action_type: input.action_type,
      version: rows[0].version,
      has_note: input.note !== undefined,
    });

    return {
      findingId,
      actionType: input.action_type,
      version: rows[0].version,
      reviewedAt: reviewedAt === null ? null : new Date(reviewedAt).toISOString(),
      resolvedAt: resolvedAt === null ? null : new Date(resolvedAt).toISOString(),
    };
  });
}
