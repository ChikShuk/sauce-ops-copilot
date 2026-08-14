import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../correlation/evidence";
import type { PriorityDriver } from "../correlation/priority";
import { db } from "../db/client";
import { logJson } from "../log";
import { writeFallbackEnrichment } from "./fallback";
import { fetchEnrichmentSnapshot } from "./enrichmentInput";
import { getProvider } from "./index";
import type { Enrichment, EnrichmentProvider } from "./types";

export type EnrichFindingArgs = {
  findingId: string;
  // The version observed when correlation committed. Every write below is
  // fenced on it.
  expectedVersion: number;
  drivers: PriorityDriver[];
};

/**
 * Write the human-readable half of a finding.
 *
 * Runs outside correlation's transaction and holds no row lock, because it
 * makes a network call — see the comment in queue/claimJob.ts about why the
 * claim commits immediately.
 *
 * That means another worker can attach new evidence while this one is waiting
 * on the model, and the loser of that race must not overwrite fresher prose
 * with a summary describing a smaller evidence set. Both writes are therefore
 * fenced on `findings.version`:
 *
 *     WHERE id = $1 AND version = $2
 *
 * Zero rows means superseded — the winner's enrichment already describes a
 * superset of this evidence, so discarding is correct and no retry is wanted.
 * Enrichment never bumps `version` itself: version stays correlation-owned,
 * which is exactly what makes it usable as a fence here. Same shape as the
 * claim_token fencing in slice 3.
 *
 * An LLM outage is never a job failure (docs/decisions.md). Provider errors are
 * caught here and degrade to the deterministic writer; only a genuine
 * infrastructure error — a failed database write — escapes to the worker's
 * retry/DLQ machinery.
 */
export async function enrichFinding(
  args: EnrichFindingArgs,
  provider: EnrichmentProvider = getProvider(),
): Promise<void> {
  const { findingId, expectedVersion } = args;

  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE findings
    SET status = 'processing'
    WHERE id = ${findingId} AND version = ${expectedVersion}
    RETURNING id;
  `);

  if (claimed.length === 0) {
    logJson({
      msg: "enrichment.superseded",
      stage: "claim",
      finding_id: findingId,
      expected_version: expectedVersion,
    });
    return;
  }

  // Same cast correlateEvent uses for its tx handle: SqlExecutor is a minimal
  // "can run raw SQL" shape so callers can pass a db or a tx without this code
  // depending on Drizzle's generics.
  const snapshot = await fetchEnrichmentSnapshot(db as unknown as SqlExecutor, findingId);
  if (!snapshot) {
    // The finding vanished between the two statements. Nothing to enrich, and
    // nothing broken — don't fail the job over it.
    logJson({ msg: "enrichment.finding_missing", finding_id: findingId });
    return;
  }

  const input = {
    findingId,
    priority: snapshot.priority,
    drivers: args.drivers,
    eventCount: snapshot.eventCount,
    firstEventAt: snapshot.firstEventAt,
    lastEventAt: snapshot.lastEventAt,
    evidence: snapshot.evidence,
  };

  let enrichment: Enrichment;
  try {
    enrichment = await provider.enrich(input);
  } catch (err) {
    logJson({
      msg: "enrichment.provider_failed",
      finding_id: findingId,
      provider: provider.name,
      error: err instanceof Error ? err.message : String(err),
    });
    enrichment = writeFallbackEnrichment(input);
  }

  const written = await db.execute<{ id: string }>(sql`
    UPDATE findings
    SET status = 'ready',
        issue = ${enrichment.issue},
        summary = ${enrichment.summary},
        recommended_actions = ${JSON.stringify(enrichment.actions)}::jsonb,
        extracted_tags = ${JSON.stringify(enrichment.tags)}::jsonb,
        cited_event_ids = ${
          enrichment.citedEventIds === null
            ? null
            : JSON.stringify(enrichment.citedEventIds)
        }::jsonb,
        summary_source = ${enrichment.source},
        llm_model = ${enrichment.model},
        enriched_at = now()
    WHERE id = ${findingId} AND version = ${expectedVersion}
    RETURNING id;
  `);

  if (written.length === 0) {
    logJson({
      msg: "enrichment.superseded",
      stage: "write",
      finding_id: findingId,
      expected_version: expectedVersion,
      source: enrichment.source,
    });
    return;
  }

  logJson({
    msg: "enrichment.completed",
    finding_id: findingId,
    version: expectedVersion,
    source: enrichment.source,
    model: enrichment.model,
    provider: provider.name,
    cited_event_count: enrichment.citedEventIds?.length ?? null,
  });
}
