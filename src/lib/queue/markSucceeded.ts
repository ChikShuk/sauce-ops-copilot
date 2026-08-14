import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { logJson } from "../log";
import type { ClaimedJob } from "./claimJob";

// Fenced on claim_token. No row lock is held during processing, so a worker
// that stalls past PROCESSING_TIMEOUT_MS without actually dying can have its
// job reclaimed by another worker, then finish and try to write its own
// disposition — clobbering the new claim. Matching on the token this worker
// was handed means a superseded worker updates zero rows instead.
export async function markSucceeded(job: ClaimedJob): Promise<void> {
  const result = await db.execute(sql`
    UPDATE event_jobs
    SET status = 'succeeded'
    WHERE event_id = ${job.eventId}
      AND status = 'processing'
      AND claim_token = ${job.claimToken}
    RETURNING event_id;
  `);

  if (result.length === 0) {
    logJson({
      msg: "job.disposition_superseded",
      disposition: "succeeded",
      event_id: job.eventId,
      claim_token: job.claimToken,
    });
  }
}
