// LLM call bounds — stubbed here in slice 3, consumed for real by slice 5's
// provider. They live here now rather than in llm/ because
// PROCESSING_TIMEOUT_MS derives from them: if slice 5 raises the LLM
// timeout, the stale-reclaim window widens with it automatically, instead
// of depending on someone remembering to.
export const LLM_TIMEOUT_MS = 15_000;
// Bounded retry, per CLAUDE.md's "every LLM call: timeout, bounded retry".
export const MAX_LLM_ATTEMPTS = 2;

// Covers the event fetch, correlation SQL, and disposition write around the
// LLM call itself, plus scheduling slop.
const PROCESSING_MARGIN_MS = 15_000;

// A claimed job becomes reclaimable by another worker only after the
// longest *legitimate* processing time has elapsed. Too short and a
// slow-but-alive worker gets its job stolen mid-flight and burns a retry it
// never earned.
export const PROCESSING_TIMEOUT_MS =
  LLM_TIMEOUT_MS * MAX_LLM_ATTEMPTS + PROCESSING_MARGIN_MS;

// Idle polling cost only — the loop re-polls immediately after a successful
// claim, so this is never a per-job tax. See src/worker/index.ts.
export const POLL_INTERVAL_MS = 1_000;

// How far from a finding's nearest evidence edge an event may fall and still
// belong to it. Consecutive evidence within one finding is therefore never more
// than this far apart. Interacts with two things worth keeping in view:
// findings_restaurant_id_open_key (at most one open finding per restaurant, so
// a lapsed window is what lets the next one start) and the occurred_at bound in
// events/schema.ts (7 days past), which is the range of backfill this window
// has to classify correctly.
//
// Priority thresholds deliberately do NOT live here — they belong beside the
// pure function that reads them, in correlation/priority.ts.
export const CORRELATION_WINDOW_MS = 3 * 60 * 60_000;
