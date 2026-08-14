"use client";

import { formatRelative, formatUtcDateTime, formatUtcTime } from "./format";
import { useNow } from "./useNow";

// Absolute UTC on the server, relative once the browser has a clock. See
// useNow for why that split exists.
export function TimeAgo({ iso }: { iso: string }) {
  const now = useNow(30_000);

  return (
    <time dateTime={iso} title={formatUtcDateTime(iso)}>
      {now === null ? formatUtcTime(iso) : formatRelative(iso, now)}
    </time>
  );
}
