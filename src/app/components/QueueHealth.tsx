"use client";

import type { QueueCounts } from "@/lib/findings/types";

export type ConnectionState = "connecting" | "live" | "reconnecting";

const CONNECTION_STYLES: Record<ConnectionState, { className: string; label: string }> = {
  connecting: { className: "text-zinc-400", label: "Connecting" },
  live: { className: "text-emerald-400", label: "Live" },
  reconnecting: { className: "text-amber-400", label: "Reconnecting" },
};

/**
 * Job-level counts, deliberately minimal — four numbers, no charts.
 *
 * It exists for the work the board cannot show. An event whose job is being
 * retried *before* correlation commits has no finding to badge, so without this
 * strip the dashboard sits perfectly still while the queue is busy. That is
 * exactly the case the brief singles out: delayed or retried processing has to
 * be distinguishable from a completed result.
 */
export function QueueHealth({
  queue,
  connection,
}: {
  queue: QueueCounts;
  connection: ConnectionState;
}) {
  const connectionStyle = CONNECTION_STYLES[connection];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-800 bg-zinc-950 px-4 py-2 text-xs">
      <span className={`flex items-center gap-1.5 font-medium ${connectionStyle.className}`}>
        <span aria-hidden className={connection === "live" ? "animate-pulse" : undefined}>
          ●
        </span>
        {connectionStyle.label}
      </span>

      <span className="text-zinc-600">|</span>

      <Count label="queued" value={queue.queued} className="text-zinc-300" />
      <Count label="analyzing" value={queue.analyzing} className="text-amber-300" />
      <Count label="retrying" value={queue.retrying} className="text-amber-300" />
      <Count label="failed permanently" value={queue.failed} className="text-red-300" />
    </div>
  );
}

function Count({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  // Zero counts stay visible rather than disappearing: a strip whose items come
  // and go is harder to read at a glance than one whose shape never changes.
  return (
    <span className="text-zinc-500">
      <span className={value > 0 ? className : "text-zinc-500"}>{value}</span> {label}
    </span>
  );
}
