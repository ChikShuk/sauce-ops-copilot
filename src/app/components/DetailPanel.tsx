"use client";

import { useEffect, useState } from "react";
import { deriveCardState } from "@/lib/findings/cardState";
import type { FindingCard, FindingDetail } from "@/lib/findings/types";
import {
  DegradedChip,
  PriorityBadge,
  RetryChip,
  StaleChip,
  StatusPill,
  priorityRail,
} from "./Badges";
import { EvidenceTable } from "./EvidenceTable";
import { TimeAgo } from "./TimeAgo";
import { formatUtcDateTime, labelAction } from "./format";

/**
 * Fetched on demand rather than streamed. Evidence and prose are an order of
 * magnitude larger than a card and at most one finding is open at a time, so
 * the board stream carries `version` and this re-fetches when it moves — which
 * is what makes the panel update live without the stream carrying the weight.
 */
export function DetailPanel({
  card,
  onClose,
}: {
  card: FindingCard;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [error, setError] = useState(false);

  const findingId = card.id;
  const version = card.version;
  const status = card.status;

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(`/api/findings/${findingId}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        setDetail((await res.json()) as FindingDetail);
        setError(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(true);
      }
    }

    void load();
    return () => controller.abort();
    // `status` is a dependency alongside `version` because enrichment moves the
    // status without bumping the version — that is what makes version usable as
    // a fence in the first place.
  }, [findingId, version, status]);

  const presentation = deriveCardState(detail ?? card);
  const drivers = (detail ?? card).drivers;

  return (
    <aside className="flex h-full flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950">
      <header className="flex items-start gap-3 border-b border-zinc-800 p-4">
        <span
          aria-hidden
          className={`mt-1 h-10 w-1 shrink-0 rounded-full ${priorityRail(card.priority)}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={card.priority} />
            <span className="text-xs text-zinc-400">
              {card.restaurantId}
              {card.orderId && ` · order ${card.orderId}`}
            </span>
            <StatusPill presentation={presentation} />
          </div>
          <h2 className="mt-1.5 text-lg font-medium text-zinc-50">
            {card.issue ?? <span className="text-zinc-500">{presentation.placeholder}</span>}
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            {card.eventCount} {card.eventCount === 1 ? "event" : "events"} ·{" "}
            {formatUtcDateTime(card.firstEventAt)} → {formatUtcDateTime(card.lastEventAt)} · v
            {card.version}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail panel"
          className="shrink-0 rounded px-2 py-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
        >
          ✕
        </button>
      </header>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
        <Section title="Why this priority">
          {drivers.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No severity threshold was crossed. Every finding is at least low priority.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {drivers.map((driver, index) => (
                <li
                  key={`${driver.signal}-${index}`}
                  className="flex items-baseline gap-2 text-sm"
                >
                  <span className="font-mono text-xs text-zinc-500">{driver.signal}</span>
                  <span className="text-zinc-200">{driver.detail}</span>
                  <span className="ml-auto text-xs text-zinc-500">sets {driver.level}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Summary">
          <div className="flex flex-wrap gap-1.5">
            {presentation.retry && <RetryChip retry={presentation.retry} />}
            {presentation.staleProse && <StaleChip />}
            {presentation.degraded && <DegradedChip />}
          </div>

          {detail?.summary ? (
            <>
              {presentation.placeholder && (
                <p className="mt-2 text-sm text-red-300">{presentation.placeholder}</p>
              )}
              <p className="mt-2 text-sm leading-relaxed text-zinc-200">{detail.summary}</p>
              <p className="mt-2 text-xs text-zinc-500">
                {detail.summarySource === "llm"
                  ? `Written by ${detail.llmModel ?? "the model"}`
                  : "Written without the model"}
                {detail.enrichedAt && (
                  <>
                    {" · "}
                    <TimeAgo iso={detail.enrichedAt} />
                  </>
                )}
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">
              {error ? "Could not load this finding." : presentation.placeholder}
            </p>
          )}
        </Section>

        {detail && detail.recommendedActions.length > 0 && (
          <Section title="Recommended actions">
            <ul className="flex flex-col gap-2">
              {detail.recommendedActions.map((action, index) => (
                <li key={`${action.type}-${index}`} className="text-sm">
                  <span className="font-medium text-zinc-100">{labelAction(action.type)}</span>
                  <p className="text-zinc-400">{action.rationale}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section
          title={`Evidence (${detail?.evidence.length ?? card.eventCount})`}
          note={
            detail && detail.citedEventIds === null && detail.summarySource !== null
              ? "No citations recorded — this summary was not written by the model."
              : undefined
          }
        >
          {detail ? (
            <EvidenceTable
              evidence={detail.evidence}
              hasCitations={detail.citedEventIds !== null}
            />
          ) : (
            <p className="text-sm text-zinc-500">Loading evidence…</p>
          )}
        </Section>
      </div>
    </aside>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      {note && <p className="mb-2 text-xs text-zinc-500">{note}</p>}
      {children}
    </section>
  );
}
