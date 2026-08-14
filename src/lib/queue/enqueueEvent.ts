import { sql } from "drizzle-orm";
import { db } from "../db/client";
import type { NewEventRow } from "../events/normalize";

export type EnqueueResult = {
  id: string;
  duplicate: boolean;
};

type Row = { id: string; inserted: boolean };

// Single statement, per CLAUDE.md invariant 3: the event_jobs row is
// written in the same statement as the event, so "saved but never queued"
// is impossible by construction.
//
// ON CONFLICT ... DO NOTHING (not DO UPDATE) is deliberate: events is
// immutable, and a DO UPDATE self-assignment trick to get RETURNING to
// fire on conflict would still write a new row version on every duplicate
// (bumps xmax, takes a row lock, creates a dead tuple) — wrong for a row
// that's supposed to never be touched again, and it would make concurrent
// duplicates serialize on a lock for no reason. Instead, the UNION ALL
// branch below does a plain, lock-free SELECT for the existing row's id,
// and only runs at all when the insert didn't happen.
export async function enqueueEvent(row: NewEventRow): Promise<EnqueueResult> {
  const result = await db.execute<Row>(sql`
    WITH new_event AS (
      INSERT INTO events (event_id, restaurant_id, order_id, event_type, issue_class, occurred_at, payload)
      VALUES (${row.eventId}, ${row.restaurantId}, ${row.orderId}, ${row.eventType},
              // .toISOString(), not the raw Date: db.execute's raw sql tag
              // has no column-type context, and postgres.js's parameter
              // binder rejects a bare Date object at this layer (it's fine
              // through the query builder, which knows the column is a
              // timestamp and serializes accordingly).
              ${row.issueClass}, ${row.occurredAt.toISOString()}, ${JSON.stringify(row.payload)}::jsonb)
      ON CONFLICT (restaurant_id, event_id) DO NOTHING
      RETURNING id
    ),
    new_job AS (
      INSERT INTO event_jobs (event_id) SELECT id FROM new_event
    )
    SELECT id, true AS inserted FROM new_event
    UNION ALL
    SELECT id, false AS inserted FROM events
    WHERE restaurant_id = ${row.restaurantId} AND event_id = ${row.eventId}
      AND NOT EXISTS (SELECT 1 FROM new_event);
  `);

  const [first] = result;
  if (!first) {
    throw new Error("enqueueEvent: expected exactly one row back, got none");
  }
  return { id: first.id, duplicate: !first.inserted };
}
