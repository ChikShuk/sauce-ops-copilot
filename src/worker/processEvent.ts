import type { InferSelectModel } from "drizzle-orm";
import { correlateEvent } from "../lib/correlation/correlateEvent";
import type { events } from "../lib/db/schema";
import { env } from "../lib/env";
import { enrichFinding } from "../lib/llm/enrichFinding";
import type { EnrichmentProvider } from "../lib/llm/types";
import { logJson } from "../lib/log";

export type EventRow = InferSelectModel<typeof events>;

export const FORCE_FAIL_PREFIX = "force_fail_";

// Correlation and priority are deterministic; enrichment hangs off the returned
// outcome. "created"/"attached"/"replaced" mean the finding's evidence changed
// and its prose needs regenerating, while "already_attached" means a redelivery
// that changed nothing and must not spend an LLM call.
//
// Note that closed_at is NOT an input to that decision — a born-closed backfill
// finding is a real problem an operator should see, and gets enriched like any
// other.
//
// The provider is a parameter so tests can inject one; production takes the
// env-selected default from getProvider().
export async function processEvent(
  event: EventRow,
  provider?: EnrichmentProvider,
): Promise<void> {
  const result = await correlateEvent(event);

  logJson({
    msg: "correlation.completed",
    event_id: event.id,
    finding_id: result.findingId,
    outcome: result.outcome,
    version: result.version,
    priority: result.priority,
    event_count: result.eventCount,
    closed_finding_id: result.closedFindingId,
  });

  // Demo affordance, deliberately not hidden. Correlation succeeds and LLM
  // outages degrade to the fallback, so in normal operation a job essentially
  // never fails — which would leave the accepted -> processing -> ready|failed
  // status machine's failure branch unreachable by anyone demoing the product.
  // This throws *after* correlation has committed, so the finding exists with
  // real evidence and priority; the job then walks the real retry ladder
  // (1s, 2s, 4s, 8s) into the DLQ, and the worker marks the finding failed.
  // Off unless ENABLE_DEMO_FAILURE_TRIGGER=true.
  if (env.ENABLE_DEMO_FAILURE_TRIGGER && event.eventId.startsWith(FORCE_FAIL_PREFIX)) {
    logJson({
      msg: "job.demo_failure_triggered",
      event_id: event.id,
      client_event_id: event.eventId,
      finding_id: result.findingId,
    });
    throw new Error(`demo failure trigger fired for event_id ${event.eventId}`);
  }

  if (result.outcome === "already_attached") {
    logJson({
      msg: "enrichment.skipped_redelivery",
      event_id: event.id,
      finding_id: result.findingId,
    });
    return;
  }

  await enrichFinding(
    {
      findingId: result.findingId,
      expectedVersion: result.version,
      drivers: result.drivers,
    },
    provider,
  );
}
