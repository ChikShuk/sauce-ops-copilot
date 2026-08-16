"use client";

import { CheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EvidenceItem } from "@/lib/findings/types";
import { cn } from "@/lib/utils";
import { TimeAgo } from "./TimeAgo";
import { Tip } from "./Tip";
import { CITED_TIP } from "./tips";
import {
  formatMoney,
  formatUtcMoment,
  labelEventType,
  labelIssueClass,
} from "@/lib/format";
import { EventTypeIcon } from "./icons";

function facts(item: EvidenceItem): string[] {
  const values: string[] = [];
  if (item.delayMinutes !== null) values.push(`${item.delayMinutes} min late`);
  if (item.rating !== null) values.push(`${item.rating}★`);
  if (item.refundAmountCents !== null) values.push(formatMoney(item.refundAmountCents));
  return values;
}

/**
 * Every event behind the finding, assembled from finding_events — never from
 * model output.
 *
 * The E1..En labels are the same ones the evidence was handed to the model
 * under, so a citation lines up against the row it points at. `cited` marks the
 * events the summary actually rests on; it is absent on fallback rows because
 * the fallback writer records no citations rather than claiming all of them.
 */
export function EvidenceTable({
  evidence,
  hasCitations,
}: {
  evidence: EvidenceItem[];
  hasCitations: boolean;
}) {
  if (evidence.length === 0) {
    return <p className="text-body text-ink-subtle">No evidence attached.</p>;
  }

  return (
    /**
     * Soft bands rather than a grid. `border-separate` with vertical spacing
     * turns each row into its own rounded, tinted band — the same visual
     * language as the recommended actions and the priority tiles, so the three
     * sections of the panel read as one system.
     *
     * Still a real table, deliberately. Evidence is the one section a reader
     * scans *down*: with six or eight events you want signals and timestamps
     * lining up so they can be compared, and a list of cards throws that away
     * for a difference nobody can see at two rows. It also keeps the markup
     * tabular for a screen reader, and keeps design-principles §0 — the shadcn
     * component stays the component.
     */
    <div className="-my-2">
      <Table className="border-separate border-spacing-y-2">
        {/* No tint bar and no rule under it: at this size the four labels are a
            caption for the columns, not a header band. */}
        <TableHeader className="[&_tr]:border-0">
          <TableRow className="border-0 hover:bg-transparent">
            <TableHead className="h-auto w-14 pb-0 pl-5 text-meta font-normal text-ink-subtle">
              #
            </TableHead>
            <TableHead className="h-auto pb-0 text-meta font-normal text-ink-subtle">
              Event
            </TableHead>
            <TableHead className="h-auto w-32 pb-0 text-meta font-normal text-ink-subtle">
              Signal
            </TableHead>
            <TableHead className="h-auto w-28 pb-0 pr-5 text-right text-meta font-normal text-ink-subtle">
              When
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {evidence.map((item) => {
            const cited = item.cited && hasCitations;

            return (
              <TableRow
                key={item.id}
                className={cn(
                  // Rounding lands on the end cells because a <tr> cannot carry
                  // a radius under border-separate.
                  "border-0 transition-colors [&>td:first-child]:rounded-l-xl [&>td:last-child]:rounded-r-xl",
                  cited ? "bg-ok-bg hover:bg-ok-bg" : "bg-surface hover:bg-surface-hover",
                )}
              >
                <TableCell className="relative py-4 pl-5 align-top font-mono text-meta text-ink-subtle">
                  {/* The cited rows carry an accent as well as a tint, so the
                      distinction survives greyscale and a colourblind eye. A
                      short rounded bar tucked inside the band rather than a
                      full-bleed rule down its edge — same signal, no hard
                      corner cutting the row. */}
                  {cited && (
                    <span
                      aria-hidden
                      className="absolute left-2 top-4 h-4 w-1 rounded-full bg-ok-fg"
                    />
                  )}
                  {item.label}
                </TableCell>

                <TableCell className="py-4 align-top whitespace-normal">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface text-ink-muted"
                    >
                      <EventTypeIcon eventType={item.eventType} className="size-3.5" />
                    </span>
                    <span className="text-body font-medium text-ink">
                      {labelEventType(item.eventType)}
                    </span>

                    {item.issueClass !== item.eventType && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="secondary"
                            className="h-5 cursor-help px-2 text-meta font-normal text-ink-muted"
                          >
                            {labelIssueClass(item.issueClass)}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          Deterministic root-cause class, derived from structured fields only
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {cited && (
                      <Tip
                        label="Cited by the summary"
                        trigger={
                          // A white chip on the green band rather than a solid
                          // green pill: the row already carries the state, so
                          // this only has to name it.
                          <Badge className="h-5 gap-1 bg-card px-2 text-meta font-normal text-ok-fg">
                            <CheckIcon className="size-3" />
                            cited
                          </Badge>
                        }
                      >
                        {CITED_TIP}
                      </Tip>
                    )}
                  </div>

                  {/* Customer-authored text. Rendered as text, never as markup —
                      the same input the prompt builder fences as data. */}
                  {item.customerText && (
                    <p className="mt-2 rounded-md border-l-2 border-line bg-card/70 py-1.5 pl-2.5 pr-2 text-body text-ink-muted">
                      {item.customerText}
                    </p>
                  )}

                  {/* Truncated by CSS, not by slicing: a 45-character id under a
                      three-word event name was the loudest thing in the row, and
                      an ellipsis quiets it without losing the value — the full
                      string is still in the DOM, so selecting it copies all of
                      it, and `title` shows it on hover. */}
                  <p
                    className="mt-2.5 max-w-[26ch] truncate font-mono text-meta text-ink-subtle"
                    title={item.clientEventId}
                  >
                    {item.clientEventId}
                  </p>
                </TableCell>

                <TableCell className="py-4 align-top text-body text-ink-muted">
                  {facts(item).join(" · ") || <span className="text-ink-subtle">—</span>}
                </TableCell>

                <TableCell
                  className="py-4 pr-5 text-right align-top text-meta whitespace-nowrap text-ink-subtle"
                  title={formatUtcMoment(item.occurredAt)}
                >
                  <TimeAgo iso={item.occurredAt} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
