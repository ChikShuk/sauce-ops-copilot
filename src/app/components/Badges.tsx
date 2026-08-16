"use client";

import { BotIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Priority } from "@/lib/correlation/priority";
import type { CardPresentation, CardState } from "@/lib/findings/cardState";
import type { LlmUsage, RetryState } from "@/lib/findings/types";
import { cn } from "@/lib/utils";
import {
  formatCountdown,
  formatTokensCompact,
  formatTokensExact,
  formatUsdMicros,
  labelPriority,
} from "@/lib/format";
import { Tip } from "./Tip";
import { BOT_TIP, DEGRADED_TIP, PRIORITY_TIP, RETRY_TIP, STALE_TIP, STATUS_TIPS } from "./tips";
import { useNow } from "./useNow";

// Every state differs by hue, shape AND wording together. Colour alone would
// make the four states indistinguishable to a colourblind operator, and this
// board's entire job is telling them apart at a glance.
//
// The badges are soft tinted shapes, but the marker's *form* still varies — a
// hollow ring, a half-filled glyph, a solid dot, a cross. A uniform coloured dot
// on all four would have quietly dropped the shape channel and left only hue and
// wording. That is why `analyzing` and `failed` keep glyphs rather than being
// normalised into dots.
const STATUS_STYLES: Record<CardState, { className: string; mark: React.ReactNode }> = {
  queued: {
    className: "bg-surface text-ink-muted",
    mark: <span aria-hidden className="size-2 rounded-full border-[1.5px] border-current" />,
  },
  analyzing: {
    className: "bg-warn-bg text-warn-fg",
    mark: (
      <span aria-hidden className="animate-pulse leading-none">
        ◐
      </span>
    ),
  },
  ready: {
    className: "bg-ok-bg text-ok-fg",
    mark: <span aria-hidden className="size-2 rounded-full bg-current" />,
  },
  failed_unanalyzed: {
    className: "bg-danger-bg text-danger-fg",
    mark: (
      <span aria-hidden className="leading-none">
        ✕
      </span>
    ),
  },
  failed_stale: {
    className: "bg-danger-bg text-danger-fg",
    mark: (
      <span aria-hidden className="leading-none">
        ✕
      </span>
    ),
  },
};

export function StatusBadge({
  presentation,
  explain = false,
}: {
  presentation: CardPresentation;
  /**
   * Only the expanded row sets this. A tip on every collapsed row's badge would
   * put dozens of icons on the board; one on the open finding, plus the legend
   * in the header, covers the same ground without the clutter. It is also what
   * keeps the collapsed row free of nested buttons inside the accordion
   * trigger.
   */
  explain?: boolean;
}) {
  const style = STATUS_STYLES[presentation.state];

  const badge = (
    <Badge className={cn("h-6 gap-1.5 px-2.5 text-meta", style.className)}>
      {style.mark}
      {presentation.label}
    </Badge>
  );

  if (!explain) return badge;

  return (
    <Tip label={presentation.label} trigger={badge} wide>
      {STATUS_TIPS[presentation.state]}
    </Tip>
  );
}

// The rail is a solid block and the word is small text, so each priority
// carries two weights of its hue: the rail can be vivid, the word has to stay
// readable against the surface behind it.
const PRIORITY_STYLES: Record<Priority, { rail: string; text: string }> = {
  critical: { rail: "bg-priority-critical", text: "text-priority-critical-fg" },
  high: { rail: "bg-priority-high", text: "text-priority-high-fg" },
  medium: { rail: "bg-priority-medium", text: "text-priority-medium-fg" },
  low: { rail: "bg-priority-low", text: "text-priority-low-fg" },
};

export function priorityRail(priority: Priority | null): string {
  return priority ? PRIORITY_STYLES[priority].rail : "bg-line";
}

export function PriorityLabel({
  priority,
  explain = false,
}: {
  priority: Priority | null;
  explain?: boolean;
}) {
  // Title case rather than shouted caps: the colour and weight already carry
  // the emphasis, and four all-caps words in a metadata line is noise.
  const label = (
    <span
      className={cn(
        "text-meta font-semibold",
        priority ? PRIORITY_STYLES[priority].text : "text-ink-subtle",
      )}
    >
      {labelPriority(priority)}
    </span>
  );

  if (!explain) return label;

  return (
    <Tip label="Priority" trigger={label} wide>
      {PRIORITY_TIP}
    </Tip>
  );
}

const CHIP = "h-6 gap-1 px-2 text-meta font-normal";

/**
 * Retry is job state, not finding state — a finding has no concept of attempts.
 * It renders separately from the status badge precisely because it is
 * orthogonal: a finding can be `ready` from earlier evidence while a newer event
 * behind it is still being retried.
 *
 * `explain` is off inside the collapsed accordion row, where a countdown is
 * worth seeing at a glance but a popover trigger would nest a button inside the
 * row's own trigger button.
 */
