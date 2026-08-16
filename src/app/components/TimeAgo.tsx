"use client";

import {
  RELATIVE_LIMIT_MS,
  formatLocalMoment,
  formatLocalShort,
  formatRelative,
  formatUtcMoment,
  formatUtcShort,
} from "@/lib/format";
import { useMounted, useNow } from "./useNow";

// One minute, because that is how often the displayed value can change: the
// relative format's finest unit is minutes in every band. The previous 30s clock
// re-rendered every timestamp on the board twice per possible change. The cost
// of the slower tick is that "just now" can hang up to a minute before flipping
// to "1 min ago" — bounded by the tick either way, and nothing an operator
// decides turns on it.
const RELATIVE_TICK_MS = 60_000;

// Absolute UTC on the server, relative once the browser has a clock. See
// useNow for why that split exists: `now` is null in the server snapshot, so
// the first paint is deterministic and hydration cannot mismatch.
export function TimeAgo({ iso }: { iso: string }) {
  const now = useNow(RELATIVE_TICK_MS);

  // Past a day, hand off to the absolute renderer. At that age the operator's
  // question has changed from "how long ago" to "when" — and a relative form
  // answers the wrong one, making them do arithmetic against the current time to
  // work out whether that was yesterday evening or the night before. It also
  // stops moving, which is honest: nothing about a two-day-old finding is still
  // in flight.
  if (now !== null && now - Date.parse(iso) >= RELATIVE_LIMIT_MS) {
    return <ExactTime iso={iso} short />;
  }

  return (
    <time dateTime={iso} title={formatUtcMoment(iso)}>
      {now === null ? formatUtcShort(iso) : formatRelative(iso, now)}
    </time>
  );
}

/**
 * An exact timestamp, in the viewer's own timezone once mounted.
 *
 * Same server/client split as TimeAgo, for the same reason — `toLocaleString`
 * during a server render is a guaranteed hydration mismatch, so UTC is what
 * both sides agree on for the first frame. The UTC form stays on `title`, since
 * an ops tool should always be able to show the unambiguous value.
 *
 * Reads `useMounted` rather than a clock: the only thing this needs to know is
 * whether hydration has happened. Its output never changes afterwards.
 */
export function ExactTime({ iso, short = false }: { iso: string; short?: boolean }) {
  const mounted = useMounted();

  const text = mounted
    ? short
      ? formatLocalShort(iso)
      : formatLocalMoment(iso)
    : short
      ? formatUtcShort(iso)
      : formatUtcMoment(iso);

  return (
    <time dateTime={iso} title={formatUtcMoment(iso)}>
      {text}
    </time>
  );
}
