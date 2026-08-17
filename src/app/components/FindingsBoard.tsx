"use client";

import { useEffect, useRef, useState } from "react";
import { MenuIcon } from "lucide-react";
import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { applyBoardMessage } from "@/lib/findings/boardPayload";
import type { Board, FindingCard as FindingCardData, QueueCounts } from "@/lib/findings/types";
import { logJson } from "@/lib/log";
import {
  INITIAL_STREAM_HEALTH,
  deriveConnectionState,
  type StreamHealth,
} from "@/lib/realtime/connection";
import type { ProviderToggleState } from "@/lib/settings/types";
import { cn } from "@/lib/utils";
import type { ActionResult } from "./ActionBar";
import { AppSidebar, type BoardView } from "./AppSidebar";
import { EmptyBoard, EmptyResolved } from "./EmptyStates";
import { FindingRow } from "./FindingRow";
import { StatCards, type ConnectionState } from "./StatCards";
import { TimeAgo } from "./TimeAgo";
import { Tip } from "./Tip";
import { BOARD_LEGEND_TIP, STALE_STREAM_TIP } from "./tips";
import { useNow } from "./useNow";

// How long a changed row stays highlighted. Matches the CSS animation in
// globals.css; the timer only controls when the class comes off.
const HIGHLIGHT_MS = 2_500;

// `stale` borrows the danger hue rather than warn, which reconnecting already
// holds. A retrying transport is a wait; a board that has stopped updating
// while looking fine is a thing to act on, and the two must not read as
// degrees of the same problem.
const CONNECTION_STYLES: Record<ConnectionState, { className: string; label: string }> = {
  connecting: { className: "bg-surface text-ink-muted", label: "Connecting" },
  live: { className: "bg-ok-bg text-ok-fg", label: "Live" },
  reconnecting: { className: "bg-warn-bg text-warn-fg", label: "Reconnecting" },
  stale: { className: "bg-danger-bg text-danger-fg", label: "Not updating" },
};

