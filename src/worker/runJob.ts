import { eq } from "drizzle-orm";
import { db } from "../lib/db/client";
import { events } from "../lib/db/schema";
import { markFindingFailedForEvent } from "../lib/llm/markFindingFailed";
import type { EnrichmentProvider } from "../lib/llm/types";
import { logJson } from "../lib/log";
import { claimJob } from "../lib/queue/claimJob";
import { markFailed } from "../lib/queue/markFailed";
import { markSucceeded } from "../lib/queue/markSucceeded";
import { processEvent } from "./processEvent";

export type RunJobOutcome = "idle" | "succeeded" | "failed" | "dead_lettered";

// One iteration of the worker loop, extracted so the failure path can be tested
// as it actually ships rather than re-implemented in a test. index.ts owns the
// looping, sleeping, and shutdown; this owns claim-to-disposition.
export async function runJob(
  workerId: string,
  provider?: EnrichmentProvider,
): Promise<RunJobOutcome> {
  const claimed = await claimJob(workerId);

  if (!claimed) {
    return "idle";
  }

  // Claiming pushed a crash-looped job past its retry budget. Skip the handler
  // entirely, and don't sleep — drain any further backlog now.
  if (claimed.status === "dead_letter") {
    logJson({
      msg: "job.dead_lettered_at_claim",
      event_id: claimed.eventId,
      attempts: claimed.attempts,
      max_attempts: claimed.maxAttempts,
      worker_id: workerId,
    });
    // A finding that already absorbed this event will never get its prose.
    // Say so rather than leaving it looking complete.
    await markFindingFailedForEvent(claimed.eventId);
    return "dead_lettered";
  }

  logJson({
    msg: "job.claimed",
    event_id: claimed.eventId,
    attempts: claimed.attempts,
    worker_id: workerId,
  });

  try {
    const [event] = await db.select().from(events).where(eq(events.id, claimed.eventId));
    if (!event) {
      throw new Error(`event ${claimed.eventId} not found for its job row`);
    }

    await processEvent(event, provider);
    await markSucceeded(claimed);

    logJson({ msg: "job.succeeded", event_id: claimed.eventId, worker_id: workerId });
    return "succeeded";
  } catch (err) {
    // The expected failure path: the job itself errored. Route it to the
    // retry/DLQ machinery rather than letting it escape to the caller, whose
    // catch is for loop-machinery faults only.
    const disposition = await markFailed(claimed, err);

    logJson({
      msg: "job.failed",
      event_id: claimed.eventId,
      attempts: claimed.attempts,
      disposition,
      error: err instanceof Error ? err.message : String(err),
      worker_id: workerId,
    });

    // Retry budget spent. The event is terminal, so any finding it attached to
    // is stale — this is the only path to findings.status = 'failed'.
    if (disposition === "dead_letter") {
      await markFindingFailedForEvent(claimed.eventId);
      return "dead_lettered";
    }

    return "failed";
  }
}
