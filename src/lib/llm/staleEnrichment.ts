import { sql } from "drizzle-orm";
import { parsePriorityDrivers } from "../correlation/drivers";
import type { PriorityDriver } from "../correlation/priority";
import { db } from "../db/client";

export type RepairTarget = {
  version: number;
  drivers: PriorityDriver[];
};

/**
 * Decide whether a finding's prose has fallen behind its evidence.
 *
 * The version fence never causes this on its own: the loser of an enrichment
 * race is discarded and the winner writes prose describing a superset. It
 * happens when the *winner* never completes — a worker dies between correlation
 * committing and enrichFinding's write. Two shapes: dead before the claim
 * UPDATE leaves the finding 'ready' with silently stale prose; dead after it
 * leaves the finding stuck in 'processing'.
 *
 * The repair is guaranteed to get a chance to run. enrichFinding is called
 * before markSucceeded, so stale prose always implies an un-acked job — which
 * stale-reclaim redelivers, which is the path that returns 'already_attached'.
 * That branch used to return early and skip enrichment forever, which is the
 * only reason this state was permanent rather than self-healing.
 *
 * Returns null when the prose is current, which is the overwhelmingly common
 * case for a redelivery and must not cost an LLM call.
 *
 * Staleness is measured in versions, not timestamps. enriched_at is wall time
 * and last_event_at is the business time an event occurred, so comparing them
 * would answer a different question entirely — for any live event the prose is
 * always written after the event happened, and for a backfill it is always
 * written days after.
 */
export async function findRepairTarget(findingId: string): Promise<RepairTarget | null> {
  const rows = await db.execute<{
    version: number;
    priority_drivers: unknown;
  }>(sql`
    SELECT version, priority_drivers
    FROM findings
    WHERE id = ${findingId}
      AND (enriched_version IS NULL OR enriched_version < version);
  `);

  if (rows.length === 0) {
    return null;
  }

  return {
    version: rows[0].version,
    // Read back rather than recomputed. Correlation already decided these and
    // wrote them in the same statement as `priority`; recomputing here would be
    // a second implementation of the severity rules on the repair path.
    drivers: parsePriorityDrivers(rows[0].priority_drivers),
  };
}

/**
 * The same read without the staleness predicate, for an operator-requested
 * rewrite.
 *
 * A re-enrichment is asked for precisely when the prose is *not* stale — the
 * evidence has not changed and the operator wants to see it described by the
 * other provider. Reading the version here, at claim time rather than at request
 * time, is what keeps the fence in enrichFinding meaningful: the rewrite is
 * scoped to the evidence that exists when it actually runs, and if correlation
 * commits new evidence in between, the fenced write finds zero rows and the
 * newer enrichment wins.
 *
 * Null when the finding is gone — a rewrite queued for a deleted finding is a
 * no-op, not a failure.
 */
export async function readEnrichmentTarget(findingId: string): Promise<RepairTarget | null> {
  const rows = await db.execute<{
    version: number;
    priority_drivers: unknown;
  }>(sql`
    SELECT version, priority_drivers
    FROM findings
    WHERE id = ${findingId};
  `);

  if (rows.length === 0) {
    return null;
  }

  return {
    version: rows[0].version,
    drivers: parsePriorityDrivers(rows[0].priority_drivers),
  };
}
