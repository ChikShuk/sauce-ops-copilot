"use client";

import type { Priority } from "@/lib/correlation/priority";
import type { CardPresentation, CardState } from "@/lib/findings/cardState";
import type { RetryState } from "@/lib/findings/types";
import { formatCountdown } from "./format";
import { useNow } from "./useNow";

// Every state differs by hue, glyph AND wording together. Colour alone would
// make the four states indistinguishable to a colourblind operator, and this
// board's entire job is telling them apart at a glance.
const STATUS_STYLES: Record<CardState, { className: string; glyph: string }> = {
  queued: { className: "border-zinc-700 text-zinc-400", glyph: "○" },
  analyzing: { className: "border-amber-500/60 text-amber-300", glyph: "◐" },
  ready: { className: "border-emerald-500/60 text-emerald-300", glyph: "●" },
  failed_unanalyzed: { className: "border-red-500/60 text-red-300", glyph: "✕" },
  failed_stale: { className: "border-red-500/60 text-red-300", glyph: "✕" },
};

export function StatusPill({ presentation }: { presentation: CardPresentation }) {
  const style = STATUS_STYLES[presentation.state];

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${style.className}`}
    >
      <span
        aria-hidden
        className={presentation.state === "analyzing" ? "animate-pulse" : undefined}
      >
        {style.glyph}
      </span>
      {presentation.label}
    </span>
  );
}

const PRIORITY_STYLES: Record<Priority, { rail: string; text: string }> = {
  critical: { rail: "bg-red-500", text: "text-red-400" },
  high: { rail: "bg-orange-500", text: "text-orange-400" },
  medium: { rail: "bg-amber-400", text: "text-amber-300" },
  low: { rail: "bg-sky-500", text: "text-sky-400" },
};

export function priorityRail(priority: Priority | null): string {
  return priority ? PRIORITY_STYLES[priority].rail : "bg-zinc-700";
}

export function PriorityBadge({ priority }: { priority: Priority | null }) {
  if (!priority) {
    return <span className="text-xs font-semibold tracking-wider text-zinc-500">UNSCORED</span>;
  }

  return (
    <span
      className={`text-xs font-semibold tracking-wider ${PRIORITY_STYLES[priority].text}`}
    >
      {priority.toUpperCase()}
    </span>
  );
}

/**
 * Retry is job state, not finding state — a finding has no concept of attempts.
 * It renders as a separate chip rather than a fifth status precisely because it
 * is orthogonal: a finding can be `ready` from earlier evidence while a newer
 * event behind it is still being retried.
 */
export function RetryChip({ retry }: { retry: RetryState }) {
  const now = useNow(1_000);

  return (
    <span className="inline-flex items-center gap-1 rounded border border-amber-600/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300">
      Retry {retry.attempts}/{retry.maxAttempts}
      {now !== null && <span className="text-amber-400/70">· next in {formatCountdown(retry.nextAttemptAt, now)}</span>}
    </span>
  );
}

export function StaleChip() {
  return (
    <span
      className="inline-flex items-center rounded border border-amber-600/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300"
      title="New evidence arrived after this summary was written. It will be rewritten on the next attempt."
    >
      Summary predates newest evidence
    </span>
  );
}

export function DegradedChip() {
  return (
    <span
      className="inline-flex items-center rounded border border-zinc-600 bg-zinc-800/60 px-1.5 py-0.5 text-[11px] text-zinc-400"
      title="Written without the language model. Evidence and priority are unaffected."
    >
      No model — template summary
    </span>
  );
}
