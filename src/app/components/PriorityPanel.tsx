"use client";

import { Badge } from "@/components/ui/badge";
import type { Priority, PriorityDriver } from "@/lib/correlation/priority";
import { labelDriverSignal, describeDriverSignal, labelPriority } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DecidingGavelIcon, DriverSignalIcon } from "./icons";
import { Tip } from "./Tip";
import { DECIDING_SIGNAL_TIP } from "./tips";

/**
 * `mark` is the gavel's colour, and it is the level's own hue on purpose.
 *
 * The badge beside it already carries the semantic colour, so any *independent*
 * hue here would read as a second status — one more thing for an operator to
 * decode on a row that already has three. Taking the same colour introduces no
 * new signal at all: it says "this mark belongs to that badge", which is exactly
 * what the mark means. The brand accent was the other candidate and is worse
 * than neutral here — it is what the bot chip wears, so it would put the model's
 * colour on the one panel whose entire claim is that the model had no part in it.
 *
 * What keeps it from reading as a second badge is the absence of a fill: glyph
 * colour at rest, and only the hover surface underneath it.
 */
const LEVEL_STYLES: Record<Priority, { badge: string; icon: string; mark: string }> = {
  critical: {
    badge: "bg-danger-bg text-priority-critical-fg",
    icon: "bg-danger-bg text-priority-critical-fg",
    mark: "text-priority-critical-fg hover:text-priority-critical-fg data-open:text-priority-critical-fg",
  },
  high: {
    badge: "bg-warn-bg text-priority-high-fg",
    icon: "bg-warn-bg text-priority-high-fg",
    mark: "text-priority-high-fg hover:text-priority-high-fg data-open:text-priority-high-fg",
  },
  medium: {
    badge: "bg-warn-bg text-priority-medium-fg",
    icon: "bg-warn-bg text-priority-medium-fg",
    mark: "text-priority-medium-fg hover:text-priority-medium-fg data-open:text-priority-medium-fg",
  },
  low: {
    badge: "bg-surface text-priority-low-fg",
    icon: "bg-surface text-priority-low-fg",
    mark: "text-priority-low-fg hover:text-priority-low-fg data-open:text-priority-low-fg",
  },
};

/**
 * Why a finding has the priority it has.
 *
 * The old version rendered `delay_minutes … sets critical` — the raw signal
 * key, and a phrase that never said what it was setting or why one row mattered
 * more than another. Three things fix that: signals get operator-facing names,
 * the panel states the rule once at the top, and the row that actually decided
 * the outcome is marked rather than left for the reader to infer by scanning
 * for the strongest word.
 *
 * Every value here is computed by `scorePriority` in deterministic code. The
 * model neither sees these rules nor can change them.
 */
export function PriorityPanel({
  drivers,
  priority,
}: {
  drivers: PriorityDriver[];
  priority: Priority | null;
}) {
  if (drivers.length === 0) {
    return (
      <p className="text-body text-ink-subtle">
        No severity threshold was crossed. Every finding is at least low priority.
      </p>
    );
  }

  // The finding's priority is the strongest level any single signal reached, so
  // the first driver at that level is the one that decided it. scorePriority
  // already returns them strongest-first.
  const decidingIndex = priority ? drivers.findIndex((driver) => driver.level === priority) : -1;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-meta leading-relaxed text-ink-subtle">
        Each signal below proposes a priority on its own. The finding takes the highest of
        them — currently{" "}
        <span className="font-semibold text-ink">{labelPriority(priority)}</span>.
      </p>

      {/* Laid out as a row of tiles rather than a stacked list: the signals are
          siblings competing for the same slot, and side by side they read as a
          set to scan rather than a sequence to work through. Wraps to a grid on
          narrow viewports so no tile ever squeezes below readable width. */}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2.5">
        {drivers.map((driver, index) => {
          const style = LEVEL_STYLES[driver.level];
          const deciding = index === decidingIndex;
          const hint = describeDriverSignal(driver.signal);

          return (
            <li
              key={`${driver.signal}-${index}`}
              className={cn(
                "flex flex-col gap-2 rounded-lg px-3 py-2.5 transition-colors",
                // Tinted insets in a white section card, with the deciding one
                // lifted back out to white rather than outlined within the set.
                // Elevation says "this is the one" on a second channel, at no
                // cost in colour — the same job the gavel does in words.
                deciding ? "bg-card shadow-rest" : "bg-surface",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-lg",
                    style.icon,
                  )}
                >
                  <DriverSignalIcon signal={driver.signal} className="size-3.5" />
                </span>

                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {/* Was the words "decided it", which floated with no referent
                      — the reader had to work out both what "it" was and what
                      rule made it so. A gavel says "this one ruled" and carries
                      the rule itself one click away.

                      Not a trophy or a crown: the deciding signal is the worst
                      thing happening to this restaurant, and a mark that
                      congratulates it would be the only celebratory glyph in an
                      otherwise literal icon set. A gavel also cannot be misread
                      as a control that *changes* the priority, which matters
                      because this one is genuinely clickable. */}
                  {deciding && (
                    <Tip
                      label="Deciding signal"
                      icon={<DecidingGavelIcon className="size-5" />}
                      wide
                      // As large as the row can carry: size-7 is exactly the
                      // signal tile at the other end of the row, so the line is
                      // bracketed by two 28px marks and stays balanced. Going
                      // further would make the mark taller than the row's own
                      // text block and start driving the tile's height.
                      className={cn("size-7", style.mark)}
                    >
                      {DECIDING_SIGNAL_TIP}
                    </Tip>
                  )}
                  <Badge
                    className={cn("h-6 px-2.5 text-meta", style.badge)}
                    title={hint ?? undefined}
                  >
                    {labelPriority(driver.level)}
                  </Badge>
                </span>
              </div>

              <div className="min-w-0">
                <p className="text-label text-ink">{labelDriverSignal(driver.signal)}</p>
                <p className="text-meta text-ink-subtle">{driver.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