export function FindingsBoard({
  initialFindings,
  initialQueue,
  demoFailureEnabled,
  providerToggle,
}: {
  initialFindings: FindingCardData[];
  initialQueue: QueueCounts;
  demoFailureEnabled: boolean;
  providerToggle: ProviderToggleState;
}) {
  // One object, not two pieces of state, so a rejected payload can be dropped
  // by leaving the reference untouched — see applyBoardMessage.
  const [board, setBoard] = useState<Board>({
    findings: initialFindings,
    queue: initialQueue,
  });
  // Raw observations about the stream. What they *mean* is decided by
  // deriveConnectionState, so the rule lives in a pure function next to its
  // test rather than spread across four event listeners.
  const [health, setHealth] = useState<StreamHealth>(INITIAL_STREAM_HEALTH);
  const [view, setView] = useState<BoardView>("active");
  // The accordion's own open value. One row at a time: two expanded findings
  // means neither is readable without scrolling past the other.
  const [openId, setOpenId] = useState<string>("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  // Applied locally the moment an action succeeds, because waiting for the next
  // poll would leave up to a second of nothing after a click. Safe here for a
  // reason specific to this build: every SSE message is a complete board, so
  // there is no patch to merge and local state cannot drift permanently.
  const [optimistic, setOptimistic] = useState<Map<string, ActionResult>>(new Map());

  // Mirrors `board` for the stream handler, which needs the current value to
  // decide whether to keep it. Safe as a mirror because the handler is the only
  // thing that ever writes either one.
  const boardRef = useRef(board);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const source = new EventSource("/api/stream");

    source.addEventListener("open", () =>
      setHealth((current) => ({ ...current, transport: "live" })),
    );

    // Proof the server is still there when the board simply has no news. The
    // broadcaster emits only on change, so without this a quiet Tuesday and a
    // hung server produce exactly the same silence.
    source.addEventListener("heartbeat", () =>
      setHealth((current) => ({ ...current, transport: "live", lastSignalAt: Date.now() })),
    );

    // Every message is a complete board, so a reconnect and a routine update
    // are handled by the same line of code. There is no "catch up on what I
    // missed" path because there is nothing that can be missed.
    source.addEventListener("board", (event) => {
      // Validated, not asserted. A payload missing a field is refused whole and
      // the last good board stands — `update.board` is then the very object
      // already in state, so React bails out on identity and nothing
      // re-renders. There is no path that paints half of a bad board.
      //
      // Dropping a message costs a second of staleness and nothing else, which
      // is only true because every message is a complete board rather than a
      // patch. The ref carries the current board in: a state updater has to stay
      // pure, and this handler is the only writer of it.
      const update = applyBoardMessage(boardRef.current, (event as MessageEvent<string>).data);
      boardRef.current = update.board;
      setBoard(update.board);

      const rejected = update.problems.length > 0;
      const at = Date.now();
      setHealth((current) => ({
        transport: "live",
        // A message arrived, so the pipe is alive whether or not its contents
        // were usable. That is precisely the distinction the indicator draws.
        lastSignalAt: at,
        lastGoodBoardAt: rejected ? current.lastGoodBoardAt : at,
        lastPayloadRejected: rejected,
      }));

      if (rejected) {
        // The same one-JSON-object-per-line shape the worker logs in, so a
        // browser console and a server log read alike. Field paths and finding
        // ids, because "a board was rejected" is not diagnosable and
        // "findings[3].resolvedAt (finding 8f2c…) was missing" is.
        logJson({ msg: "board.payload_rejected", problems: update.problems });
        return;
      }

      // Clear an overlay only once the server confirms the field is set, not on
      // the next message unconditionally. A snapshot polled between the click
      // and the commit would otherwise flick the row back to unresolved.
      setOptimistic((current) => {
        if (current.size === 0) return current;

        const next = new Map(current);
        for (const finding of update.board.findings) {
          const pending = next.get(finding.id);
          if (!pending) continue;

          const reviewedSettled =
            pending.reviewedAt === null || finding.reviewedAt !== null;
          const resolvedSettled =
            pending.resolvedAt === null || finding.resolvedAt !== null;

          if (reviewedSettled && resolvedSettled) next.delete(finding.id);
        }
        return next.size === current.size ? current : next;
      });

      if (update.changed.length > 0) {
        setHighlighted((current) => new Set([...current, ...update.changed]));

        for (const id of update.changed) {
          clearTimeout(timers.current.get(id));
          timers.current.set(
            id,
            setTimeout(() => {
              setHighlighted((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
              });
              timers.current.delete(id);
            }, HIGHLIGHT_MS),
          );
        }
      }
    });

    // EventSource reconnects on its own; this only reflects that in the UI so a
    // stalled dashboard never looks like a quiet one.
    source.addEventListener("error", () =>
      setHealth((current) => ({ ...current, transport: "reconnecting" })),
    );

    const pending = timers.current;
    return () => {
      source.close();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const merged = board.findings.map((finding) => {
    const pending = optimistic.get(finding.id);
    return pending
      ? {
          ...finding,
          reviewedAt: pending.reviewedAt ?? finding.reviewedAt,
          resolvedAt: pending.resolvedAt ?? finding.resolvedAt,
        }
      : finding;
  });

  // Partitioned on resolvedAt, never on closedAt. Resolving sets both, but a
  // finding whose rolling window merely lapsed also has closedAt set and is
  // history an operator should still see — filtering on it would silently hide
  // every past finding on the board (docs/decisions.md).
  //
  // Client-side, so the SQL ordering stays the single source of sort order.
  const active = merged.filter((finding) => finding.resolvedAt === null);
  const resolved = merged.filter((finding) => finding.resolvedAt !== null);
  const shown = view === "active" ? active : resolved;

  const selected = merged.find((finding) => finding.id === openId) ?? null;
  // One second is the resolution the rest of the board already ticks at, and
  // this needs a clock only so staleness arrives on its own rather than waiting
  // for the next message \u2014 which, on a stalled stream, is the one thing that
  // never comes.
  const now = useNow(1_000);
  const connection = deriveConnectionState(health, now);
  const connectionStyle = CONNECTION_STYLES[connection];

  const connectionBadge = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-meta font-medium",
        connectionStyle.className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full bg-current", connection === "live" && "animate-pulse")}
      />
      {connectionStyle.label}
    </span>
  );

  function applyAction(findingId: string, result: ActionResult) {
    setOptimistic((current) => new Map(current).set(findingId, result));
  }

  const sidebarProps = {
    view,
    onViewChange: (next: BoardView) => {
      setView(next);
      setOpenId("");
      setDrawerOpen(false);
    },
    activeCount: active.length,
    resolvedCount: resolved.length,
    selected,
    // The board is sorted priority-first, so this is the top row rather than
    // the newest one — which is the right fallback anyway: it is what the
    // operator is looking at when they haven't opened anything.
    fallbackFinding: board.findings[0] ?? null,
    demoFailureEnabled,
    providerToggle,
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* The rail is a floating panel, not a wall: it stops short of the top and
          bottom edges and sits inset from the left, so the rounding and the
          shadow have canvas to read against. The outer div keeps the 18rem
          column the layout was built around and adds the gutter around it. */}
      <div className="hidden h-full w-[19.5rem] shrink-0 items-center px-3 md:flex">
        <AppSidebar
          {...sidebarProps}
          className="h-[97%] min-h-0 overflow-hidden rounded-3xl shadow-lift"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 px-6 pb-2 pt-6">
          <div className="flex min-w-0 items-center gap-3">
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Open menu"
                  className="shrink-0 bg-card md:hidden"
                >
                  <MenuIcon />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 max-w-[85vw] p-0">
                <SheetTitle className="sr-only">Navigation and event simulator</SheetTitle>
                <AppSidebar {...sidebarProps} className="h-full" />
              </SheetContent>
            </Sheet>

            <div className="flex min-w-0 items-center gap-1.5">
              <h1 className="truncate text-lead text-ink">
                {view === "active" ? "Findings" : "Resolved findings"}
              </h1>
              <Tip label="How to read this board" wide>
                {BOARD_LEGEND_TIP}
              </Tip>
            </div>
          </div>

          {/* Only the stale badge carries an explanation, because it is the
              only one whose meaning is not self-evident: "Live" and
              "Reconnecting" say what they are, while a board that has stopped
              updating needs to say what stopped and when it last worked. */}
          {connection === "stale" ? (
            <Tip label="Updates have stopped" trigger={connectionBadge} wide>
              {STALE_STREAM_TIP}
              <p className="text-ink">
                {health.lastGoodBoardAt === null ? (
                  "No usable board has arrived on this connection."
                ) : (
                  <>
                    Last good update <TimeAgo iso={new Date(health.lastGoodBoardAt).toISOString()} />.
                  </>
                )}
              </p>
            </Tip>
          ) : (
            connectionBadge
          )}
        </header>

        {/* Pinned with the header, so the list is the only thing that moves.
            This reverses an earlier call — the cards used to scroll with the
            list, on the reasoning that an expanded row is tall and pinned chrome
            eats the space it needs. That reasoning was not wrong; it is
            outweighed now the expanded panel is four stacked cards, where losing
            the queue counts means losing them for the whole time you are reading
            one finding.

            It costs about 110px of viewport permanently. If that bites, the next
            lever is a shorter stat card — py-3 and a size-9 icon takes it to
            roughly 56px — rather than giving the pinning back. */}
        <div className="shrink-0 px-6 pb-4 pt-4">
          <StatCards queue={board.queue} />
        </div>

        {/* The one scroll container. Everything above it is fixed chrome. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
          {shown.length === 0 ? (
            view === "active" ? (
              <EmptyBoard hasResolved={resolved.length > 0} />
            ) : (
              <EmptyResolved />
            )
          ) : (
            <Accordion
              type="single"
              collapsible
              value={openId}
              onValueChange={setOpenId}
              className="gap-3"
            >
              {shown.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  highlighted={highlighted.has(finding.id)}
                  rewriteEnabled={providerToggle.enabled}
                  onActionRecorded={(result) => applyAction(finding.id, result)}
                />
              ))}
            </Accordion>
          )}
        </div>
      </div>
    </div>
  );
}
