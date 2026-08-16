import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db/client";
import { runJob, type RunJobOutcome } from "../../src/worker/runJob";
import { evidenceFor, findingsFor, jobFor, resetDb } from "../helpers/db";
import { newRestaurantId, postEvent } from "../helpers/factories";
import { stubProvider } from "../helpers/providers";

/**
 * "Submit the same event five times."
 *
 * Every half of this was already proven somewhere: redelivery leaves a finding
 * untouched (correlation.idempotency), a no-op re-enrichment spends no LLM call
 * (enrichment), and the unique constraint exists (schema). What did not exist
 * was a single test that submits the same event five times through the endpoint
 * an operator's browser actually calls and asserts the whole consequence at
 * once — one event, one job, one finding, one piece of evidence, one LLM call.
 * Three proofs at three entry points do not add up to that one.
 */

// Relative to now, not a fixed date: ingestEventSchema bounds occurred_at
// against Date.now(), so a hardcoded timestamp turns into a validation failure
// the day after it was written.
function eventBody(eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    event_type: "delivery_delay",
    order_id: "order_5001",
    occurred_at: new Date(Date.now() - 60_000).toISOString(),
    payload: { delay_minutes: 40 },
  };
}

async function countIn(table: "events" | "event_jobs", restaurantId: string): Promise<number> {
  const rows =
    table === "events"
      ? await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM events WHERE restaurant_id = ${restaurantId};
        `)
      : await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM event_jobs j
          JOIN events e ON e.id = j.event_id
          WHERE e.restaurant_id = ${restaurantId};
        `);
  return rows[0].n;
}

async function drain(provider: ReturnType<typeof stubProvider>): Promise<RunJobOutcome[]> {
  const workerId = `test-worker-${randomUUID().slice(0, 8)}`;
  const outcomes: RunJobOutcome[] = [];

  // Bounded: an unbounded loop against a bug that re-queues work would hang
  // rather than fail.
  for (let i = 0; i < 10; i += 1) {
    const outcome = await runJob(workerId, provider);
    outcomes.push(outcome);
    if (outcome === "idle") return outcomes;
  }

  throw new Error(`worker never went idle: ${outcomes.join(", ")}`);
}

beforeEach(async () => {
  await resetDb();
});

describe("submitting the same event five times", () => {
  it("accepts every copy but creates the work exactly once", async () => {
    const restaurantId = newRestaurantId();
    const body = eventBody(`evt_${randomUUID()}`);

    const responses = [];
    for (let i = 0; i < 5; i += 1) {
      responses.push(await postEvent(restaurantId, body));
    }

    // The status codes matter as much as the row count. A dedup that rejected
    // all five submissions with a 500 would also leave exactly one row behind,
    // and a count-only assertion could not tell the two apart.
    expect(responses[0].status).toBe(201);
    expect(responses[0].body.duplicate).toBe(false);

    for (const response of responses.slice(1)) {
      expect(response.status).toBe(200);
      expect(response.body.duplicate).toBe(true);
      expect(response.body.status).toBe("accepted");
    }

    // Same durable row every time — the duplicate responses are not merely
    // "not an error", they point the caller at the event that already exists.
    const ids = new Set(responses.map((response) => response.body.id));
    expect(ids.size).toBe(1);

    expect(await countIn("events", restaurantId)).toBe(1);
    expect(await countIn("event_jobs", restaurantId)).toBe(1);

    // Four redundant submissions did not touch the job the first one queued.
    const eventId = responses[0].body.id;
    if (eventId === undefined) throw new Error("ingestion returned no id");
    const job = await jobFor(eventId);
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
  });

  it("spends one LLM call and produces one finding with one piece of evidence", async () => {
    const restaurantId = newRestaurantId();
    const body = eventBody(`evt_${randomUUID()}`);

    for (let i = 0; i < 5; i += 1) {
      await postEvent(restaurantId, body);
    }

    const provider = stubProvider();
    const outcomes = await drain(provider);

    // Exactly one unit of work existed to be done.
    expect(outcomes.filter((outcome) => outcome === "succeeded")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "failed")).toHaveLength(0);
    expect(outcomes.filter((outcome) => outcome === "dead_lettered")).toHaveLength(0);

    // Asserted against runJob rather than processEvent: the call count only
    // means something on the path the worker actually takes.
    expect(provider.calls).toHaveLength(1);

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(1);
    expect(findings[0].event_count).toBe(1);
    expect(findings[0].status).toBe("ready");
    expect(await evidenceFor(findings[0].id)).toHaveLength(1);
  });

  it("treats the same event_id at a different restaurant as a different event", async () => {
    // The unique constraint is on (restaurant_id, event_id). If it were on
    // event_id alone, one tenant's ids would silently suppress another's — and
    // the dedup tests above would still pass.
    const eventId = `evt_${randomUUID()}`;
    const first = newRestaurantId();
    const second = newRestaurantId();

    const a = await postEvent(first, eventBody(eventId));
    const b = await postEvent(second, eventBody(eventId));

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.duplicate).toBe(false);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it("rejects a malformed body without queuing anything", async () => {
    const restaurantId = newRestaurantId();

    const response = await postEvent(restaurantId, {
      event_id: `evt_${randomUUID()}`,
      event_type: "delivery_delay",
      occurred_at: new Date().toISOString(),
      payload: { delay_minutes: -5 },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("validation_error");
    expect(await countIn("events", restaurantId)).toBe(0);
    expect(await countIn("event_jobs", restaurantId)).toBe(0);
  });
});
