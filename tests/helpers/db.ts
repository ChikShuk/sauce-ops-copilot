import { sql } from "drizzle-orm";
import { db } from "../../src/lib/db/client";

export { closeDb } from "../../src/lib/db/client";

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
};

export async function findingsFor(restaurantId: string): Promise<FindingRow[]> {
  return db.execute<FindingRow>(sql`
    SELECT id, restaurant_id, order_id, version, status, priority,
           event_count, first_event_at, last_event_at, closed_at
    FROM findings
    WHERE restaurant_id = ${restaurantId}
    ORDER BY first_event_at ASC;
  `);
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
