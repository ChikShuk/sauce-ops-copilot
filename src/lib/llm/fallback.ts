import { MAX_RECOMMENDED_ACTIONS } from "./schema";
import type { ExtractedTag, RecommendedActionType } from "./schema";
import type { Enrichment, EnrichmentInput, EnrichmentProvider } from "./types";

// Deterministic, offline, never throws. This is the default provider when no
// API key is set, so the whole product is demoable without one — and it is also
// what every LLM failure degrades into.
//
// It writes prose only. Priority, evidence, and event counts arrive already
// decided; the fallback restates them. That is the entire point of the
// deterministic/LLM split: losing the model costs wording, not correctness.

const ISSUE_CLASS_LABELS: Record<string, string> = {
  delivery_delay: "Late deliveries",
  complaint: "Customer complaints",
  refund: "Refund requests",
  negative_review: "Negative reviews",
  missing_items: "Missing items",
  wrong_order: "Wrong orders",
};

const ISSUE_CLASS_ACTIONS: Record<string, RecommendedActionType[]> = {
  delivery_delay: ["check_kitchen_capacity", "review_courier_assignment", "contact_customer"],
  complaint: ["contact_customer", "escalate_to_manager"],
  refund: ["contact_customer", "audit_order_accuracy"],
  negative_review: ["contact_customer", "escalate_to_manager"],
  missing_items: ["audit_order_accuracy", "contact_customer", "issue_refund"],
  wrong_order: ["audit_order_accuracy", "contact_customer", "issue_refund"],
};

const ISSUE_CLASS_TAGS: Record<string, ExtractedTag> = {
  delivery_delay: "late_delivery",
  missing_items: "missing_items",
  wrong_order: "wrong_order",
  complaint: "other",
  refund: "payment_issue",
  negative_review: "other",
};

// Ties broken by issue_class name so the same evidence always yields the same
// prose — a fallback summary that shuffled between runs would be worse than
// no summary, and would make the integration tests flaky.
function dominantIssueClass(input: EnrichmentInput): string | null {
  const counts = new Map<string, number>();
  for (const item of input.evidence) {
    counts.set(item.issueClass, (counts.get(item.issueClass) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  return ranked.length > 0 ? ranked[0][0] : null;
}

function buildIssue(input: EnrichmentInput, issueClass: string | null): string {
  const label = issueClass ? (ISSUE_CLASS_LABELS[issueClass] ?? "Operational issues") : "Operational issue";
  const plural = input.eventCount === 1 ? "event" : "events";
  return `${label} (${input.eventCount} ${plural})`;
}

function buildSummary(input: EnrichmentInput, issueClass: string | null): string {
  const label = issueClass ? (ISSUE_CLASS_LABELS[issueClass] ?? "operational issues") : "activity";
  const plural = input.eventCount === 1 ? "event" : "events";

  const sentences = [
    `${input.eventCount} related ${plural} between ${input.firstEventAt.toISOString()} and ${input.lastEventAt.toISOString()}, mostly ${label.toLowerCase()}.`,
  ];

  if (input.drivers.length > 0) {
    const reasons = input.drivers.map((driver) => driver.detail).join("; ");
    sentences.push(`Priority is ${input.priority ?? "unscored"} because: ${reasons}.`);
  } else {
    sentences.push(`Priority is ${input.priority ?? "unscored"}; no severity threshold was crossed.`);
  }

  // Say plainly that this is the degraded path. An operator reading a thin
  // summary should know it is thin because the model was unavailable, not
  // because there is little to say.
  sentences.push(
    "This summary was generated without the language model, so it restates the evidence rather than interpreting it. The finding, its evidence, and its priority are unaffected.",
  );

  return sentences.join(" ");
}

function buildActions(issueClass: string | null) {
  const types = (issueClass ? ISSUE_CLASS_ACTIONS[issueClass] : undefined) ?? [
    "escalate_to_manager" as const,
  ];

  return types.slice(0, MAX_RECOMMENDED_ACTIONS).map((type) => ({
    type,
    rationale: "Standard response for this issue type.",
  }));
}

function buildTags(input: EnrichmentInput): ExtractedTag[] {
  const tags = new Set<ExtractedTag>();
  for (const item of input.evidence) {
    tags.add(ISSUE_CLASS_TAGS[item.issueClass] ?? "other");
  }
  return [...tags].sort();
}

export function writeFallbackEnrichment(input: EnrichmentInput): Enrichment {
  const issueClass = dominantIssueClass(input);

  return {
    issue: buildIssue(input, issueClass),
    summary: buildSummary(input, issueClass),
    actions: buildActions(issueClass),
    tags: buildTags(input),
    // Not "every label". Citing everything would give cited_event_ids two
    // meanings — "the model selected these" on LLM rows, "all of them" here —
    // and slice 6 would highlight every event on a degraded finding, which is
    // noise. null reads as "no citation data available"; summary_source already
    // says which writer produced this row.
    citedEventIds: null,
    source: "fallback",
    model: null,
  };
}

export const fallbackProvider: EnrichmentProvider = {
  name: "fallback",
  enrich(input: EnrichmentInput): Promise<Enrichment> {
    return Promise.resolve(writeFallbackEnrichment(input));
  },
};
