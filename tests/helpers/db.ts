import { eq, sql } from "drizzle-orm";
import { db } from "../../src/lib/db/client";
import { events } from "../../src/lib/db/schema";
import type { EventRow } from "../../src/worker/processEvent";

export { closeDb } from "../../src/lib/db/client";

// Must go through the query builder, not raw SQL: db.execute returns the
// database's snake_case column names, while EventRow is Drizzle's camelCase
// model. A raw SELECT * hands processEvent a row whose restaurantId is
// undefined, which fails much later and much less obviously.
export async function eventRowById(id: string): Promise<EventRow> {
  const [row] = await db.select().from(events).where(eq(events.id, id));
  if (!row) throw new Error(`no events row with id ${id}`);
  return row;
}

// Not needed by the correlation tests — they isolate by restaurant_id — but
// slice 9's failure tests will want a globally clean slate.
//
// One statement, not five: finding_events.event_id is ON DELETE RESTRICT, so
// truncating events on its own fails, and CASCADE on the wrong table is a
// footgun. Naming every table in a single TRUNCATE satisfies the FK checks.
export async function resetDb(): Promise<void> {
  await db.execute(
    sql`TRUNCATE operator_actions, finding_events, findings, event_jobs, events;`,
  );
}

export type FindingRow = {
  id: string;
  restaurant_id: string;
  order_id: string | null;
  version: number;
  status: string;
  priority: string | null;
  event_count: number;
  first_event_at: string;
  last_event_at: string;
  closed_at: string | null;
  issue: string | null;
  summary: string | null;
  recommended_actions: { type: string; rationale: string }[] | null;
  extracted_tags: string[] | null;
  cited_event_ids: string[] | null;
  summary_source: string | null;
  llm_model: string | null;
  enriched_at: string | null;
};

export async function findingsFor(restaurantId: string): Promise<FindingRow[]> {
  return db.execute<FindingRow>(sql`
    SELECT id, restaurant_id, order_id, version, status, priority,
           event_count, first_event_at, last_event_at, closed_at,
           issue, summary, recommended_actions, extracted_tags,
           cited_event_ids, summary_source, llm_model, enriched_at
    FROM findings
    WHERE restaurant_id = ${restaurantId}
    ORDER BY first_event_at ASC;
  `);
}

export async function jobFor(eventId: string): Promise<{
  status: string;
  attempts: number;
  last_error: string | null;
} | null> {
  const rows = await db.execute<{ status: string; attempts: number; last_error: string | null }>(sql`
    SELECT status, attempts, last_error FROM event_jobs WHERE event_id = ${eventId};
  `);
  return rows[0] ?? null;
}

export async function evidenceFor(findingId: string): Promise<string[]> {
  const rows = await db.execute<{ event_id: string }>(sql`
    SELECT fe.event_id
    FROM finding_events fe
    JOIN events e ON e.id = fe.event_id
    WHERE fe.finding_id = ${findingId}
    ORDER BY e.occurred_at ASC;
  `);
  return rows.map((r) => r.event_id);
}