export function RetryChip({ retry, explain = false }: { retry: RetryState; explain?: boolean }) {
  const now = useNow(1_000);

  const chip = (
    <Badge className={cn(CHIP, "bg-warn-bg text-warn-fg")}>
      Retry {retry.attempts}/{retry.maxAttempts}
      {now !== null && <span>· next in {formatCountdown(retry.nextAttemptAt, now)}</span>}
    </Badge>
  );

  if (!explain) return chip;

  return (
    <Tip label="Retrying" trigger={chip}>
      {RETRY_TIP}
    </Tip>
  );
}

/**
 * The model mark: this finding's prose was written by the LLM, and here is what
 * it cost.
 *
 * Rendered only where `deriveCardState().modelWritten` is true, which is the
 * one place that rule lives. Its absence is meaningful — a finding on the
 * degraded path carries `DegradedChip` instead, and an un-enriched one carries
 * neither. That pairing is the point: the board makes the deterministic/model
 * boundary visible per finding, so an operator can see that priority, evidence
 * and status were never the model's to decide.
 *
 * The numbers are the second half of that. An enrichment is worth a fraction of
 * a cent, and showing it is what turns "we use an LLM" into a figure a reviewer
 * can multiply by their event volume.
 *
 * Brand hue rather than a status hue on purpose. This is not a fifth state
 * competing with queued/analyzing/ready/failed — it is a different axis, and
 * borrowing warn or ok would read as one.
 */
export function BotChip({
  usage,
  explain = false,
}: {
  usage: LlmUsage | null | undefined;
  explain?: boolean;
}) {
  // Tokens can be absent on a genuinely model-written finding: rows enriched
  // before this was recorded, a provider that reports no usage, or a card that
  // reached the client without the field at all — the broadcaster caches the
  // board on `globalThis`, so a dev-server hot reload can hand the first paint
  // a board built by the previous version of this code.
  //
  // Hence `!usage` rather than `usage === null`: the missing-field case arrives
  // as undefined, and an earlier `=== null` check let it through to crash the
  // whole board on a decoration. A display-only chip must never be able to do
  // that — absent figures degrade to the mark alone, which is the same thing
  // this renders for a finding whose spend genuinely isn't known.
  const figures = !usage
    ? null
    : [
        formatTokensCompact(usage.inputTokens + usage.outputTokens),
        // `typeof`, not `!== null`, for the same reason as the guard above: a
        // partial payload carries undefined, and `undefined !== null` would
        // reach the formatter and render "$NaN".
        typeof usage.costMicrosUsd === "number" ? formatUsdMicros(usage.costMicrosUsd) : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ");

  const chip = (
    <Badge className={cn(CHIP, "cursor-help bg-brand-soft text-brand")}>
      <BotIcon aria-hidden className="size-3.5" />
      <span className="sr-only">Written by the AI model</span>
      {figures && <span className="tabular-nums">{figures}</span>}
    </Badge>
  );

  /**
   * Hover, not click. This chip is the one element on the board that a
   * production build would not carry, so it has more explaining to do than any
   * other mark — and making that explanation cost a click is what left it
   * unread.
   *
   * A tooltip rather than the `Tip` popover for a second reason: its trigger
   * does not have to be focusable. On a collapsed row the chip sits inside
   * `AccordionTrigger`, which is a `<button>`, so a popover trigger there would
   * be a button inside a button — which is why that copy of the chip has never
   * had an explanation at all. A plain span carries the pointer handlers with no
   * nesting problem.
   *
   * `explain` therefore no longer means "is it explained" but "can it be reached
   * by keyboard": in the expanded panel the trigger is a real button, so focus
   * opens the panel too.
   */
  const Trigger = explain ? "button" : "span";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Trigger
          {...(explain ? { type: "button" as const, "aria-label": "Model spend" } : {})}
          className="inline-flex rounded-full"
        >
          {chip}
        </Trigger>
      </TooltipTrigger>

      <TooltipContent panel>
        <p className="text-label text-ink">Model spend</p>
        <div className="mt-1.5 flex flex-col gap-2 text-meta leading-relaxed text-ink-muted">
          {BOT_TIP}
          {/* Same guard as above, and for the same reason — undefined is not null. */}
          {usage && (
            <p className="text-ink">
              {formatTokensExact(usage.inputTokens)} in ·{" "}
              {formatTokensExact(usage.outputTokens)} out
              {typeof usage.costMicrosUsd === "number" &&
                ` · ${formatUsdMicros(usage.costMicrosUsd)}`}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function StaleChip() {
  return (
    <Tip
      label="Summary predates newest evidence"
      trigger={
        <Badge className={cn(CHIP, "bg-warn-bg text-warn-fg")}>Summary predates evidence</Badge>
      }
    >
      {STALE_TIP}
    </Tip>
  );
}

export function DegradedChip() {
  return (
    <Tip
      label="Template summary"
      trigger={
        <Badge className={cn(CHIP, "bg-surface text-ink-muted")}>No AI model — template</Badge>
      }
    >
      {DEGRADED_TIP}
    </Tip>
  );
}
