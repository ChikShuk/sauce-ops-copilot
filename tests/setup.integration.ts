import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { POLL_INTERVAL_MS } from "../src/lib/config";
import { db, closeDb } from "../src/lib/db/client";

// Fail loudly rather than skipping: an integration suite that silently
// doesn't run is a worse failure mode than a red one.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set — integration tests need the dockerized Postgres (docker compose up -d db)",
  );
}

// Idempotent, so `npm test` works against a fresh container with no manual step.
const migrationConnection = postgres(process.env.DATABASE_URL, { max: 1 });
await migrate(drizzle(migrationConnection), {
  migrationsFolder: "./src/lib/db/migrations",
});
await migrationConnection.end();

/**
 * Refuse to run while another worker is consuming from this database.
 *
 * The queue is global: claimJob takes the oldest eligible job in the table
 * regardless of which test or process queued it. A `npm run worker` left
 * running against the same Postgres will therefore steal jobs out from under
 * the suite — and it does not fail cleanly. It produces a *different* test
 * failing on each run, always with a plausible-looking assertion (`queued`
 * reads 0, a provider records no calls, a finding hasn't appeared yet), which
 * is indistinguishable from a real bug until you go looking for the process.
 *
 * A canary job costs one poll interval once per run, and turns that class of
 * mystery into a named error.
 */
const canaryRestaurant = `canary_${randomUUID()}`;

const [canaryEvent] = await db.execute<{ id: string }>(sql`
  WITH new_event AS (
    INSERT INTO events (event_id, restaurant_id, event_type, issue_class, occurred_at, payload)
    VALUES (${`canary_${randomUUID()}`}, ${canaryRestaurant}, 'delivery_delay',
            'delivery_delay', now(), '{"delay_minutes": 1}'::jsonb)
    RETURNING id
  ),
  new_job AS (
    INSERT INTO event_jobs (event_id) SELECT id FROM new_event
  )
  SELECT id FROM new_event;
`);

await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 2));

const [canaryJob] = await db.execute<{ status: string; claimed_by: string | null }>(sql`
  SELECT status, claimed_by FROM event_jobs WHERE event_id = ${canaryEvent.id};
`);

await db.execute(sql`DELETE FROM finding_events WHERE event_id = ${canaryEvent.id};`);
await db.execute(sql`DELETE FROM findings WHERE restaurant_id = ${canaryRestaurant};`);
await db.execute(sql`DELETE FROM event_jobs WHERE event_id = ${canaryEvent.id};`);
await db.execute(sql`DELETE FROM events WHERE id = ${canaryEvent.id};`);

if (canaryJob.status !== "pending") {
  throw new Error(
    `another worker is consuming jobs from this database (a canary job was claimed by ` +
      `"${canaryJob.claimed_by ?? "unknown"}" and is now "${canaryJob.status}"). ` +
      `Stop it before running the integration suite — otherwise it races the tests for ` +
      `every queued job and fails a different assertion each run.`,
  );
}

afterAll(async () => {
  await closeDb();
});
