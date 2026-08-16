import { sql } from "drizzle-orm";
import { PROCESSING_TIMEOUT_MS } from "../config";
import { db } from "../db/client";
import { logJson } from "../log";
import { computeNextAttemptAt } from "./backoff";

/**
 * The second queue: "rewrite this finding's prose", requested from the UI.
 *
 * Same machinery as event_jobs — SKIP LOCKED claim, attempts incremented at
 * claim time, claim_token fencing on the disposition, the same backoff ladder —
 * against a different table, for the reason spelled out on `enrichmentJobs` in
 * schema.ts: the two queues diverge on what a dead letter *means*, and that is
 * a semantic difference rather than a schema convenience.
 *
 * The SQL is written out rather than generalised with claimJob's. There are two
 * implementations now, which under CLAUDE.md's rule is the moment to consider an
 * abstraction rather than the moment to have already built one — and the shared
 * shape is already factored out where it can be (computeNextAttemptAt,
 * PROCESSING_TIMEOUT_MS). A third queue would settle it.
 */
export type ClaimedEnrichmentJob = {
  id: string;
  findingId: string;
  requestedVersion: number;
  status: "processing" | "dead_letter";
  attempts: number;
  maxAttempts: number;
  claimToken: string | null;
};

type Row = {
  id: string;
  finding_id: string;
  requested_version: number;
  status: "processing" | "dead_letter";
  attempts: number;
  max_attempts: number;
  claim_token: string | null;
};

export type EnqueueResult = {
  jobId: string;
  /** False when an outstanding job already covered this finding. */
  created: boolean;
};

/**
 * Request a rewrite, or return the request already in flight.
 *
 * ON CONFLICT against the partial unique index means a double click cannot queue
 * two rewrites of one finding — the database enforces it, so the button does not
 * have to, and neither does a check-then-insert race.
 */
export async function enqueueReenrichment(
  findingId: string,
  requestedVersion: number,
): Promise<EnqueueResult> {
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO enrichment_jobs (finding_id, requested_version)
    VALUES (${findingId}, ${requestedVersion})
    ON CONFLICT DO NOTHING
    RETURNING id;
  `);

  if (inserted.length > 0) {
    logJson({
      msg: "enrichment_job.enqueued",
      finding_id: findingId,
      job_id: inserted[0].id,
      requested_version: requestedVersion,
    });
    return { jobId: inserted[0].id, created: true };
  }

  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM enrichment_jobs
    WHERE finding_id = ${findingId}
      AND status IN ('pending', 'processing', 'failed');
  `);

  // The conflicting row can be gone by now — the worker may have finished it
  // between the INSERT and this SELECT. Retrying the insert would be a loop with
  // no guaranteed exit; reporting "already queued" is honest enough for a demo
  // control, and the next click gets a fresh row.
  const jobId = existing[0]?.id ?? null;
  logJson({ msg: "enrichment_job.already_queued", finding_id: findingId, job_id: jobId });

  return { jobId: jobId ?? "", created: false };
}

// Mirrors claimJob exactly, including the dead-letter-at-claim branch that
// terminates a crash loop. See the comments there for why each piece exists.
export async function claimEnrichmentJob(
  workerId: string,
): Promise<ClaimedEnrichmentJob | null> {
  const result = await db.execute<Row>(sql`
    WITH candidate AS (
      SELECT id
      FROM enrichment_jobs
      WHERE
        (status IN ('pending', 'failed') AND next_attempt_at <= now())
        OR (status = 'processing'
            AND claimed_at < now() - make_interval(secs => ${PROCESSING_TIMEOUT_MS / 1000}))
      ORDER BY next_attempt_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE enrichment_jobs AS j
    SET
      attempts = j.attempts + 1,
      status = CASE WHEN j.attempts + 1 > j.max_attempts THEN 'dead_letter' ELSE 'processing' END,
      claimed_at = CASE WHEN j.attempts + 1 > j.max_attempts THEN j.claimed_at ELSE now() END,
      claimed_by = CASE WHEN j.attempts + 1 > j.max_attempts THEN j.claimed_by ELSE ${workerId} END,
      claim_token = CASE WHEN j.attempts + 1 > j.max_attempts THEN j.claim_token ELSE gen_random_uuid() END,
      last_error = CASE WHEN j.attempts + 1 > j.max_attempts
        THEN 'dead-lettered at claim: exceeded max_attempts (' || j.max_attempts
             || ') after repeated processing timeouts; last claimed by '
             || COALESCE(j.claimed_by, 'unknown')
        ELSE j.last_error END
    FROM candidate
    WHERE j.id = candidate.id
    RETURNING j.id, j.finding_id, j.requested_version, j.status, j.attempts,
              j.max_attempts, j.claim_token;
  `);

  const [row] = result;
  if (!row) return null;

  return {
    id: row.id,
    findingId: row.finding_id,
    requestedVersion: row.requested_version,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimToken: row.claim_token,
  };
}

export async function markEnrichmentJobSucceeded(job: ClaimedEnrichmentJob): Promise<void> {
  const result = await db.execute(sql`
    UPDATE enrichment_jobs
    SET status = 'succeeded'
    WHERE id = ${job.id}
      AND status = 'processing'
      AND claim_token = ${job.claimToken}
    RETURNING id;
  `);

  if (result.length === 0) {
    logJson({
      msg: "enrichment_job.disposition_superseded",
      disposition: "succeeded",
      job_id: job.id,
      finding_id: job.findingId,
    });
  }
}

export async function markEnrichmentJobFailed(
  job: ClaimedEnrichmentJob,
  err: unknown,
): Promise<"failed" | "dead_letter" | null> {
  const message = err instanceof Error ? err.message : String(err);
  const nextAttemptAt = computeNextAttemptAt(job.attempts);

  const result = await db.execute<{ id: string; status: string }>(sql`
    UPDATE enrichment_jobs
    SET
      status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
      next_attempt_at = CASE WHEN attempts >= max_attempts
        THEN next_attempt_at
        ELSE ${nextAttemptAt.toISOString()} END,
      last_error = ${message}
    WHERE id = ${job.id}
      AND status = 'processing'
      AND claim_token = ${job.claimToken}
    RETURNING id, status;
  `);

  if (result.length === 0) {
    logJson({
      msg: "enrichment_job.disposition_superseded",
      disposition: "failed",
      job_id: job.id,
      finding_id: job.findingId,
    });
    return null;
  }

  return result[0].status as "failed" | "dead_letter";
}
