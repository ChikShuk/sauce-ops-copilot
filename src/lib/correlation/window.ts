import { CORRELATION_WINDOW_MS } from "../config";

export type CorrelationWindow = {
  firstEventAt: Date;
  lastEventAt: Date;
};

export type WindowRelation = "inside" | "future_side" | "past_side";

// An event belongs to a finding if it is within CORRELATION_WINDOW_MS of the
// nearest edge of that finding's evidence interval:
//
//     first_event_at - W  <=  occurred_at  <=  last_event_at + W
//
// The one-sided form (last_event_at >= occurred_at - W) is this predicate with
// the lower bound deleted, so it has no lower bound at all: any arbitrarily old
// event attaches. occurred_at is validated only to within 7 days past, so a
// week-old backfill would merge into the live finding and then drag
// first_event_at back with it, after which that finding swallows everything at
// the restaurant.
//
// Bounds are inclusive: an event exactly W from an edge attaches. Arbitrary,
// but deliberate and pinned by tests.
export function classifyAgainstWindow(
  window: CorrelationWindow,
  occurredAt: Date,
): WindowRelation {
  const t = occurredAt.getTime();
  if (t < window.firstEventAt.getTime() - CORRELATION_WINDOW_MS) return "past_side";
  if (t > window.lastEventAt.getTime() + CORRELATION_WINDOW_MS) return "future_side";
  return "inside";
}

export function isWithinWindow(window: CorrelationWindow, occurredAt: Date): boolean {
  return classifyAgainstWindow(window, occurredAt) === "inside";
}

export type EvidenceTimes = {
  occurredAt: Date;
  orderId: string | null;
};

export type EvidenceSummary = {
  eventCount: number;
  firstEventAt: Date;
  lastEventAt: Date;
  orderId: string | null;
};

// Recomputed from the evidence set rather than incremented. min/max over the
// set is identical to iterated LEAST/GREATEST, and additionally converges after
// a partially applied or retried run — whereas event_count = event_count + 1
// drifts permanently once it is wrong even once.
export function summarizeEvidence(evidence: readonly EvidenceTimes[]): EvidenceSummary {
  if (evidence.length === 0) {
    throw new Error("summarizeEvidence: evidence set is empty");
  }

  let firstEventAt = evidence[0].occurredAt;
  let lastEventAt = evidence[0].occurredAt;
  let orderId: string | null = null;

  for (const row of evidence) {
    if (row.occurredAt < firstEventAt) firstEventAt = row.occurredAt;
    if (row.occurredAt > lastEventAt) lastEventAt = row.occurredAt;
    // Earliest evidence carrying an order_id wins; display only, never matching.
    if (orderId === null && row.orderId !== null) orderId = row.orderId;
  }

  return { eventCount: evidence.length, firstEventAt, lastEventAt, orderId };
}
