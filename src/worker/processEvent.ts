import type { InferSelectModel } from "drizzle-orm";
import { correlateEvent } from "../lib/correlation/correlateEvent";
import type { events } from "../lib/db/schema";
import { logJson } from "../lib/log";

export type EventRow = InferSelectModel<typeof events>;

// Correlation and priority (deterministic, this slice). LLM enrichment hangs
// off the returned outcome in slice 5: "created"/"attached"/"replaced" mean the
// finding's evidence changed and its prose needs regenerating, while
// "already_attached" means a redelivery that changed nothing and must not.
// Note that closed_at is NOT an input to that decision — a born-closed backfill
// finding is a real problem an operator should see, and gets enriched like any
// other.
export async function processEvent(event: EventRow): Promise<void> {
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
}
