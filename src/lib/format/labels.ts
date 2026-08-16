// Every machine vocabulary in the system, mapped to something an operator can
// read. Nothing in the UI should ever show an enum member.
//
// These are display values only. The stored values are unchanged and remain the
// single source of truth — correlation, priority scoring and the LLM boundary
// all keep working in snake_case, and every map here falls back to a readable
// transform of the raw value rather than to "Unknown", so a taxonomy that grows
// faster than this file degrades to `missing_utensils` -> "Missing utensils"
// instead of hiding information.

/** `some_enum_value` -> `Some enum value`. The universal fallback. */
export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  if (spaced.length === 0) return value;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `some_enum_value` -> `Some Enum Value`. For names rather than sentences. */
export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  delivery_delay: "Delivery delay",
  complaint: "Complaint",
  refund: "Refund",
  negative_review: "Negative review",
};

const ISSUE_CLASS_LABELS: Record<string, string> = {
  delivery_delay: "Late delivery",
  complaint: "Complaint",
  refund: "Refund",
  negative_review: "Negative review",
  missing_items: "Missing items",
  wrong_order: "Wrong order",
};

// The four signals scorePriority can raise. Named for what an operator would
// call them, not for the payload field they read.
const DRIVER_SIGNAL_LABELS: Record<string, string> = {
  delay_minutes: "Delivery delay",
  event_count: "Related events",
  review_rating: "Customer rating",
  recurrence: "Repeat pattern",
};

// One line each, explaining what the signal measures. Shown under the label in
// the priority panel so "Repeat pattern" is not itself a new piece of jargon.
const DRIVER_SIGNAL_HINTS: Record<string, string> = {
  delay_minutes: "Longest delay across this finding's events",
  event_count: "How much evidence has accumulated",
  review_rating: "Lowest star rating received",
  recurrence: "Same issue recurring at this restaurant within 24h",
};

const RECOMMENDED_ACTION_LABELS: Record<string, string> = {
  contact_customer: "Contact the customer",
  issue_refund: "Issue a refund",
  comp_next_order: "Comp the next order",
  escalate_to_manager: "Escalate to a manager",
  check_kitchen_capacity: "Check kitchen capacity",
  review_courier_assignment: "Review courier assignment",
  audit_order_accuracy: "Audit order accuracy",
  no_action_needed: "No action needed",
};

const EXTRACTED_TAG_LABELS: Record<string, string> = {
  missing_items: "Missing items",
  wrong_order: "Wrong order",
  late_delivery: "Late delivery",
  cold_food: "Cold food",
  rude_courier: "Rude courier",
  packaging: "Packaging",
  payment_issue: "Payment issue",
  other: "Other",
};

const OPERATOR_ACTION_LABELS: Record<string, string> = {
  mark_reviewed: "Marked reviewed",
  mark_resolved: "Marked resolved",
  thumbs_down: "Flagged summary as unhelpful",
  thumbs_up: "Marked summary as helpful",
};

export function labelEventType(value: string): string {
  return EVENT_TYPE_LABELS[value] ?? humanize(value);
}

export function labelIssueClass(value: string): string {
  return ISSUE_CLASS_LABELS[value] ?? humanize(value);
}

export function labelDriverSignal(value: string): string {
  return DRIVER_SIGNAL_LABELS[value] ?? humanize(value);
}

export function describeDriverSignal(value: string): string | null {
  return DRIVER_SIGNAL_HINTS[value] ?? null;
}

export function labelRecommendedAction(value: string): string {
  return RECOMMENDED_ACTION_LABELS[value] ?? humanize(value);
}

export function labelTag(value: string): string {
  return EXTRACTED_TAG_LABELS[value] ?? humanize(value);
}

export function labelOperatorAction(value: string): string {
  return OPERATOR_ACTION_LABELS[value] ?? humanize(value);
}

export function labelPriority(value: string | null): string {
  return value ? titleCase(value) : "Unscored";
}
