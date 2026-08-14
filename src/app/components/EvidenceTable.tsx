"use client";

import type { EvidenceItem } from "@/lib/findings/types";
import { TimeAgo } from "./TimeAgo";
import {
  formatMoney,
  formatUtcDateTime,
  labelEventType,
  labelIssueClass,
} from "./format";

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
    return <p className="text-sm text-zinc-500">No evidence attached.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {evidence.map((item) => (
        <li
          key={item.id}
          className={`rounded border p-2.5 text-sm ${
            item.cited ? "border-emerald-800/70 bg-emerald-500/5" : "border-zinc-800"
          }`}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-zinc-500">{item.label}</span>
            <span className="font-medium text-zinc-100">{labelEventType(item.eventType)}</span>

            {item.issueClass !== item.eventType && (
              <span
                className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400"
                title="Deterministic root-cause class, derived from structured fields only"
              >
                {labelIssueClass(item.issueClass)}
              </span>
            )}

            {facts(item).map((fact) => (
              <span key={fact} className="text-zinc-300">
                {fact}
              </span>
            ))}

            {item.cited && hasCitations && (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">
                cited
              </span>
            )}

            <span
              className="ml-auto text-xs text-zinc-500"
              title={formatUtcDateTime(item.occurredAt)}
            >
              <TimeAgo iso={item.occurredAt} />
            </span>
          </div>

          {/* Customer-authored text. Rendered as text, never as markup — the
              same input the prompt builder fences as data. */}
          {item.customerText && (
            <p className="mt-1.5 border-l-2 border-zinc-700 pl-2 text-zinc-400">
              {item.customerText}
            </p>
          )}

          <p className="mt-1.5 font-mono text-[11px] text-zinc-600">{item.clientEventId}</p>
        </li>
      ))}
    </ul>
  );
}
