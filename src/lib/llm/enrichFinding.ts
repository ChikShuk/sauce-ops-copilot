import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../correlation/evidence";
import type { PriorityDriver } from "../correlation/priority";
import { db } from "../db/client";
import { logJson } from "../log";
import { writeFallbackEnrichment } from "./fallback";
import { fetchEnrichmentSnapshot } from "./enrichmentInput";
import { getProvider } from "./index";
import type { Enrichment, EnrichmentProvider } from "./types";

/**
 * The token/cost columns of the enrichment write, as SQL.
 *
 * Accumulating rather than replacing: a finding is enriched once per version,
 * so "what has this finding cost" is the sum over every enrichment it has had,
 * not the price of the latest one.
 *
 * A writer that spent nothing emits no assignment at all, which is what keeps
 * the columns NULL for a never-modelled finding. Writing zeros would be worse
 * than useless — it would claim a model ran for free — and a fallback pass over
 * a previously-enriched finding must not wipe what earlier calls did spend.
 *
 * Cost is assigned separately from tokens because an unpriced model (one absent
 * from the rate table) still has real token counts to record.
 */
function usageWrite(enrichment: Enrichment) {
  const usage = enrichment.usage;
  if (usage === null) return sql``;

  return sql`
    llm_input_tokens = COALESCE(llm_input_tokens, 0) + ${usage.inputTokens},
    llm_output_tokens = COALESCE(llm_output_tokens, 0) + ${usage.outputTokens},
    ${
      usage.costMicrosUsd === null
        ? sql``
        : sql`llm_cost_micros_usd = COALESCE(llm_cost_micros_usd, 0) + ${usage.costMicrosUsd},`
    }
  `;
}

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
 *
 * `provider` is a parameter so tests can inject one. Left out, it is resolved
 * per call from the runtime setting — a default parameter cannot express that,
 * since resolving now reads the database.
 */
export async function enrichFinding(
  args: EnrichFindingArgs,
  provider?: EnrichmentProvider,
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

  // Resolved after the claim, not before: the toggle should be read as late as
  // possible, so a job that waited in the queue runs under the provider in force
  // when it actually runs.
  const active = provider ?? (await getProvider());

  let enrichment: Enrichment;
  try {
    enrichment = await active.enrich(input);
  } catch (err) {
    logJson({
      msg: "enrichment.provider_failed",
      finding_id: findingId,
      provider: active.name,
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
        ${usageWrite(enrichment)}
        enriched_at = now(),
        -- Records which evidence set this prose describes. The WHERE clause
        -- below already pins version to expectedVersion, so this is that same
        -- number written down where a reader can compare it later.
        enriched_version = ${expectedVersion}
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
    provider: active.name,
    cited_event_count: enrichment.citedEventIds?.length ?? null,
    // Null rather than 0 on the fallback path: no model ran, so there is no
    // spend to report. Same distinction the stored columns make.
    input_tokens: enrichment.usage?.inputTokens ?? null,
    output_tokens: enrichment.usage?.outputTokens ?? null,
    cost_micros_usd: enrichment.usage?.costMicrosUsd ?? null,
  });
}
