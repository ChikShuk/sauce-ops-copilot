import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// The demo trigger is off by default in code — .env.example turns it on. The
// suite must not depend on the developer's .env either way, so both states are
// driven explicitly here.
const failureTriggerEnabled = { value: true };

vi.mock("../../src/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/env")>();
  return {
    env: {
      ...actual.env,
      get ENABLE_DEMO_FAILURE_TRIGGER() {
        return failureTriggerEnabled.value;
      },
    },
  };
});

import { db } from "../../src/lib/db/client";
import { enqueueEvent } from "../../src/lib/queue/enqueueEvent";
import { FORCE_FAIL_PREFIX } from "../../src/worker/processEvent";
import { runJob } from "../../src/worker/runJob";
import { evidenceFor, findingsFor, jobFor } from "../helpers/db";
import { newRestaurantId } from "../helpers/factories";
import { stubProvider } from "../helpers/providers";

const AT = new Date("2026-08-14T20:10:00Z");
const MAX_ATTEMPTS = 5;

async function enqueue(restaurantId: string, eventId: string): Promise<string> {
  const { id } = await enqueueEvent({
    eventId,
    restaurantId,
    orderId: null,
    eventType: "delivery_delay",
    issueClass: "delivery_delay",
    occurredAt: AT,
    payload: { delay_minutes: 50 },
  });
  return id;
}

// The real schedule is 1s/2s/4s/8s. Waiting it out would make this test 15
// seconds long for no extra coverage — the backoff arithmetic is unit-tested in
// tests/unit/backoff.test.ts — so pull next_attempt_at forward and let the claim
// query run for real.
async function makeClaimable(eventId: string): Promise<void> {
  await db.execute(sql`
    UPDATE event_jobs SET next_attempt_at = now() - interval '1 second'
    WHERE event_id = ${eventId};
  `);
}

async function drainToTerminal(eventId: string): Promise<string> {
  const workerId = `test-worker-${randomUUID().slice(0, 8)}`;

  // One more iteration than the budget, so a job that dead-letters at claim
  // time still gets its final pass.
  for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
    await makeClaimable(eventId);
    const outcome = await runJob(workerId);
    if (outcome === "dead_lettered" || outcome === "succeeded") {
      return outcome;
    }
  }

  throw new Error("job never reached a terminal disposition");
}

describe("the failed branch of the status machine", () => {
  it("dead-letters a force_fail_ event and marks its finding failed", async () => {
    failureTriggerEnabled.value = true;
    const restaurantId = newRestaurantId();
    const clientEventId = `${FORCE_FAIL_PREFIX}${randomUUID()}`;
    const eventId = await enqueue(restaurantId, clientEventId);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let outcome: string;
    try {
      outcome = await drainToTerminal(eventId);
    } finally {
      logSpy.mockRestore();
    }

    expect(outcome).toBe("dead_lettered");

    const job = await jobFor(eventId);
    expect(job?.status).toBe("dead_letter");
    expect(job?.last_error).toContain("demo failure trigger");

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.status).toBe("failed");
  });

  it("leaves the finding's evidence and priority intact — only the prose is missing", async () => {
    failureTriggerEnabled.value = true;
    const restaurantId = newRestaurantId();
    const clientEventId = `${FORCE_FAIL_PREFIX}${randomUUID()}`;
    const eventId = await enqueue(restaurantId, clientEventId);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await drainToTerminal(eventId);
    } finally {
      logSpy.mockRestore();
    }

    const finding = (await findingsFor(restaurantId))[0];
    // The throw happens after correlation commits, so the finding is real: it
    // has its evidence and its deterministic priority, and only the summary is
    // absent. That is the whole point of the deterministic/LLM split.
    expect(finding.priority).toBe("high");
    expect(finding.event_count).toBe(1);
    expect(await evidenceFor(finding.id)).toEqual([eventId]);
    expect(finding.summary).toBeNull();
  });

  it("retries before giving up rather than failing on the first attempt", async () => {
    failureTriggerEnabled.value = true;
    const restaurantId = newRestaurantId();
    const eventId = await enqueue(restaurantId, `${FORCE_FAIL_PREFIX}${randomUUID()}`);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await makeClaimable(eventId);
      const first = await runJob(`test-worker-${randomUUID().slice(0, 8)}`);
      expect(first).toBe("failed");
      expect((await jobFor(eventId))?.status).toBe("failed");

      await drainToTerminal(eventId);
    } finally {
      logSpy.mockRestore();
    }

    expect((await jobFor(eventId))?.attempts).toBe(MAX_ATTEMPTS);
  });

  it("processes the same event normally when the trigger is off", async () => {
    failureTriggerEnabled.value = false;
    const restaurantId = newRestaurantId();
    const eventId = await enqueue(restaurantId, `${FORCE_FAIL_PREFIX}${randomUUID()}`);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await makeClaimable(eventId);
      // The provider is injected because this is the *success* path: left out,
      // enrichment resolves whatever LLM_PROVIDER names, so a developer with
      // ANTHROPIC_API_KEY set turns a test about the demo trigger into a live
      // API call — which timed out under full-suite load. The tests above never
      // reach enrichment, so they need no stub.
      expect(await runJob(`test-worker-${randomUUID().slice(0, 8)}`, stubProvider())).toBe(
        "succeeded",
      );
    } finally {
      logSpy.mockRestore();
    }

    expect((await jobFor(eventId))?.status).toBe("succeeded");
    expect((await findingsFor(restaurantId))[0].status).toBe("ready");
  });

  it("is a no-op when the job dies before correlation ever committed", async () => {
    // No finding_events row exists, so there is nothing to mark failed — and
    // nothing should be invented. Uses a real event whose job is dead-lettered
    // directly, bypassing correlation entirely.
    const restaurantId = newRestaurantId();
    const eventId = await enqueue(restaurantId, `evt_${randomUUID()}`);

    await db.execute(sql`
      UPDATE event_jobs SET status = 'dead_letter', attempts = ${MAX_ATTEMPTS}
      WHERE event_id = ${eventId};
    `);

    const { markFindingFailedForEvent } = await import("../../src/lib/llm/markFindingFailed");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(markFindingFailedForEvent(eventId)).resolves.toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }

    expect(await findingsFor(restaurantId)).toHaveLength(0);
  });
});
