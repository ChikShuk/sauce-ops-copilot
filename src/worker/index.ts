import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { POLL_INTERVAL_MS } from "../lib/config";
import { db } from "../lib/db/client";
import { events } from "../lib/db/schema";
import { logJson } from "../lib/log";
import { createSleeper } from "../lib/sleep";
import { claimJob } from "../lib/queue/claimJob";
import { markFailed } from "../lib/queue/markFailed";
import { markSucceeded } from "../lib/queue/markSucceeded";
import { processEvent } from "./processEvent";

let shuttingDown = false;
const sleeper = createSleeper();

function requestShutdown(signal: string): void {
  shuttingDown = true;
  logJson({ msg: "worker.shutdown_requested", signal });
  // Cut short an in-flight poll sleep so an idle worker exits promptly
  // instead of waiting out the interval.
  sleeper.wake();
}

async function main(): Promise<void> {
  const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

  logJson({ msg: "worker.started", worker_id: workerId });

  while (!shuttingDown) {
    try {
      const claimed = await claimJob(workerId);

      if (!claimed) {
        await sleeper.sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Claiming pushed a crash-looped job past its retry budget. Skip the
      // handler entirely, and don't sleep — drain any further backlog now.
      if (claimed.status === "dead_letter") {
        logJson({
          msg: "job.dead_lettered_at_claim",
          event_id: claimed.eventId,
          attempts: claimed.attempts,
          max_attempts: claimed.maxAttempts,
          worker_id: workerId,
        });
        continue;
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

        await processEvent(event);
        await markSucceeded(claimed);

        logJson({ msg: "job.succeeded", event_id: claimed.eventId, worker_id: workerId });
      } catch (err) {
        // The expected failure path: the job itself errored. Route it to the
        // retry/DLQ machinery rather than letting it escape to the outer
        // catch, which is for loop-machinery faults only.
        await markFailed(claimed, err);
        logJson({
          msg: "job.failed",
          event_id: claimed.eventId,
          attempts: claimed.attempts,
          error: err instanceof Error ? err.message : String(err),
          worker_id: workerId,
        });
      }
    } catch (loopErr) {
      // A transient fault in the loop machinery itself (e.g. the DB blipping
      // between polls). Never let one bad iteration kill the process, and
      // never conflate it with a job failure — no event_jobs row is touched.
      logJson({
        msg: "worker.iteration_error",
        error: loopErr instanceof Error ? loopErr.message : String(loopErr),
        worker_id: workerId,
      });
      await sleeper.sleep(POLL_INTERVAL_MS);
    }
  }

  logJson({ msg: "worker.stopped", worker_id: workerId });
  process.exit(0);
}

main().catch((err) => {
  logJson({
    msg: "worker.fatal",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
