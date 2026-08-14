"use client";

import type { Priority } from "@/lib/correlation/priority";
import type { CardPresentation, CardState } from "@/lib/findings/cardState";
import type { RetryState } from "@/lib/findings/types";
import { formatCountdown } from "./format";
import { useNow } from "./useNow";

// Every state differs by hue, glyph AND wording together. Colour alone would
// make the four states indistinguishable to a colourblind operator, and this
// board's entire job is telling them apart at a glance. That is also what makes
// the palette safe to swap: a theme can change how legible these are, but it
// cannot collapse the distinction between them.
const STATUS_STYLES: Record<CardState, { className: string; glyph: string }> = {
  queued: { className: "border-line text-ink-muted", glyph: "○" },
  analyzing: { className: "border-warn-border text-warn-fg", glyph: "◐" },
  ready: { className: "border-ok-border text-ok-fg", glyph: "●" },
  failed_unanalyzed: { className: "border-danger-border text-danger-fg", glyph: "✕" },
  failed_stale: { className: "border-danger-border text-danger-fg", glyph: "✕" },
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

// The rail is a solid block and the badge is small text, so each priority
// carries two weights of its hue: the rail can be vivid, the word has to stay
// readable against the card behind it.
const PRIORITY_STYLES: Record<Priority, { rail: string; text: string }> = {
  critical: { rail: "bg-priority-critical", text: "text-priority-critical-fg" },
  high: { rail: "bg-priority-high", text: "text-priority-high-fg" },
  medium: { rail: "bg-priority-medium", text: "text-priority-medium-fg" },
  low: { rail: "bg-priority-low", text: "text-priority-low-fg" },
};

export function priorityRail(priority: Priority | null): string {
  return priority ? PRIORITY_STYLES[priority].rail : "bg-line";
}

export function PriorityBadge({ priority }: { priority: Priority | null }) {
  if (!priority) {
    return (
      <span className="text-xs font-semibold tracking-wider text-ink-subtle">UNSCORED</span>
    );
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
    <span className="inline-flex items-center gap-1 rounded border border-warn-border bg-warn-bg px-1.5 py-0.5 text-[11px] text-warn-fg">
      Retry {retry.attempts}/{retry.maxAttempts}
      {now !== null && <span>· next in {formatCountdown(retry.nextAttemptAt, now)}</span>}
    </span>
  );
}

export function StaleChip() {
  return (
    <span
      className="inline-flex items-center rounded border border-warn-border bg-warn-bg px-1.5 py-0.5 text-[11px] text-warn-fg"
      title="New evidence arrived after this summary was written. It will be rewritten on the next attempt."
    >
      Summary predates newest evidence
    </span>
  );
}

export function DegradedChip() {
  return (
    <span
      className="inline-flex items-center rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink-muted"
      title="Written without the language model. Evidence and priority are unaffected."
    >
      No model — template summary
    </span>
  );
}
