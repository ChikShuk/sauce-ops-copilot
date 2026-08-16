"use client";

import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { deriveCardState } from "@/lib/findings/cardState";
import type { FindingCard as FindingCardData } from "@/lib/findings/types";
import { cn } from "@/lib/utils";
import type { ActionResult } from "./ActionBar";
import { BotChip, PriorityLabel, RetryChip, StatusBadge, priorityRail } from "./Badges";
import { DriversLine } from "./DriversLine";
import { FindingBody } from "./FindingBody";
import { TimeAgo } from "./TimeAgo";
import { formatRestaurant, labelOrder, labelTag } from "@/lib/format";

/**
 * One finding, collapsed to a scannable row and expanding in place.
 *
 * Three content rules the full-width layout made obvious, and which the old
 * two-pane card got wrong:
 *
 *   1. The restaurant id is metadata, not a heading. Ids are caller-supplied
 *      and can be 41 characters (`rest_<uuid>` from the test factories), which
 *      is wide enough to crowd out the issue beside it. It is truncated and
 *      demoted below the title, with the full value on `title`.
 *   2. The title gets the row's full width and clamps to two lines rather than
 *      truncating mid-word on one.
 *   3. When there is no title, the placeholder does not inherit its prominence.
 *      An un-enriched finding used to lead with "Queued for analysis…" in the
 *      largest type on the row; now the drivers line takes that slot and the
 *      placeholder drops to metadata.
 *
 * Nothing inside AccordionTrigger may be interactive — it is itself a button,
 * and a nested one is invalid HTML that breaks hydration. That is why the
 * status, priority and retry marks here carry no popovers; their explanations
 * live in the expanded body and in the header's legend.
 */
export function FindingRow({
  finding,
  highlighted,
  rewriteEnabled,
  onActionRecorded,
}: {
  finding: FindingCardData;
  highlighted: boolean;
  rewriteEnabled: boolean;
  onActionRecorded: (result: ActionResult) => void;
}) {
  const presentation = deriveCardState(finding);
  const untitled = finding.issue === null;
  const restaurant = formatRestaurant(finding.restaurantId);

  return (
    <AccordionItem
      value={finding.id}
      className={cn(
        "relative overflow-hidden rounded-xl border-0 bg-card shadow-rest transition-shadow",
        "hover:shadow-lift has-data-open:shadow-lift",
        // Reviewed means triaged, not finished — it stays in the list and keeps
        // its position, just quieter. Resolved findings are moved out entirely.
        finding.reviewedAt !== null && finding.resolvedAt === null && "opacity-70",
        highlighted && "row-changed",
      )}
    >
      <span
        aria-hidden
        className={cn("absolute inset-y-0 left-0 w-1", priorityRail(finding.priority))}
      />

      <AccordionTrigger className="items-center gap-4 rounded-none py-4 pl-6 pr-5 hover:no-underline">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {untitled ? (
            <>
              <DriversLine drivers={finding.drivers} prominent />
              <p className="text-meta text-ink-subtle">{presentation.placeholder}</p>
            </>
          ) : (
            <>
              <h3 className="line-clamp-2 text-headline text-ink">{finding.issue}</h3>
              <DriversLine drivers={finding.drivers} />
            </>
          )}

          <p className="flex flex-wrap items-center gap-x-2 text-meta font-normal text-ink-subtle">
            <PriorityLabel priority={finding.priority} />
            <span aria-hidden>·</span>
            <span
              title={finding.restaurantId}
              className={cn("text-ink-muted", restaurant.opaque && "font-mono")}
            >
              {restaurant.name}
            </span>
            {restaurant.note && <span className="text-ink-subtle">({restaurant.note})</span>}
            {finding.orderId && (
              <>
                <span aria-hidden>·</span>
                <span>{labelOrder(finding.orderId)}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>
              {finding.eventCount} {finding.eventCount === 1 ? "event" : "events"}
            </span>
            <span aria-hidden>·</span>
            <TimeAgo iso={finding.lastEventAt} />
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Sits with the status cluster rather than in the metadata line: it
              answers "was a model involved, and what did it cost", which is a
              property of the summary, like status is.

              The exception to the no-popover rule above: this one explains
              itself on hover, through a tooltip whose trigger is a span rather
              than a button. Nothing focusable is added, so the nesting rule
              still holds. Without `explain` it is hover-only here; the expanded
              copy adds keyboard focus. */}
          {presentation.modelWritten && <BotChip usage={finding.llmUsage} />}
          {finding.extractedTags.slice(0, 2).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="hidden h-6 px-2 text-meta font-normal text-ink-muted lg:inline-flex"
            >
              {labelTag(tag)}
            </Badge>
          ))}
          {finding.resolvedAt !== null && (
            <Badge variant="secondary" className="h-6 px-2 text-meta font-normal text-ink-subtle">
              Resolved
            </Badge>
          )}
          {finding.reviewedAt !== null && finding.resolvedAt === null && (
            <Badge variant="secondary" className="h-6 px-2 text-meta font-normal text-ink-subtle">
              Reviewed
            </Badge>
          )}
          {/* Retry carries a live countdown, so it is worth seeing without
              expanding. It renders without its popover here for the nesting
              reason above; the explained version is in the body. */}
          {presentation.retry && <RetryChip retry={presentation.retry} />}
          <StatusBadge presentation={presentation} />
        </div>
      </AccordionTrigger>

      <AccordionContent className="p-0">
        <FindingBody
          card={finding}
          rewriteEnabled={rewriteEnabled}
          onActionRecorded={onActionRecorded}
        />
      </AccordionContent>
    </AccordionItem>
  );
}
