import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { POLL_INTERVAL_MS } from "../src/lib/config";

// Fail loudly rather than skipping: an integration suite that silently
// doesn't run is a worse failure mode than a red one.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set — integration tests need the dockerized Postgres (docker compose up -d db)",
  );
}

/**
 * The suite runs against its own database, `<database>_test`, on the same server.
 *
 * Not a preference — the queue is the reason. `claimJob` takes the oldest
 * eligible row in `event_jobs` regardless of which process queued it, so any
 * worker pointed at the same database competes with the tests for every job
 * they enqueue. That includes the `worker` service in `docker compose up`,
 * which means the documented way to run this project and the documented way to
 * test it could not both be true at once. Separating the database is what makes
 * `npm test` a single green command while the app is running beside it.
 *
 * Sharing one server and one migration history keeps this cheap: no second
 * container, no schema drift, and `DATABASE_URL` stays the only thing to
 * configure.
 */
function testDatabaseUrl(source: string): { test: string; admin: string; name: string } {
  const url = new URL(source);
  const name = url.pathname.replace(/^\//, "");
  const testName = name.endsWith("_test") ? name : `${name}_test`;

  const test = new URL(source);
  test.pathname = `/${testName}`;

  // Creating a database cannot be done from inside it. `postgres` is the
  // maintenance database every server has.
  const admin = new URL(source);
  admin.pathname = "/postgres";

  return { test: test.toString(), admin: admin.toString(), name: testName };
}

const target = testDatabaseUrl(process.env.DATABASE_URL);

const adminConnection = postgres(target.admin, { max: 1 });
try {
  const [existing] = await adminConnection<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_database WHERE datname = ${target.name};
  `;
  if (existing.count === 0) {
    // Identifier, not a value — postgres.js's unsafe() is the escape hatch, and
    // the name is derived from DATABASE_URL rather than from user input.
    await adminConnection.unsafe(`CREATE DATABASE "${target.name}"`);
  }
} catch (err) {
  throw new Error(
    `could not create the test database "${target.name}": ${err instanceof Error ? err.message : String(err)}. ` +
      `The role in DATABASE_URL needs CREATEDB, or create the database by hand.`,
  );
} finally {
  await adminConnection.end();
}

// Rewritten before the db client is imported below, so every module that reads
// it — env.ts, client.ts, and anything the test files pull in — sees the test
// database. This is why the client import is dynamic and why nothing above may
// import it transitively.
process.env.DATABASE_URL = target.test;

/**
 * The suite cannot reach a live model, by construction rather than by habit.
 *
 * `runJob`, `processEvent` and `enrichFinding` all take an optional provider and
 * fall back to whatever `LLM_PROVIDER` names. Every test but one injects a stub —
 * but "every test but one" is a property of the current tests, not of the suite,
 * and the exception cost real money and a timeout before it was found. A
 * developer with `LLM_PROVIDER=anthropic` in `.env` (the setting you need to demo
 * the product) would otherwise have `npm test` billing an API and failing on
 * network latency.
 *
 * Both lines are needed. Forcing the provider covers the env default; deleting
 * the key covers the runtime override, since an `app_settings` row naming
 * `anthropic` would otherwise select the real provider — with no key, getProvider
 * degrades to the fallback writer instead. Together they mean no code path in
 * this suite can make a network call to a model.
 *
 * Two ways out, both deliberate. A whole run can opt out with `ALLOW_LIVE_LLM=true`
 * for a genuine live check. A single test opts out by mocking `src/lib/env` with
 * getters — the pattern in deadLetterFinding, providerToggle and reenrichJob —
 * which replaces this environment entirely for that file.
 *
 * tests/integration/noLiveLlm.test.ts asserts all of this, so deleting these two
 * lines turns something red rather than quietly restoring the old behaviour.
 */
if (process.env.ALLOW_LIVE_LLM !== "true") {
  process.env.LLM_PROVIDER = "fallback";
  delete process.env.ANTHROPIC_API_KEY;
}

const { db, closeDb } = await import("../src/lib/db/client");

// Idempotent, so `npm test` works against a fresh container with no manual step.
const migrationConnection = postgres(target.test, { max: 1 });
await migrate(drizzle(migrationConnection), {
  migrationsFolder: "./src/lib/db/migrations",
});
await migrationConnection.end();

/**
 * Refuse to run while another worker is consuming from this database.
 *
 * The separate test database above removes the ordinary way this happens — a
 * `npm run worker` or a compose stack against the dev database no longer
 * touches the suite. What remains is a worker deliberately pointed at the test
 * database (a stale `DATABASE_URL` in a shell, a second suite running against
 * the same Postgres), and that still steals jobs, because the queue is global:
 * claimJob takes the oldest eligible row regardless of which process queued it.
 *
 * It does not fail cleanly either. It produces a *different* test failing on
 * each run, always with a plausible-looking assertion (`queued` reads 0, a
 * provider records no calls, a finding hasn't appeared yet), which is
 * indistinguishable from a real bug until you go looking for the process. A
 * canary job costs one poll interval once per run and turns that class of
 * mystery into a named error, so it stays.
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
    `another worker is consuming jobs from the test database "${target.name}" (a canary ` +
      `job was claimed by "${canaryJob.claimed_by ?? "unknown"}" and is now ` +
      `"${canaryJob.status}"). Stop it before running the integration suite — otherwise ` +
      `it races the tests for every queued job and fails a different assertion each run. ` +
      `Note the suite runs against "${target.name}", not the database in DATABASE_URL, so ` +
      `this means something is pointed at the test database specifically.`,
  );
}

afterAll(async () => {
  await closeDb();
});
