import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { logJson } from "../log";
import { computeNextAttemptAt } from "./backoff";
import type { ClaimedJob } from "./claimJob";

// Retries left -> 'failed' with next_attempt_at pushed out by the backoff
// schedule; budget spent -> 'dead_letter', and next_attempt_at stops moving
// so the row is plainly terminal rather than merely scheduled far out.
//
// Same claim_token fencing as markSucceeded — see the comment there.
export async function markFailed(job: ClaimedJob, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const nextAttemptAt = computeNextAttemptAt(job.attempts);

  const result = await db.execute<{ event_id: string; status: string }>(sql`
    UPDATE event_jobs
    SET
      status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
      next_attempt_at = CASE WHEN attempts >= max_attempts
        THEN next_attempt_at
        ELSE ${nextAttemptAt.toISOString()} END,
      last_error = ${message}
    WHERE event_id = ${job.eventId}
      AND status = 'processing'
      AND claim_token = ${job.claimToken}
    RETURNING event_id, status;
  `);

  if (result.length === 0) {
    logJson({
      msg: "job.disposition_superseded",
      disposition: "failed",
      event_id: job.eventId,
      claim_token: job.claimToken,
    });
  }
}
