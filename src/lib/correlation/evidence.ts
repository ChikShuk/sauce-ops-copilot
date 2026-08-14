import { sql } from "drizzle-orm";
import { z } from "zod";
import { RECURRENCE_WINDOW_MS, type PriorityEvidence } from "./priority";

// Payload is untyped jsonb by design (its shape varies by event_type), so read
// it leniently: a malformed or absent field yields null rather than throwing.
// A bad payload must not kill correlation — the finding still gets created,
// prioritized on whatever signals remain, and evidenced.
const delayPayload = z.object({ delay_minutes: z.number() });
const ratingPayload = z.object({ rating: z.number() });

function readDelayMinutes(payload: unknown): number | null {
  const parsed = delayPayload.safeParse(payload);
  return parsed.success ? parsed.data.delay_minutes : null;
}

function readRating(payload: unknown): number | null {
  const parsed = ratingPayload.safeParse(payload);
  return parsed.success ? parsed.data.rating : null;
}

type EvidenceRow = {
  event_id: string;
  event_type: string;
  issue_class: string;
  occurred_at: string;
  order_id: string | null;
  payload: unknown;
};

export type EvidenceItem = PriorityEvidence & {
  eventId: string;
  orderId: string | null;
};

// Minimal shape of a transaction handle — enough to run raw SQL, so callers can
// pass either db or a tx without this module depending on Drizzle's generics.
export type SqlExecutor = {
  execute: <T>(query: ReturnType<typeof sql>) => Promise<T[]>;
};

// Evidence is assembled from finding_events, never from model output.
export async function fetchEvidence(
  tx: SqlExecutor,
  findingId: string,
): Promise<EvidenceItem[]> {
  const rows = await tx.execute<EvidenceRow>(sql`
    SELECT e.id AS event_id, e.event_type, e.issue_class, e.occurred_at, e.order_id, e.payload
    FROM finding_events fe
    JOIN events e ON e.id = fe.event_id
    WHERE fe.finding_id = ${findingId}
    ORDER BY e.occurred_at ASC;
  `);

  return rows.map((row) => ({
    eventId: row.event_id,
    eventType: row.event_type,
    issueClass: row.issue_class,
    occurredAt: new Date(row.occurred_at),
    orderId: row.order_id,
    delayMinutes: row.event_type === "delivery_delay" ? readDelayMinutes(row.payload) : null,
    rating: row.event_type === "negative_review" ? readRating(row.payload) : null,
  }));
}

// Counts of same-issue_class events at this restaurant, anchored to the
// finding's own last_event_at rather than now() so the score is a pure function
// of the evidence and doesn't drift on reprocessing.
export async function fetchRecurrenceCounts(
  tx: SqlExecutor,
  restaurantId: string,
  anchor: Date,
): Promise<Record<string, number>> {
  const rows = await tx.execute<{ issue_class: string; n: number }>(sql`
    SELECT issue_class, count(*)::int AS n
    FROM events
    WHERE restaurant_id = ${restaurantId}
      AND occurred_at >  ${new Date(anchor.getTime() - RECURRENCE_WINDOW_MS).toISOString()}
      AND occurred_at <= ${anchor.toISOString()}
    GROUP BY issue_class;
  `);

  return Object.fromEntries(rows.map((row) => [row.issue_class, row.n]));
}
