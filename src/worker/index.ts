import "dotenv/config";
import { randomUUID } from "node:crypto";
import { POLL_INTERVAL_MS } from "../lib/config";
import { logJson } from "../lib/log";
import { createSleeper } from "../lib/sleep";
import { runJob } from "./runJob";

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
      // runJob owns claim-to-disposition, including its own retry/DLQ routing.
      // Anything that escapes it is a loop-machinery fault, not a job failure.
      const outcome = await runJob(workerId);

      // Only sleep when there was nothing to do — after any real disposition,
      // re-poll immediately and drain the backlog.
      if (outcome === "idle") {
        await sleeper.sleep(POLL_INTERVAL_MS);
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
