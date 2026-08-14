"use client";

import { useEffect, useState } from "react";
import { deriveCardState } from "@/lib/findings/cardState";
import type { FindingCard, FindingDetail, OperatorActionRecord } from "@/lib/findings/types";
import { ActionBar, type ActionResult } from "./ActionBar";
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
  onActionRecorded,
}: {
  card: FindingCard;
  onClose: () => void;
  onActionRecorded: (result: ActionResult) => void;
}) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [error, setError] = useState(false);
  // An operator action changes none of the fields the effect below watches, so
  // it needs its own trigger to pull the refreshed action history.
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [findingId, version, status, reloadKey]);

  const presentation = deriveCardState(detail ?? card);
  const drivers = (detail ?? card).drivers;

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-l border-line">
      {/*
        The header is outside the scrolling region, so the issue title, priority
        and status stay on screen while the evidence table scrolls under them —
        an operator reading evidence never loses what it is evidence *of*.

        Both this header and the body below share one `max-w-4xl` wrapper. Capping
        only the body would leave the pinned title sitting left of the text
        beneath it, which reads as a layout bug rather than as a deliberate
        measure.
      */}
      <header className="shrink-0 border-b border-line">
        <div className="mx-auto flex w-full max-w-4xl items-start gap-3 p-4">
          <span
            aria-hidden
            className={`mt-1 h-10 w-1 shrink-0 rounded-full ${priorityRail(card.priority)}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <PriorityBadge priority={card.priority} />
              <span className="text-xs text-ink-muted">
                {card.restaurantId}
                {card.orderId && ` · order ${card.orderId}`}
              </span>
              <StatusPill presentation={presentation} />
            </div>
            <h2 className="mt-1.5 text-lg font-medium text-ink">
              {card.issue ?? (
                <span className="text-ink-subtle">{presentation.placeholder}</span>
              )}
            </h2>
            <p className="mt-1 text-xs text-ink-subtle">
              {card.eventCount} {card.eventCount === 1 ? "event" : "events"} ·{" "}
              {formatUtcDateTime(card.firstEventAt)} → {formatUtcDateTime(card.lastEventAt)} ·
              v{card.version}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail panel"
            className="shrink-0 rounded px-2 py-1 text-ink-subtle hover:bg-surface-hover hover:text-ink"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4">
          <ActionBar
            card={card}
            actions={detail?.actions ?? []}
            onRecorded={(result) => {
              onActionRecorded(result);
              setReloadKey((key) => key + 1);
            }}
          />

          <Section title="Why this priority">
            {drivers.length === 0 ? (
              <p className="text-sm text-ink-subtle">
                No severity threshold was crossed. Every finding is at least low priority.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {drivers.map((driver, index) => (
                  <li
                    key={`${driver.signal}-${index}`}
                    className="flex items-baseline gap-2 text-sm"
                  >
                    <span className="font-mono text-xs text-ink-subtle">{driver.signal}</span>
                    <span className="text-ink">{driver.detail}</span>
                    <span className="ml-auto text-xs text-ink-subtle">
                      sets {driver.level}
                    </span>
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
                  <p className="mt-2 text-sm text-danger-fg">{presentation.placeholder}</p>
                )}
                <p className="mt-2 text-sm leading-relaxed text-ink">{detail.summary}</p>
                <p className="mt-2 text-xs text-ink-subtle">
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
              <p className="mt-2 text-sm text-ink-subtle">
                {error ? "Could not load this finding." : presentation.placeholder}
              </p>
            )}
          </Section>

          {detail && detail.recommendedActions.length > 0 && (
            <Section title="Recommended actions">
              <ul className="flex flex-col gap-2">
                {detail.recommendedActions.map((action, index) => (
                  <li key={`${action.type}-${index}`} className="text-sm">
                    <span className="font-medium text-ink">{labelAction(action.type)}</span>
                    <p className="text-ink-muted">{action.rationale}</p>
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
              <p className="text-sm text-ink-subtle">Loading evidence…</p>
            )}
          </Section>

          {detail && detail.actions.length > 0 && (
            <Section title="Operator activity">
              <ActionHistory actions={detail.actions} />
            </Section>
          )}
        </div>
      </div>
    </aside>
  );
}

const ACTION_LABELS: Record<string, string> = {
  mark_reviewed: "Marked reviewed",
  mark_resolved: "Marked resolved",
  thumbs_down: "Flagged summary as unhelpful",
  thumbs_up: "Marked summary as helpful",
};

/**
 * Newest first. Exists so the persistence is visible rather than implied — the
 * audit log is append-only, so a finding reviewed twice shows twice, which is
 * the honest record even though `reviewed_at` only moved once.
 */
function ActionHistory({ actions }: { actions: OperatorActionRecord[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {actions.map((action) => (
        <li key={action.id} className="text-sm">
          <span className="text-ink">
            {ACTION_LABELS[action.actionType] ?? action.actionType}
          </span>
          <span className="text-ink-subtle">
            {" · "}
            {action.actor}
            {action.version !== null && ` · v${action.version}`}
            {" · "}
            <TimeAgo iso={action.createdAt} />
          </span>
          {action.note && (
            <p className="mt-0.5 border-l-2 border-line pl-2 text-ink-muted">
              &ldquo;{action.note}&rdquo;
            </p>
          )}
        </li>
      ))}
    </ul>
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
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
        {title}
      </h3>
      {note && <p className="mb-2 text-xs text-ink-subtle">{note}</p>}
      {children}
    </section>
  );
}
