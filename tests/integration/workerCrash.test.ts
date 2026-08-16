import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROCESSING_TIMEOUT_MS } from "../../src/lib/config";
import { claimJob, type ClaimedJob } from "../../src/lib/queue/claimJob";
import { markFailed } from "../../src/lib/queue/markFailed";
import { markSucceeded } from "../../src/lib/queue/markSucceeded";
import { processEvent } from "../../src/worker/processEvent";
import { runJob } from "../../src/worker/runJob";
import {
  backdateClaim,
  eventRowById,
  findingsFor,
  jobFor,
  resetDb,
} from "../helpers/db";
import { newRestaurantId, postEvent } from "../helpers/factories";
import { stubProvider } from "../helpers/providers";

/**
 * "Kill the worker mid-processing and restart it."
 *
 * A SIGKILLed worker leaves one thing behind in the database: a row in
 * 'processing' whose claim will never receive a disposition. That is what these
 * tests produce — a real claimJob claim, then nothing — so the reclaim runs
 * against exactly the state a killed process leaves, with none of the flakiness
 * of spawning and killing a process on a machine that also has to be a CI box.
 * The real kill is scripted as a drill in the README's failure-tests section.
 *
 * Nothing here is stubbed: claimJob, markSucceeded and markFailed all execute
 * their production SQL.
 */

const worker = (): string => `worker-${randomUUID().slice(0, 8)}`;

async function enqueue(restaurantId: string): Promise<string> {
  const response = await postEvent(restaurantId, {
    event_id: `evt_${randomUUID()}`,
    event_type: "delivery_delay",
    order_id: "order_5001",
    occurred_at: new Date(Date.now() - 60_000).toISOString(),
    payload: { delay_minutes: 40 },
  });

  const id = response.body.id;
  if (id === undefined) throw new Error(`ingestion failed: ${JSON.stringify(response.body)}`);
  return id;
}

// A worker that claimed the job and died before writing a disposition.
async function claimAndDie(eventId: string, workerId: string): Promise<ClaimedJob> {
  const claimed = await claimJob(workerId);
  if (!claimed) throw new Error("expected a claimable job");
  if (claimed.eventId !== eventId) throw new Error("claimed someone else's job");
  return claimed;
}

beforeEach(async () => {
  await resetDb();
});

