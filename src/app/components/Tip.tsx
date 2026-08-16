"use client";

import { InfoIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The dashboard's explanation layer: one popover, used everywhere a control or
 * a status needs to say what it is.
 *
 * It exists because a reviewer opening the board cold cannot tell what
 * `Retry 2/5`, a `cited` marker or the drivers line mean, and the README is not
 * what they are looking at. Explaining the product on the screen is worth more
 * than explaining it in a document. The copy lives in `tips.tsx`.
 *
 * This replaced a hand-rolled popover that reimplemented fixed positioning,
 * collision flipping, outside-click, Escape, focus return and scroll handling —
 * roughly 150 lines that Radix already does correctly, including the two bugs
 * the hand-rolled version shipped with (a long tip closing itself on its own
 * scroll, and a cascading render on close).
 */
export function Tip({
  label,
  wide = false,
  trigger,
  icon,
  className,
  children,
}: {
  /** Names the tip for screen readers and heads the panel. */
  label: string;
  wide?: boolean;
  /**
   * Render the tip on an existing element — a chip becomes its own trigger
   * rather than growing an icon beside it. Omit for the default ⓘ button.
   */
  trigger?: React.ReactNode;
  /**
   * Swap the glyph inside the default button, keeping its shape, hover, focus
   * and open states. For marks that are not "here is more information" — the
   * gavel on the deciding priority signal, say — where the affordance should
   * still read as a button rather than as the `trigger` branch's cursor-help.
   */
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ? (
          <button
            type="button"
            aria-label={`${label} — more information`}
            className={cn("cursor-help rounded-sm", className)}
          >
            {trigger}
          </button>
        ) : (
          <button
            type="button"
            aria-label={`About ${label}`}
            // cursor-pointer for the reason recorded in ui/button.tsx: Tailwind
            // v4 leaves buttons on the default arrow, which made every ⓘ on the
            // board look like decoration.
            className={cn(
              "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-surface hover:text-ink data-open:bg-surface-hover data-open:text-ink",
              className,
            )}
          >
            {icon ?? <InfoIcon className="size-3.5" />}
          </button>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="start"
        collisionPadding={12}
        className={cn(
          "max-h-[min(70vh,32rem)] gap-0 overflow-y-auto p-3.5 shadow-pop",
          wide && "w-96",
        )}
      >
        <p className="text-label text-ink">{label}</p>
        <div className="mt-1.5 flex flex-col gap-2 text-meta leading-relaxed text-ink-muted">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}
