// Formatting shared by the card and the detail panel.
//
// Absolute times are rendered in UTC on purpose. The server renders the first
// paint and the browser renders every one after it, so a locale- or
// timezone-dependent format would produce a hydration mismatch on the very
// first frame. Relative times ("2 min ago") are computed only after mount, for
// the same reason — see TimeAgo.tsx.

export function formatUtcTime(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes} UTC`;
}

export function formatUtcDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.toISOString().slice(0, 10)} ${formatUtcTime(iso)}`;
}

export function formatRelative(iso: string, now: number): string {
  const deltaMs = now - Date.parse(iso);
  const seconds = Math.round(deltaMs / 1000);

  if (seconds < 0) return "just now";
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

export function formatCountdown(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  if (seconds === 0) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  delivery_delay: "Delivery delay",
  complaint: "Complaint",
  refund: "Refund",
  negative_review: "Negative review",
};

const ISSUE_CLASS_LABELS: Record<string, string> = {
  delivery_delay: "Delivery delay",
  complaint: "Complaint",
  refund: "Refund",
  negative_review: "Negative review",
  missing_items: "Missing items",
  wrong_order: "Wrong order",
};

// Falls back to the raw value rather than to "Unknown": if the taxonomy grows
// and this map lags, showing `missing_utensils` is more useful than hiding it.
export function labelEventType(value: string): string {
  return EVENT_TYPE_LABELS[value] ?? value;
}

export function labelIssueClass(value: string): string {
  return ISSUE_CLASS_LABELS[value] ?? value;
}

// The model's action allowlist is snake_case machine vocabulary. Nothing in the
// UI should show an operator an enum member.
export function labelAction(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function labelTag(value: string): string {
  return value.replace(/_/g, " ");
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
