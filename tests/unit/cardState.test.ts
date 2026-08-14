import { describe, expect, it } from "vitest";
import type { PriorityDriver } from "../../src/lib/correlation/priority";
import { CARD_DRIVER_LIMIT, deriveCardState, formatDrivers } from "../../src/lib/findings/cardState";
import type { FindingCard } from "../../src/lib/findings/types";

const LAST_EVENT_AT = "2026-08-14T20:10:00.000Z";

function card(overrides: Partial<FindingCard> = {}): FindingCard {
  return {
    id: "f1",
    restaurantId: "rest_1",
    orderId: null,
    version: 2,
    status: "ready",
    priority: "high",
    drivers: [],
    issue: "Repeated late deliveries",
    hasSummary: true,
    summarySource: "llm",
    extractedTags: [],
    eventCount: 3,
    firstEventAt: "2026-08-14T17:55:00.000Z",
    lastEventAt: LAST_EVENT_AT,
    enrichedAt: LAST_EVENT_AT,
    enrichedVersion: 2,
    updatedAt: LAST_EVENT_AT,
    closedAt: null,
    reviewedAt: null,
    resolvedAt: null,
    retry: null,
    ...overrides,
  };
}

function driver(detail: string): PriorityDriver {
  return { signal: "event_count", level: "medium", detail };
}

describe("deriveCardState: the four status states", () => {
  it("maps accepted to queued", () => {
    const presentation = deriveCardState(card({ status: "accepted", hasSummary: false }));
    expect(presentation.state).toBe("queued");
    expect(presentation.label).toBe("Queued");
  });

  it("maps processing to analyzing", () => {
    expect(deriveCardState(card({ status: "processing" })).state).toBe("analyzing");
  });

  it("maps ready with prose to ready, and gives it no placeholder", () => {
    const presentation = deriveCardState(card({ status: "ready" }));
    expect(presentation.state).toBe("ready");
    expect(presentation.placeholder).toBeNull();
  });

  it("never leaves a region blank on a state that has no prose", () => {
    for (const status of ["accepted", "processing", "failed"] as const) {
      const presentation = deriveCardState(card({ status, hasSummary: false }));
      expect(presentation.placeholder).toBeTruthy();
    }
  });
});

describe("deriveCardState: failed splits in two", () => {
  // findings.status = 'failed' does NOT imply summary IS NULL.
  // markFindingFailedForEvent updates unconditionally, so a finding that was
  // ready and then absorbed an event whose job dead-lettered keeps prose
  // written from the smaller evidence set.
  it("says evidence is below when the finding was never analyzed", () => {
    const presentation = deriveCardState(card({ status: "failed", hasSummary: false }));
    expect(presentation.state).toBe("failed_unanalyzed");
    expect(presentation.placeholder).toContain("evidence below");
  });

  it("warns that surviving prose predates the failure rather than presenting it as current", () => {
    const presentation = deriveCardState(card({ status: "failed", hasSummary: true }));
    expect(presentation.state).toBe("failed_stale");
    expect(presentation.placeholder).toContain("predates");
  });

  it("treats a ready finding with no prose as a failure rather than rendering nothing", () => {
    expect(deriveCardState(card({ status: "ready", hasSummary: false })).state).toBe(
      "failed_unanalyzed",
    );
  });
});

describe("deriveCardState: the flags are orthogonal to the state", () => {
  it("flags prose describing an older evidence set than the finding now holds", () => {
    const presentation = deriveCardState(card({ version: 3, enrichedVersion: 2 }));
    expect(presentation.staleProse).toBe(true);
    // Still a perfectly normal ready card — staleness is a chip, not a state.
    expect(presentation.state).toBe("ready");
  });

  it("does not flag prose written for the current version", () => {
    expect(deriveCardState(card({ version: 3, enrichedVersion: 3 })).staleProse).toBe(false);
  });

  it("does not call a never-enriched finding stale", () => {
    expect(
      deriveCardState(card({ status: "accepted", hasSummary: false, enrichedVersion: null }))
        .staleProse,
    ).toBe(false);
  });

  // enriched_at is wall time; last_event_at is the business time an event
  // occurred. A backfilled finding is enriched long after its events happened,
  // so a timestamp comparison would call fresh prose current and stale prose
  // current too. Only the version comparison distinguishes them.
  it("is unaffected by prose being written long after the events it describes", () => {
    const backfilled = {
      lastEventAt: "2026-08-09T12:00:00.000Z",
      enrichedAt: "2026-08-14T20:10:00.000Z",
    };
    expect(deriveCardState(card({ ...backfilled, version: 3, enrichedVersion: 3 })).staleProse).toBe(
      false,
    );
    expect(deriveCardState(card({ ...backfilled, version: 3, enrichedVersion: 2 })).staleProse).toBe(
      true,
    );
  });

  it("flags the degraded writer", () => {
    expect(deriveCardState(card({ summarySource: "fallback" })).degraded).toBe(true);
    expect(deriveCardState(card({ summarySource: "llm" })).degraded).toBe(false);
  });

  it("carries retry state through independently of the finding's own status", () => {
    const retry = { attempts: 2, maxAttempts: 5, nextAttemptAt: "2026-08-14T20:12:00.000Z" };
    const presentation = deriveCardState(card({ status: "ready", retry }));
    expect(presentation.state).toBe("ready");
    expect(presentation.retry).toEqual(retry);
  });

  it("allows every flag at once", () => {
    const presentation = deriveCardState(
      card({
        status: "failed",
        hasSummary: true,
        summarySource: "fallback",
        version: 4,
        enrichedVersion: 2,
        retry: { attempts: 3, maxAttempts: 5, nextAttemptAt: LAST_EVENT_AT },
      }),
    );
    expect(presentation.state).toBe("failed_stale");
    expect(presentation.degraded).toBe(true);
    expect(presentation.staleProse).toBe(true);
    expect(presentation.retry).not.toBeNull();
  });
});

describe("formatDrivers", () => {
  it("labels the empty case rather than returning a blank line", () => {
    const line = formatDrivers([]);
    expect(line.shown).toEqual([]);
    expect(line.emptyLabel).toBe("No severity threshold crossed");
  });

  it("shows every driver when they fit", () => {
    const line = formatDrivers([driver("a"), driver("b")]);
    expect(line.shown).toHaveLength(2);
    expect(line.moreCount).toBe(0);
    expect(line.emptyLabel).toBeNull();
  });

  it("truncates and counts the remainder once they do not", () => {
    // Recurrence emits one driver per issue_class, so five is reachable.
    const line = formatDrivers([1, 2, 3, 4, 5].map((n) => driver(`d${n}`)));
    expect(line.shown).toHaveLength(CARD_DRIVER_LIMIT);
    expect(line.moreCount).toBe(5 - CARD_DRIVER_LIMIT);
  });

  it("preserves the strongest-first order scorePriority produced", () => {
    const line = formatDrivers([driver("strongest"), driver("second"), driver("third")]);
    expect(line.shown.map((d) => d.detail)).toEqual(["strongest", "second"]);
  });
});
