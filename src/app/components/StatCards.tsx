"use client";

import { AlertTriangleIcon, InboxIcon, LoaderIcon, RotateCwIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { QueueCounts } from "@/lib/findings/types";
import { cn } from "@/lib/utils";
import { Tip } from "./Tip";
import { QUEUE_TIPS } from "./tips";

// Defined in lib/, beside the pure function that decides it, and re-exported
// here so existing importers are unaffected.
export type { ConnectionState } from "@/lib/realtime/connection";

/**
 * Job-level counts, as four stat cards.
 *
 * They exist for the work the list cannot show. An event whose job is being
 * retried *before* correlation commits has no finding to badge, so without them
 * the dashboard sits perfectly still while the queue is busy. That is exactly
 * the case the brief singles out: delayed or retried processing has to be
 * distinguishable from a completed result.
 */
export function StatCards({ queue }: { queue: QueueCounts }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat
        label="Queued"
        value={queue.queued}
        icon={<InboxIcon className="size-5" />}
        tone="text-ink"
        iconTone="bg-surface text-ink-muted"
        tip={QUEUE_TIPS.queued}
      />
      <Stat
        label="Analyzing"
        value={queue.analyzing}
        icon={<LoaderIcon className="size-5" />}
        tone="text-warn-fg"
        iconTone="bg-warn-bg text-warn-fg"
        tip={QUEUE_TIPS.analyzing}
      />
      <Stat
        label="Retrying"
        value={queue.retrying}
        icon={<RotateCwIcon className="size-5" />}
        tone="text-warn-fg"
        iconTone="bg-warn-bg text-warn-fg"
        tip={QUEUE_TIPS.retrying}
      />
      <Stat
        label="Failed"
        value={queue.failed}
        icon={<AlertTriangleIcon className="size-5" />}
        tone="text-danger-fg"
        iconTone="bg-danger-bg text-danger-fg"
        tip={QUEUE_TIPS.failed}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  tone,
  iconTone,
  tip,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: string;
  iconTone: string;
  tip: React.ReactNode;
}) {
  return (
    <Card className="flex-row items-center gap-4 rounded-xl border-0 px-5 py-4 shadow-rest">
      <span
        aria-hidden
        className={cn("flex size-11 shrink-0 items-center justify-center rounded-full", iconTone)}
      >
        {icon}
      </span>

      <div className="min-w-0 flex-1">
        {/* Zero counts stay visible rather than disappearing: a header whose
            items come and go is harder to read at a glance than one whose shape
            never changes. They just go quiet. */}
        <p className={cn("text-lead tabular-nums", value > 0 ? tone : "text-ink-subtle")}>
          {value}
        </p>
        <p className="truncate text-meta text-ink-subtle">{label}</p>
      </div>

      <Tip label={label} wide className="-mr-1 self-start">
        {tip}
      </Tip>
    </Card>
  );
}
