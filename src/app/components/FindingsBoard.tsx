"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardMessage } from "@/lib/realtime/broadcaster";
import type { FindingCard as FindingCardData, QueueCounts } from "@/lib/findings/types";
import { DetailPanel } from "./DetailPanel";
import { EmptyBoard, NoSelection } from "./EmptyStates";
import { FindingCard } from "./FindingCard";
import { QueueHealth, type ConnectionState } from "./QueueHealth";

// How long a changed card stays highlighted. Matches the CSS animation in
// globals.css; the timer only controls when the class comes off.
const HIGHLIGHT_MS = 2_500;

export function FindingsBoard({
  initialFindings,
  initialQueue,
}: {
  initialFindings: FindingCardData[];
  initialQueue: QueueCounts;
}) {
  const [findings, setFindings] = useState(initialFindings);
  const [queue, setQueue] = useState(initialQueue);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());

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

  const selected = findings.find((finding) => finding.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <QueueHealth queue={queue} connection={connection} />

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
            {findings.map((finding) => (
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
          </div>

          <div className="hidden min-h-0 min-w-0 flex-1 md:block">
            {selected ? (
              <DetailPanel card={selected} onClose={() => setSelectedId(null)} />
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
          <DetailPanel card={selected} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}
