import type { IngestEventInput, IssueCategory } from "./schema";

// 'late_delivery' folds into the 'delivery_delay' issue_class rather than
// staying a literal value — a refund or complaint caused by lateness IS a
// delivery_delay-class incident for recurrence-counting purposes (slice 4).
// 'other' is intentionally absent: it means "no structured signal" and
// never overrides — see the fallthrough to event_type below.
const CATEGORY_TO_ISSUE_CLASS: Partial<Record<IssueCategory, string>> = {
  missing_items: "missing_items",
  wrong_order: "wrong_order",
  late_delivery: "delivery_delay",
};

// Deterministic, pure — the invariant-1 boundary is about what KIND of
// input drives issue_class (structured vs. free text), not just whether an
// LLM is involved. This function must never read complaint_text,
// review_text, or rating: a "helpful" keyword match on free text would
// silently violate that boundary without touching src/lib/llm/ at all.
export function deriveIssueClass(input: IngestEventInput): string {
  if (input.event_type === "complaint" && input.payload.category) {
    const mapped = CATEGORY_TO_ISSUE_CLASS[input.payload.category];
    if (mapped) return mapped;
  }
  if (input.event_type === "refund" && input.payload.reason) {
    const mapped = CATEGORY_TO_ISSUE_CLASS[input.payload.reason];
    if (mapped) return mapped;
  }
  return input.event_type;
}
