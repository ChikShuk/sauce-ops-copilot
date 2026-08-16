import { sql } from "drizzle-orm";
import { db } from "../lib/db/client";
import { enrichFinding } from "../lib/llm/enrichFinding";
import { readEnrichmentTarget } from "../lib/llm/staleEnrichment";
import type { EnrichmentProvider } from "../lib/llm/types";
import { logJson } from "../lib/log";
import {
  claimEnrichmentJob,
  markEnrichmentJobFailed,
  markEnrichmentJobSucceeded,
  type ClaimedEnrichmentJob,
} from "../lib/queue/enrichmentJobs";
import type { RunJobOutcome } from "./runJob";

/**
 * One iteration against the rewrite queue. Same claim-to-disposition shape as
 * runJob, and deliberately so: an operator-requested rewrite gets the same
 * retry ladder, the same DLQ and the same stale-reclaim as an event.
 *
 * What it does NOT share is the failure meaning. When an event job dead-letters,
 * its finding is marked `failed` — evidence it absorbed never made it into
 * prose. When a rewrite dead-letters, nothing about the finding is wrong: the
 * prose already there still describes its evidence, and the operator simply did
 * not get the second opinion they asked for. Marking it failed would turn an
 * optional request into a broken finding.
 */
export async function runEnrichmentJob(
  workerId: string,
  provider?: EnrichmentProvider,
): Promise<RunJobOutcome> {
  const claimed = await claimEnrichmentJob(workerId);

  if (!claimed) {
    return "idle";
  }

  if (claimed.status === "dead_letter") {
    logJson({
      msg: "enrichment_job.dead_lettered_at_claim",
      job_id: claimed.id,
      finding_id: claimed.findingId,
      attempts: claimed.attempts,
      max_attempts: claimed.maxAttempts,
      worker_id: workerId,
    });
    await settleAbandonedRewrite(claimed);
    return "dead_lettered";
  }

  logJson({
    msg: "enrichment_job.claimed",
    job_id: claimed.id,
    finding_id: claimed.findingId,
    attempts: claimed.attempts,
    worker_id: workerId,
  });

  try {
    // Current version, not the one recorded when the button was clicked: the
    // rewrite should describe the evidence that exists now, and enrichFinding's
    // fence still discards it if correlation commits between this read and the
    // write.
    const target = await readEnrichmentTarget(claimed.findingId);

    if (!target) {
      logJson({
        msg: "enrichment_job.finding_missing",
        job_id: claimed.id,
        finding_id: claimed.findingId,
      });
      await markEnrichmentJobSucceeded(claimed);
      return "succeeded";
    }

    // No provider argument in production: enrichFinding resolves whichever one
    // the toggle currently names, which is the entire point of the request.
    await enrichFinding(
      {
        findingId: claimed.findingId,
        expectedVersion: target.version,
        drivers: target.drivers,
      },
      provider,
    );

    await markEnrichmentJobSucceeded(claimed);

    logJson({
      msg: "enrichment_job.succeeded",
      job_id: claimed.id,
      finding_id: claimed.findingId,
      worker_id: workerId,
    });
    return "succeeded";
  } catch (err) {
    const disposition = await markEnrichmentJobFailed(claimed, err);

    logJson({
      msg: "enrichment_job.failed",
      job_id: claimed.id,
      finding_id: claimed.findingId,
      attempts: claimed.attempts,
      disposition,
      error: err instanceof Error ? err.message : String(err),
      worker_id: workerId,
    });

    if (disposition === "dead_letter") {
      await settleAbandonedRewrite(claimed);
      return "dead_lettered";
    }

    return "failed";
  }
}

/**
 * Leave the finding as it was before the rewrite was asked for.
 *
 * enrichFinding claims by setting `status = 'processing'`, so a rewrite that
 * died after the claim and before the write leaves a finding that looks like it
 * is still being analyzed forever — no event job holds it, so nothing else would
 * ever move it. Restoring it to 'ready' is only correct where prose exists;
 * where it does not, 'failed' is the honest state and is what the event job's
 * own dead-letter path would have set.
 */
async function settleAbandonedRewrite(job: ClaimedEnrichmentJob): Promise<void> {
  const settled = await db.execute<{ id: string; status: string }>(sql`
    UPDATE findings
    SET status = CASE WHEN summary IS NULL THEN 'failed' ELSE 'ready' END
    WHERE id = ${job.findingId}
      AND status = 'processing'
    RETURNING id, status;
  `);

  logJson({
    msg: "enrichment_job.rewrite_abandoned",
    job_id: job.id,
    finding_id: job.findingId,
    settled_to: settled[0]?.status ?? null,
  });
}
