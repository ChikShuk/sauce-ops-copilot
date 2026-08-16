"use client";

import { CircleCheckIcon, LayersIcon } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { FindingCard } from "@/lib/findings/types";
import type { ProviderToggleState } from "@/lib/settings/types";
import { cn } from "@/lib/utils";
import { SimulatorPanel } from "./SimulatorPanel";

export type BoardView = "active" | "resolved";

/**
 * The permanent left rail: product identity, the two views of the board, and
 * every control that puts an event into the system.
 *
 * The simulator lives here rather than in a toolbar above the list, and the
 * reason is arithmetic. It carries nine triggers, a restaurant input, a JSON
 * escape hatch and an activity log. A toolbar would either wrap those onto
 * several rows — competing with the stat cards for the vertical space the list
 * needs — or collapse them behind a dropdown, which puts every trigger two
 * clicks away instead of one. The sidebar is already persistent and has room
 * below two nav items, and keeping it there leaves the list its full width,
 * which is the entire point of dropping the two-pane split.
 */
export function AppSidebar({
  view,
  onViewChange,
  activeCount,
  resolvedCount,
  selected,
  fallbackFinding,
  demoFailureEnabled,
  providerToggle,
  className,
}: {
  view: BoardView;
  onViewChange: (view: BoardView) => void;
  activeCount: number;
  resolvedCount: number;
  selected: FindingCard | null;
  fallbackFinding: FindingCard | null;
  demoFailureEnabled: boolean;
  providerToggle: ProviderToggleState;
  /** Shape and elevation belong to the caller: on desktop this is a floating
   *  rounded panel, inside the mobile Sheet it is a flush full-height pane. */
  className?: string;
}) {
  // pb-3 insets the scroll region from the card's bottom edge, so content cut
  // off mid-scroll — an activity entry, usually — is clipped a few pixels short
  // of the rounding rather than running into it. Padding inside the scrollport
  // only pads the *end* of the content and does nothing for the clip line, which
  // is why this sits on the outer container.
  return (
    <div className={cn("flex min-h-0 w-full flex-col bg-card pb-3", className)}>
      <div className="flex shrink-0 items-center gap-3 px-5 pb-5 pt-6">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-ink text-lead leading-none text-card"
        >
          S
        </span>
        <div className="min-w-0">
          <p className="truncate text-lead text-ink">Sauce Ops</p>
          <p className="truncate text-meta text-ink-subtle">Operations copilot</p>
        </div>
      </div>

      <nav className="flex shrink-0 flex-col gap-1 px-3">
        <NavItem
          active={view === "active"}
          count={activeCount}
          icon={<LayersIcon className="size-4" />}
          onClick={() => onViewChange("active")}
        >
          Findings
        </NavItem>
        <NavItem
          active={view === "resolved"}
          count={resolvedCount}
          icon={<CircleCheckIcon className="size-4" />}
          onClick={() => onViewChange("resolved")}
        >
          Resolved
        </NavItem>
      </nav>

      <Separator className="my-5 shrink-0 bg-line" />

      {/* min-h-0 is what lets this shrink below its content so the overflow
          engages — without it the column grows to fit the activity log and the
          whole sidebar stops scrolling. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <SimulatorPanel
          selected={selected}
          fallbackFinding={fallbackFinding}
          demoFailureEnabled={demoFailureEnabled}
          providerToggle={providerToggle}
        />
      </div>
    </div>
  );
}

function NavItem({
  active,
  count,
  icon,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-label transition-colors",
        active
          ? "bg-brand text-brand-fg"
          : "text-ink-muted hover:bg-surface hover:text-ink",
      )}
    >
      <span aria-hidden className="shrink-0">
        {icon}
      </span>
      <span className="flex-1 text-left">{children}</span>
      <span className={cn("tabular-nums", active ? "text-brand-fg/80" : "text-ink-subtle")}>
        {count}
      </span>
    </button>
  );
}
