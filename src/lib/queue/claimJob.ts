import { sql } from "drizzle-orm";
import { PROCESSING_TIMEOUT_MS } from "../config";
import { db } from "../db/client";

export type ClaimedJob = {
  eventId: string;
  status: "processing" | "dead_letter";
  attempts: number;
  maxAttempts: number;
  // Replayed as a fencing token on the disposition writes — see
  // markSucceeded / markFailed. Null only on the dead_letter branch, which
  // has no disposition to write.
  claimToken: string | null;
};

type Row = {
  event_id: string;
  status: "processing" | "dead_letter";
  attempts: number;
  max_attempts: number;
  claim_token: string | null;
};

// One statement: pick an eligible job, take its row lock, increment
// attempts, and transition it — atomic by construction, so two workers can
// never claim the same row.
//
// Eligibility has two branches:
//  1. Time-gated retry: never-attempted ('pending') or errored-and-waiting
//     ('failed') jobs whose next_attempt_at has arrived.
//  2. Stale reclaim: a job stuck in 'processing' past PROCESSING_TIMEOUT_MS.
//     The claiming statement commits immediately rather than holding a row
//     lock across the handler call (slice 5's LLM call must not pin a DB
//     lock for its duration), so nothing else would ever free a job whose
//     worker hard-crashed mid-processing.
//
// attempts increments on every claim, including stale reclaims, so a job
// that crash-loops still burns through its retry budget. Once that budget
// is spent, this statement routes it straight to 'dead_letter' instead of
// 'processing' — the crash-loop terminator, since such a job never reaches
// markFailed to be dead-lettered the normal way.
export async function claimJob(workerId: string): Promise<ClaimedJob | null> {
  const result = await db.execute<Row>(sql`
    WITH candidate AS (
      SELECT event_id
      FROM event_jobs
      WHERE
        (status IN ('pending', 'failed') AND next_attempt_at <= now())
        OR (status = 'processing'
            AND claimed_at < now() - make_interval(secs => ${PROCESSING_TIMEOUT_MS / 1000}))
      ORDER BY next_attempt_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE event_jobs AS j
    SET
      attempts = j.attempts + 1,
      status = CASE WHEN j.attempts + 1 > j.max_attempts THEN 'dead_letter' ELSE 'processing' END,
      claimed_at = CASE WHEN j.attempts + 1 > j.max_attempts THEN j.claimed_at ELSE now() END,
      claimed_by = CASE WHEN j.attempts + 1 > j.max_attempts THEN j.claimed_by ELSE ${workerId} END,
      -- New token per claim: this is what invalidates a previous claimant's
      -- pending disposition write.
      claim_token = CASE WHEN j.attempts + 1 > j.max_attempts THEN j.claim_token ELSE gen_random_uuid() END,
      -- A crash-looped job never reaches markFailed, so without this it
      -- would land in the DLQ carrying a stale error from an earlier
      -- attempt, or NULL if it crashed on attempt one. An undiagnosable
      -- dead letter only half-answers "handle permanently failed messages".
      last_error = CASE WHEN j.attempts + 1 > j.max_attempts
        THEN 'dead-lettered at claim: exceeded max_attempts (' || j.max_attempts
             || ') after repeated processing timeouts; last claimed by '
             || COALESCE(j.claimed_by, 'unknown')
        ELSE j.last_error END
    FROM candidate
    WHERE j.event_id = candidate.event_id
    RETURNING j.event_id, j.status, j.attempts, j.max_attempts, j.claim_token;
  `);

  const [row] = result;
  if (!row) return null;

  return {
    eventId: row.event_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimToken: row.claim_token,
  };
}
