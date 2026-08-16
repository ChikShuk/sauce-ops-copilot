import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const environment = { toggleEnabled: true };

vi.mock("../../src/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/env")>();
  return {
    env: {
      ...actual.env,
      get ENABLE_PROVIDER_TOGGLE() {
        return environment.toggleEnabled;
      },
    },
  };
});

import { POST as reenrich } from "../../src/app/api/findings/[findingId]/reenrich/route";
import { db } from "../../src/lib/db/client";
import { enqueueEvent } from "../../src/lib/queue/enqueueEvent";
import { processEvent } from "../../src/worker/processEvent";
import { runJob } from "../../src/worker/runJob";
import { eventRowById as eventRow, evidenceFor, findingsFor, resetDb } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";
import { stubProvider } from "../helpers/providers";

const AT = new Date("2026-08-14T20:10:00Z");

// Unusually for this suite, these tests cannot isolate on restaurant_id alone:
// runJob claims the oldest eligible row in either queue regardless of who
// queued it, so an event job left pending by an earlier file would be claimed
// here and every drain-order assertion would be about someone else's work.
beforeEach(async () => {
  await resetDb();
});

type JobRow = {
  id: string;
  status: string;
  attempts: number;
  requested_version: number;
  last_error: string | null;
};

async function request(findingId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await reenrich(
    new Request(`http://test.local/api/findings/${findingId}/reenrich`, { method: "POST" }),
    { params: Promise.resolve({ findingId }) },
  );
  return { status: res.status, body: await res.json() };
}

async function jobsFor(findingId: string): Promise<JobRow[]> {
  return db.execute<JobRow>(sql`
    SELECT id, status, attempts, requested_version, last_error
    FROM enrichment_jobs WHERE finding_id = ${findingId}
    ORDER BY created_at ASC;
  `);
}

// A finding with prose already on it, which is the only state a rewrite is ever
// requested from.
async function seedEnrichedFinding(): Promise<{ restaurantId: string; findingId: string }> {
  const restaurantId = newRestaurantId();
  const event = await seedEvent({ restaurantId, occurredAt: AT, payload: { delay_minutes: 95 } });

  await processEvent(await eventRow(event.id), stubProvider());

  const finding = (await findingsFor(restaurantId))[0];
  return { restaurantId, findingId: finding.id };
}

describe("POST /api/findings/:id/reenrich", () => {
  it("queues the work and returns before anything is written", async () => {
    const { findingId } = await seedEnrichedFinding();

    const res = await request(findingId);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");

    const jobs = await jobsFor(findingId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("pending");
  });

  // The partial unique index is the guarantee, not the button's disabled state:
  // two browsers, or one impatient click, must not queue two rewrites.
  it("returns the outstanding request rather than queuing a second", async () => {
    const { findingId } = await seedEnrichedFinding();

    const first = await request(findingId);
    const second = await request(findingId);

    expect(second.status).toBe(202);
    expect(second.body.status).toBe("already_queued");
    expect(second.body.job_id).toBe(first.body.job_id);
    expect(await jobsFor(findingId)).toHaveLength(1);
  });

  it("404s for a finding that does not exist", async () => {
    const res = await request("00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });

  it("does not exist when the demo flag is off", async () => {
    const { findingId } = await seedEnrichedFinding();
    environment.toggleEnabled = false;

    const res = await request(findingId);

    expect(res.status).toBe(404);
    expect(await jobsFor(findingId)).toHaveLength(0);
    environment.toggleEnabled = true;
  });
});

describe("the worker drains the rewrite queue", () => {
  it("rewrites the prose and leaves every deterministic field untouched", async () => {
    const { restaurantId, findingId } = await seedEnrichedFinding();
    const before = (await findingsFor(restaurantId))[0];
    const evidenceBefore = await evidenceFor(findingId);

    await request(findingId);

    const outcome = await runJob(
      "test-worker",
      stubProvider({ issue: "Rewritten issue", summary: "Rewritten summary." }),
    );

    expect(outcome).toBe("succeeded");

    const after = (await findingsFor(restaurantId))[0];
    expect(after.summary).toBe("Rewritten summary.");
    expect(after.issue).toBe("Rewritten issue");
    expect(after.status).toBe("ready");

    // The whole point of the control: only the prose moved.
    expect(after.version).toBe(before.version);
    expect(after.priority).toBe(before.priority);
    expect(after.event_count).toBe(before.event_count);
    expect(after.priority_drivers).toEqual(before.priority_drivers);
    expect(await evidenceFor(findingId)).toEqual(evidenceBefore);

    const jobs = await jobsFor(findingId);
    expect(jobs[0].status).toBe("succeeded");
  });

  // Fairness, not an implementation detail: a rewrite is a demo control and an
  // event is the product, so the event queue is always drained first.
  it("claims event jobs before rewrites", async () => {
    const { restaurantId, findingId } = await seedEnrichedFinding();
    await request(findingId);

    // A second event for the same restaurant, queued after the rewrite was.
    const pending = await enqueueEvent({
      eventId: `evt_${Date.now()}`,
      restaurantId,
      orderId: null,
      eventType: "negative_review",
      issueClass: "negative_review",
      occurredAt: new Date(AT.getTime() + 60_000),
      payload: { rating: 2 },
    });

    await runJob("test-worker", stubProvider());

    // The event job went first, so it is the one that is no longer claimable.
    const [eventJob] = await db.execute<{ status: string }>(sql`
      SELECT status FROM event_jobs WHERE event_id = ${pending.id};
    `);
    expect(eventJob.status).toBe("succeeded");
    expect((await jobsFor(findingId))[0].status).toBe("pending");
  });

  it("reports idle only when both queues are empty", async () => {
    expect(await runJob("test-worker", stubProvider())).toBe("idle");
  });
});

describe("a failed rewrite is not a failed finding", () => {
  // The divergence that earned this its own table. An event job that
  // dead-letters marks its finding failed — evidence it absorbed never reached
  // prose. A rewrite that dead-letters changes nothing about the finding: the
  // prose already there still describes its evidence.
  it("dead-letters without marking the finding failed", async () => {
    const { restaurantId, findingId } = await seedEnrichedFinding();
    const before = (await findingsFor(restaurantId))[0];

    await request(findingId);

    // Spend the retry budget so the next claim routes straight to the DLQ,
    // exercising the same crash-loop terminator event jobs have.
    await db.execute(sql`
      UPDATE enrichment_jobs SET attempts = max_attempts WHERE finding_id = ${findingId};
    `);

    const outcome = await runJob("test-worker", stubProvider());
    expect(outcome).toBe("dead_lettered");

    const after = (await findingsFor(restaurantId))[0];
    expect(after.status).toBe("ready");
    expect(after.summary).toBe(before.summary);

    const jobs = await jobsFor(findingId);
    expect(jobs[0].status).toBe("dead_letter");
    expect(jobs[0].last_error).toContain("exceeded max_attempts");
  });

  // enrichFinding claims by setting status='processing'. A rewrite that dies
  // after that claim would otherwise leave a finding analyzing forever, with no
  // event job holding it and nothing to reclaim it.
  it("settles a finding left in processing back to ready", async () => {
    const { restaurantId, findingId } = await seedEnrichedFinding();

    await request(findingId);
    await db.execute(sql`
      UPDATE enrichment_jobs SET attempts = max_attempts WHERE finding_id = ${findingId};
    `);
    await db.execute(sql`UPDATE findings SET status = 'processing' WHERE id = ${findingId};`);

    await runJob("test-worker", stubProvider());

    const after = (await findingsFor(restaurantId))[0];
    expect(after.status).toBe("ready");
  });
});
