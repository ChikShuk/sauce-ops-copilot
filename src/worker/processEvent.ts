import type { InferSelectModel } from "drizzle-orm";
import type { events } from "../lib/db/schema";

export type EventRow = InferSelectModel<typeof events>;

// Correlation (slice 4) and LLM enrichment (slice 5) land here. For slice 3
// this is a deterministic no-op success: the slice's job is to prove the
// queue mechanics — claim safety, retry, backoff, DLQ, crash recovery — and
// there is no business logic yet to run.
//
// Deliberately not `throw new Error("not implemented")`: that would route
// every real job straight to failure and then the DLQ, misrepresenting
// working queue mechanics as broken.
export async function processEvent(event: EventRow): Promise<void> {
  void event;
}
