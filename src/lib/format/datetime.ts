// Absolute times render in UTC on the server and switch to the viewer's own
// timezone after mount.
//
// That split is not cosmetic. The server paints first and the browser paints
// every frame after it, so a locale- or timezone-dependent format produced
// during render is a guaranteed hydration mismatch. `formatUtcMoment` is what
// both sides agree on; `formatLocalMoment` is only ever called from a mounted
// client component. Same rule TimeAgo has always followed.

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "16 Aug 2026, 01:02 UTC" — safe to render on the server. */
export function formatUtcMoment(value: Date | string): string {
  const date = toDate(value);
  return (
    `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** "16 Aug, 01:02 UTC" — the same thing without the year, for dense rows. */
export function formatUtcShort(value: Date | string): string {
  const date = toDate(value);
  return (
    `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/**
 * "16 Aug 2026, 4:02 AM" in the viewer's own timezone.
 *
 * Client-only. Calling this during a server render reintroduces exactly the
 * hydration mismatch the UTC pair above exists to prevent.
 *
 * `hour12` is pinned rather than left to the locale: the timezone should follow
 * the viewer, but a 24-hour clock next to the 12-hour one elsewhere on the board
 * reads as two different notations for the same kind of value.
 */
export function formatLocalMoment(value: Date | string): string {
  return toDate(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** "16 Aug, 4:02 AM" — no year. Client-only, same caveats. */
export function formatLocalShort(value: Date | string): string {
  return toDate(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Past a day, elapsed time stops being the question. See TimeAgo, which renders
 * an absolute date beyond this rather than a coarser relative one.
 *
 * Exported so the component and its tests agree on one number instead of two
 * that can drift.
 */
export const RELATIVE_LIMIT_MS = 24 * 60 * 60_000;

/**
 * How long ago, at the precision an operator can act on.
 *
 * Two units past the hour — "1h 35m ago" — because the previous single-unit form
 * collapsed everything from 1h00m to 1h59m into one of two strings, and the hour
 * boundary is exactly where "is this still happening or is it over?" gets asked.
 * The compact form matches formatDuration's vocabulary below; the expanded card
 * prints "2h 15m span" a line above this, and two renderings of the same
 * quantity on one panel read as two systems.
 *
 * Every division floors rather than rounds, and that is a correctness fix rather
 * than a formatting preference. `Math.round` reported 1h50m as "2h ago" and 90
 * seconds as "2 min ago" — ten minutes and thirty seconds *into the future* of
 * what actually happened. An incident shown as older than it is reads as
 * something that has stopped mattering.
 *
 * Negative deltas — clock skew between browser and server, an occurred_at a few
 * seconds ahead — fall into "just now" rather than rendering a negative age.
 */
export function formatRelative(iso: string, now: number): string {
  const deltaMs = now - Date.parse(iso);
  const seconds = Math.floor(deltaMs / 1000);

  if (seconds < 45) return "just now";
  // Floor would say "0 min" for the 45-59s slice, so this band is stated rather
  // than computed.
  if (seconds < 90) return "1 min ago";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  // "2h 0m ago" carries no information the "2h" doesn't and reads like a stopped
  // clock.
  if (hours < 24) return rest === 0 ? `${hours}h ago` : `${hours}h ${rest}m ago`;

  // Only reachable if a caller renders past RELATIVE_LIMIT_MS without switching
  // to an absolute date, which TimeAgo does not. Kept so this function is total.
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatCountdown(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  if (seconds === 0) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/** "1h 20m" — how long a finding's evidence window spans. */
export function formatDuration(from: Date | string, to: Date | string): string {
  const minutes = Math.max(0, Math.round((toDate(to).getTime() - toDate(from).getTime()) / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