describe("a worker killed mid-processing", () => {
  it("does not release its job before the processing timeout has passed", async () => {
    const eventId = await enqueue(newRestaurantId());
    const dead = await claimAndDie(eventId, worker());
    expect(dead.status).toBe("processing");

    // The negative control, and the reason the rest of this file means
    // anything. Without it, a claimJob that ignored claimed_at entirely — one
    // that handed every in-flight job to the next worker that asked — would
    // pass every other assertion here. A backdate would prove nothing if no
    // backdate were required.
    expect(await claimJob(worker())).toBeNull();

    const job = await jobFor(eventId);
    expect(job?.status).toBe("processing");
    expect(job?.attempts).toBe(1);
  });

  it("is reclaimed by another worker once the claim goes stale", async () => {
    const eventId = await enqueue(newRestaurantId());
    const dead = await claimAndDie(eventId, worker());

    await backdateClaim(eventId, PROCESSING_TIMEOUT_MS + 1_000);

    const reviver = worker();
    const reclaimed = await claimJob(reviver);

    expect(reclaimed?.eventId).toBe(eventId);
    expect(reclaimed?.status).toBe("processing");
    // The reclaim burns a retry: a job that crash-loops must not be able to
    // occupy a worker forever.
    expect(reclaimed?.attempts).toBe(dead.attempts + 1);
    // A fresh token is what invalidates the dead worker's pending write.
    expect(reclaimed?.claimToken).not.toBe(dead.claimToken);

    const job = await jobFor(eventId);
    expect(job?.claimed_by).toBe(reviver);
  });

  it("cannot have its disposition land after another worker has taken over", async () => {
    const eventId = await enqueue(newRestaurantId());
    const dead = await claimAndDie(eventId, worker());

    await backdateClaim(eventId, PROCESSING_TIMEOUT_MS + 1_000);
    const reviver = worker();
    const reclaimed = await claimJob(reviver);
    expect(reclaimed).not.toBeNull();

    // The stalled worker was never actually dead — it comes back and tries to
    // write the result of work whose job now belongs to someone else.
    // Collected inside the implementation rather than read from mock.calls
    // afterwards: mockRestore clears the recorded calls, so a later read finds
    // an empty array and the assertion fails for a reason that has nothing to
    // do with the code under test.
    const lines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));

    let failedDisposition: string | null;
    try {
      await markSucceeded(dead);
      failedDisposition = await markFailed(dead, new Error("late failure"));
    } finally {
      logSpy.mockRestore();
    }

    expect(failedDisposition).toBeNull();

    // Asserting on the log, not just the row: a fence that silently updated
    // zero rows for the wrong reason — a typo'd column, a status that no longer
    // matches — would leave the row looking identical.
    const superseded = lines.filter((line) => line.includes("job.disposition_superseded"));
    expect(superseded).toHaveLength(2);
    expect(superseded.some((line) => line.includes(`"disposition":"succeeded"`))).toBe(true);
    expect(superseded.some((line) => line.includes(`"disposition":"failed"`))).toBe(true);

    const job = await jobFor(eventId);
    expect(job?.status).toBe("processing");
    expect(job?.claimed_by).toBe(reviver);
    expect(job?.claim_token).toBe(reclaimed?.claimToken);
    expect(job?.last_error).toBeNull();
  });

  it("has its job finished by the worker that restarts", async () => {
    const restaurantId = newRestaurantId();
    const eventId = await enqueue(restaurantId);
    await claimAndDie(eventId, worker());

    await backdateClaim(eventId, PROCESSING_TIMEOUT_MS + 1_000);

    // The restart: a full worker iteration, claim through disposition.
    const provider = stubProvider();
    const outcome = await runJob(worker(), provider);

    expect(outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);

    const job = await jobFor(eventId);
    expect(job?.status).toBe("succeeded");
    expect(job?.attempts).toBe(2);

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("ready");
    expect(findings[0].event_count).toBe(1);
  });

  it("dead-letters at claim rather than crash-looping forever", async () => {
    const restaurantId = newRestaurantId();
    const eventId = await enqueue(restaurantId);

    // First pass gets as far as correlation before the worker dies, so a
    // finding exists to be invalidated when the job finally gives up.
    const first = worker();
    await claimAndDie(eventId, first);
    await processEvent(await eventRowById(eventId), stubProvider());
    expect((await findingsFor(restaurantId))[0].status).toBe("ready");

    // Attempts 2 through 5: reclaimed and killed again each time.
    for (let i = 0; i < 4; i += 1) {
      await backdateClaim(eventId, PROCESSING_TIMEOUT_MS + 1_000);
      const reclaimed = await claimJob(worker());
      expect(reclaimed?.status).toBe("processing");
      expect(reclaimed?.attempts).toBe(i + 2);
    }

    await backdateClaim(eventId, PROCESSING_TIMEOUT_MS + 1_000);

    const provider = stubProvider();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let outcome: string;
    try {
      outcome = await runJob(worker(), provider);
    } finally {
      logSpy.mockRestore();
    }

    expect(outcome).toBe("dead_lettered");
    // The handler never ran on the final pass: a job past its budget is not
    // worth an LLM call.
    expect(provider.calls).toHaveLength(0);

    const job = await jobFor(eventId);
    expect(job?.status).toBe("dead_letter");
    expect(job?.attempts).toBe(6);
    // A crash-looper never reaches markFailed, so without the claim-time error
    // string this row would arrive in the DLQ with last_error still null —
    // a dead letter nobody can diagnose.
    expect(job?.last_error).toContain("dead-lettered at claim");
    expect(job?.last_error).toContain(String(job?.max_attempts));

    // The finding absorbed this event and will now never get its prose. Saying
    // so is the difference between a stale card and a card that looks complete.
    expect((await findingsFor(restaurantId))[0].status).toBe("failed");
  });

  it("gives a crash-looping job one more claim than a job that fails cleanly", async () => {
    // claimJob dead-letters at attempts + 1 > max_attempts; markFailed does it
    // at attempts >= max_attempts. The asymmetry is real and deliberate — a
    // clean failure has already used its attempt by the time markFailed runs,
    // while a reclaim is discovering the previous attempt is gone — but it was
    // documented only in a comment.
    const eventId = await enqueue(newRestaurantId());

    for (let i = 0; i < 5; i += 1) {
      if (i > 0) await backdateClaim(eventId, PROCESSING_TIMEOUT_MS + 1_000);
      const claimed = await claimJob(worker());
      expect(claimed?.status).toBe("processing");
    }

    const job = await jobFor(eventId);
    expect(job?.attempts).toBe(5);
    expect(job?.max_attempts).toBe(5);
    // Five claims spent, still not terminal — the sixth is the one that ends it.
    expect(job?.status).toBe("processing");

    await backdateClaim(eventId, PROCESSING_TIMEOUT_MS + 1_000);
    const terminal = await claimJob(worker());
    expect(terminal?.status).toBe("dead_letter");
    expect(terminal?.attempts).toBe(6);
    expect((await jobFor(eventId))?.status).toBe("dead_letter");
  });
});
