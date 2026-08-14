"use client";

import { deriveCardState } from "@/lib/findings/cardState";
import type { FindingCard as FindingCardData } from "@/lib/findings/types";
import {
  DegradedChip,
  PriorityBadge,
  RetryChip,
  StaleChip,
  StatusPill,
  priorityRail,
} from "./Badges";
import { DriversLine } from "./DriversLine";
import { TimeAgo } from "./TimeAgo";
import { labelTag } from "./format";

/**
 * The collapsed card. Everything on it except the title and the tags is written
 * by deterministic code.
 *
 * The summary is deliberately NOT here. Keeping the prose one click away is the
 * structural version of "the model supports the facts rather than leading
 * them" — it holds regardless of type sizes, and it means the three-second scan
 * happens entirely over things the system knows to be true.
 */
export function FindingCard({
  finding,
  selected,
  highlighted,
  onSelect,
}: {
  finding: FindingCardData;
  selected: boolean;
  highlighted: boolean;
  onSelect: () => void;
}) {
  const presentation = deriveCardState(finding);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={`flex w-full gap-3 border-b border-zinc-800 p-3 text-left transition-colors hover:bg-zinc-900 ${
        selected ? "bg-zinc-900" : ""
      } ${highlighted ? "card-changed" : ""}`}
    >
      <span
        aria-hidden
        className={`w-1 shrink-0 rounded-full ${priorityRail(finding.priority)}`}
      />

      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-2">
            <PriorityBadge priority={finding.priority} />
            <span className="truncate text-xs text-zinc-400">
              {finding.restaurantId}
              {finding.orderId && ` · order ${finding.orderId}`}
            </span>
          </span>
          <StatusPill presentation={presentation} />
        </span>

        {/* Model-written, and the most visually dominant element on the card.
            That tension is deliberate: naming the pattern is where the model
            earns its place, and a board headed by raw metrics reads as a log.
            The drivers line below carries equal weight as the counterbalance. */}
        <span className="mt-1.5 block truncate text-[15px] font-medium text-zinc-50">
          {finding.issue ?? (
            <span className="font-normal text-zinc-500">{presentation.placeholder}</span>
          )}
        </span>

        <span className="mt-0.5 block">
          <DriversLine drivers={finding.drivers} />
        </span>

        <span className="mt-2 flex flex-wrap items-center gap-1.5">
          {presentation.retry && <RetryChip retry={presentation.retry} />}
          {presentation.staleProse && <StaleChip />}
          {presentation.degraded && <DegradedChip />}

          {/* Model-extracted, drives nothing, and sized to say so. */}
          {finding.extractedTags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400"
            >
              {labelTag(tag)}
            </span>
          ))}

          <span className="ml-auto shrink-0 text-[11px] text-zinc-500">
            {finding.eventCount} {finding.eventCount === 1 ? "event" : "events"} ·{" "}
            <TimeAgo iso={finding.lastEventAt} />
          </span>
        </span>
      </span>
    </button>
  );
}
