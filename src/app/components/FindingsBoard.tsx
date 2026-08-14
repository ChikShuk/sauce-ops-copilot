"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardMessage } from "@/lib/realtime/broadcaster";
import type { FindingCard as FindingCardData, QueueCounts } from "@/lib/findings/types";
import { DetailPanel } from "./DetailPanel";
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
    <div className="flex h-full min-h-0 flex-col">
      <QueueHealth queue={queue} connection={connection} />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto md:max-w-md md:flex-none md:basis-[26rem]">
          {findings.length === 0 ? (
            <p className="p-6 text-sm text-zinc-500">
              No findings yet. Events posted to the ingestion API appear here as they
              correlate.
            </p>
          ) : (
            findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                selected={finding.id === selectedId}
                highlighted={highlighted.has(finding.id)}
                onSelect={() =>
                  setSelectedId((current) => (current === finding.id ? null : finding.id))
                }
              />
            ))
          )}
        </div>

        {selected ? (
          <div className="hidden min-w-0 flex-1 md:block">
            <DetailPanel card={selected} onClose={() => setSelectedId(null)} />
          </div>
        ) : (
          <div className="hidden flex-1 items-center justify-center border-l border-zinc-800 md:flex">
            <p className="text-sm text-zinc-600">Select a finding to see its evidence.</p>
          </div>
        )}
      </div>

      {/* Below the two-pane breakpoint the panel becomes a full-screen overlay
          rather than a squeezed column — evidence rows are unreadable at half a
          phone's width. */}
      {selected && (
        <div className="fixed inset-0 z-10 md:hidden">
          <DetailPanel card={selected} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}
