"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardMessage } from "@/lib/realtime/broadcaster";
import type { FindingCard as FindingCardData, QueueCounts } from "@/lib/findings/types";
import type { ActionResult } from "./ActionBar";
import { DetailPanel } from "./DetailPanel";
import { EmptyBoard, NoSelection } from "./EmptyStates";
import { FindingCard } from "./FindingCard";
import { QueueHealth, type ConnectionState } from "./QueueHealth";
import { SimulatorPanel } from "./SimulatorPanel";

// How long a changed card stays highlighted. Matches the CSS animation in
// globals.css; the timer only controls when the class comes off.
const HIGHLIGHT_MS = 2_500;

export function FindingsBoard({
  initialFindings,
  initialQueue,
  demoFailureEnabled,
}: {
  initialFindings: FindingCardData[];
  initialQueue: QueueCounts;
  demoFailureEnabled: boolean;
}) {
  const [findings, setFindings] = useState(initialFindings);
  const [queue, setQueue] = useState(initialQueue);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  // Open on an empty board, because there it *is* the empty state's call to
  // action. Collapsed once there are findings, so it doesn't eat board height
  // for someone who is reading rather than generating.
  const [simulatorOpen, setSimulatorOpen] = useState(initialFindings.length === 0);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  // Applied locally the moment an action succeeds, because waiting for the next
  // poll would leave up to a second of nothing after a click. Safe here for a
  // reason specific to this build: every SSE message is a complete board, so
  // there is no patch to merge and local state cannot drift permanently.
  const [optimistic, setOptimistic] = useState<Map<string, ActionResult>>(new Map());

  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const source = new EventSource("/api/stream");

    source.addEventListener("open", () => setConnection("live"));

    // Every message is a complete board, so a reconnect and a routine update
    // are handled by the same line of code. There is no "catch up on what I
    // missed" path because there is nothing that can be missed.
    source.addEventListener("board", (event) => {
      const message = JSON.parse((event as MessageEvent<string>).data) as BoardMessage;
      setConnection("live");
      setFindings(message.findings);
      setQueue(message.queue);

      // Clear an overlay only once the server confirms the field is set, not on
      // the next message unconditionally. A snapshot polled between the click
      // and the commit would otherwise flick the card back to unresolved.
      setOptimistic((current) => {
        if (current.size === 0) return current;

        const next = new Map(current);
        for (const finding of message.findings) {
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

      if (message.changed.length > 0) {
        setHighlighted((current) => new Set([...current, ...message.changed]));

        for (const id of message.changed) {
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
    source.addEventListener("error", () => setConnection("reconnecting"));

    const pending = timers.current;
    return () => {
      source.close();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const merged = findings.map((finding) => {
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

  const selected = merged.find((finding) => finding.id === selectedId) ?? null;

  function applyAction(findingId: string, result: ActionResult) {
    setOptimistic((current) => new Map(current).set(findingId, result));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <QueueHealth queue={queue} connection={connection} />

      <SimulatorPanel
        open={simulatorOpen}
        onToggle={() => setSimulatorOpen((current) => !current)}
        selected={selected}
        // The board is sorted priority-first, so this is the top card rather
        // than the newest one — which is the right fallback anyway: it is what
        // the operator is looking at when they haven't clicked anything.
        fallbackFinding={findings[0] ?? null}
        demoFailureEnabled={demoFailureEnabled}
      />

      {findings.length === 0 ? (
        // Takes over both panes rather than sitting in the 416px list column.
        // A curl command wrapped into that width is unreadable, and the screen
        // a reviewer meets first shouldn't be mostly empty gutter.
        <EmptyBoard />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Each pane owns its own scrollbar. min-h-0 is what lets a flex
              child shrink below its content — without it the pane grows to fit
              every card and the overflow never engages. */}
          <div className="min-h-0 w-full shrink-0 overflow-y-auto md:w-[26rem]">
            {active.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                selected={finding.id === selectedId}
                highlighted={highlighted.has(finding.id)}
                onSelect={() =>
                  setSelectedId((current) => (current === finding.id ? null : finding.id))
                }
              />
            ))}

            {/* Resolved work leaves the working list but stays findable. Making
                it vanish outright would make the action feel irreversible and
                would take away the only evidence that anything happened. */}
            {resolved.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setResolvedOpen((open) => !open)}
                  aria-expanded={resolvedOpen}
                  className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-xs text-ink-subtle hover:bg-surface"
                >
                  <span aria-hidden>{resolvedOpen ? "▾" : "▸"}</span>
                  Resolved ({resolved.length})
                </button>

                {resolvedOpen &&
                  resolved.map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      selected={finding.id === selectedId}
                      highlighted={highlighted.has(finding.id)}
                      onSelect={() =>
                        setSelectedId((current) =>
                          current === finding.id ? null : finding.id,
                        )
                      }
                    />
                  ))}
              </div>
            )}
          </div>

          <div className="hidden min-h-0 min-w-0 flex-1 md:block">
            {selected ? (
              <DetailPanel
                card={selected}
                onClose={() => setSelectedId(null)}
                onActionRecorded={(result) => applyAction(selected.id, result)}
              />
            ) : (
              <NoSelection />
            )}
          </div>
        </div>
      )}

      {/* Below the two-pane breakpoint the panel becomes a full-screen overlay
          rather than a squeezed column — evidence rows are unreadable at half a
          phone's width. bg-canvas so it occludes the list rather than letting it
          show through, and h-dvh so it owns the viewport and scrolls internally
          exactly as the desktop pane does. */}
      {selected && (
        <div className="fixed inset-0 z-20 h-dvh bg-canvas md:hidden">
          <DetailPanel
            card={selected}
            onClose={() => setSelectedId(null)}
            onActionRecorded={(result) => applyAction(selected.id, result)}
          />
        </div>
      )}
    </div>
  );
}
