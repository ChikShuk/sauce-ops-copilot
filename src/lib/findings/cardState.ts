import type { PriorityDriver } from "../correlation/priority";
import type { FindingCard, RetryState } from "./types";

// The five shapes a card can take. Note that these are NOT findings.status:
// 'failed' splits in two, because whether prose exists changes what the card
// must say and getting it wrong shows an operator stale prose as if it were
// current.
export const CARD_STATES = [
  "queued",
  "analyzing",
  "ready",
  "failed_unanalyzed",
  "failed_stale",
] as const;

export type CardState = (typeof CARD_STATES)[number];

export type CardPresentation = {
  state: CardState;
  // Short pill text. Operator vocabulary, not schema vocabulary — nobody
  // outside this repo knows what 'accepted' means.
  label: string;
  // What to render where the summary would be, or null when prose is expected
  // to be there. A blank region reads as a broken UI, never as an empty state.
  placeholder: string | null;
  // The three flags below are orthogonal to `state` and to each other, which is
  // why they are separate fields rather than more states: a finding can be
  // ready, degraded, stale and retrying all at once.
  retry: RetryState | null;
  staleProse: boolean;
  degraded: boolean;
};

const LABELS: Record<CardState, string> = {
  queued: "Queued",
  analyzing: "Analyzing",
  ready: "Ready",
  failed_unanalyzed: "Analysis failed",
  failed_stale: "Analysis failed",
};

const PLACEHOLDERS: Record<CardState, string | null> = {
  queued: "Queued for analysis — evidence and priority are already final.",
  analyzing: "Analyzing…",
  ready: null,
  failed_unanalyzed: "Analysis failed — evidence below.",
  failed_stale: "Analysis failed — the summary below predates this failure.",
};

function deriveState(finding: FindingCard): CardState {
  switch (finding.status) {
    case "failed":
      return finding.hasSummary ? "failed_stale" : "failed_unanalyzed";
    case "processing":
      return "analyzing";
    case "ready":
      // A 'ready' finding with no prose would mean enrichment reported success
      // without writing anything. Not reachable today, but rendering a blank
      // card would hide it rather than surface it.
      return finding.hasSummary ? "ready" : "failed_unanalyzed";
    default:
      return "queued";
  }
}

// Prose written for an older evidence set than the finding now holds.
// Reachable when a worker dies between correlation committing and enrichment
// writing — see llm/staleEnrichment.ts. The repair fires on the next
// redelivery, so this is a window rather than a permanent state, but the window
// can be minutes wide and an operator reading a summary of three events for a
// four-event finding deserves to know.
//
// A version comparison, deliberately not `enriched_at < last_event_at`: those
// are two different clocks. enriched_at is wall time; last_event_at is the
// business time an event occurred, which for a backfill is days in the past.
// Prose is always written after the event it describes happened, so the
// timestamp form would be false exactly when staleness is real.
//
// A never-enriched finding is not "stale" — it has no prose to be behind.
function isProseStale(finding: FindingCard): boolean {
  if (finding.enrichedVersion === null) return false;
  return finding.enrichedVersion < finding.version;
}

export function deriveCardState(finding: FindingCard): CardPresentation {
  const state = deriveState(finding);

  return {
    state,
    label: LABELS[state],
    placeholder: PLACEHOLDERS[state],
    retry: finding.retry,
    staleProse: isProseStale(finding),
    degraded: finding.summarySource === "fallback",
  };
}

// How many drivers fit on a collapsed card before it stops being scannable.
// Recurrence emits one driver per issue_class, so four or more is reachable and
// "95 min delay · 4 related events · 3 delivery_delay in 24h · 2 complaint in
// 24h" does not fit anywhere useful.
export const CARD_DRIVER_LIMIT = 2;

export type DriversLine = {
  shown: PriorityDriver[];
  moreCount: number;
  // Non-null only when there are no drivers at all. scorePriority returns an
  // empty list at base priority, and a blank row there reads as a rendering bug
  // on the one line of the card whose whole job is to be trusted.
  emptyLabel: string | null;
};

// scorePriority already sorts strongest-first and JSON preserves array order,
// so the top N survives the round trip through jsonb without re-sorting here.
export function formatDrivers(
  drivers: PriorityDriver[],
  limit: number = CARD_DRIVER_LIMIT,
): DriversLine {
  if (drivers.length === 0) {
    return { shown: [], moreCount: 0, emptyLabel: "No severity threshold crossed" };
  }

  return {
    shown: drivers.slice(0, limit),
    moreCount: Math.max(0, drivers.length - limit),
    emptyLabel: null,
  };
}
