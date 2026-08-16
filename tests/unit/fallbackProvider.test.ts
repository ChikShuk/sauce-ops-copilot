import { describe, expect, it } from "vitest";
import { writeFallbackEnrichment } from "../../src/lib/llm/fallback";
import { EXTRACTED_TAGS, MAX_RECOMMENDED_ACTIONS, RECOMMENDED_ACTION_TYPES } from "../../src/lib/llm/schema";
import type { EnrichmentInput, LabeledEvidence } from "../../src/lib/llm/types";

function evidence(overrides: Partial<LabeledEvidence> = {}): LabeledEvidence {
  return {
    label: "E1",
    eventId: "11111111-1111-1111-1111-111111111111",
    eventType: "delivery_delay",
    issueClass: "delivery_delay",
    occurredAt: new Date("2026-08-14T18:04:00.000Z"),
    delayMinutes: 42,
    rating: null,
    refundAmountCents: null,
    customerText: null,
    ...overrides,
  };
}

function input(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    findingId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    priority: "high",
    drivers: [{ signal: "delay_minutes", level: "high", detail: "42 minute delay" }],
    eventCount: 2,
    firstEventAt: new Date("2026-08-14T18:04:00.000Z"),
    lastEventAt: new Date("2026-08-14T19:12:00.000Z"),
    evidence: [evidence(), evidence({ label: "E2", eventId: "22222222-2222-2222-2222-222222222222" })],
    ...overrides,
  };
}

describe("writeFallbackEnrichment", () => {
  it("is deterministic for the same input", () => {
    expect(writeFallbackEnrichment(input())).toEqual(writeFallbackEnrichment(input()));
  });

  it("does not vary with evidence ordering within an issue class", () => {
    const forward = input();
    const reversed = input({ evidence: [...forward.evidence].reverse() });
    expect(writeFallbackEnrichment(reversed).issue).toBe(writeFallbackEnrichment(forward).issue);
  });

  it("breaks issue-class ties deterministically", () => {
    const mixed = input({
      evidence: [
        evidence({ issueClass: "wrong_order" }),
        evidence({ label: "E2", issueClass: "missing_items" }),
      ],
    });
    // One each — the tiebreak is alphabetical, so it must not depend on order.
    const reversed = input({ evidence: [...mixed.evidence].reverse() });
    expect(writeFallbackEnrichment(mixed).issue).toBe(writeFallbackEnrichment(reversed).issue);
  });

  it("emits no citations at all, rather than citing everything", () => {
    // Citing every label would give cited_event_ids two meanings and light up
    // every event as cited on a degraded finding. null means "no citation data".
    expect(writeFallbackEnrichment(input()).citedEventIds).toBeNull();
  });

  it("marks itself as the fallback with no model attributed", () => {
    const enrichment = writeFallbackEnrichment(input());
    expect(enrichment.source).toBe("fallback");
    expect(enrichment.model).toBeNull();
  });

  it("restates the deterministic facts it was given", () => {
    const enrichment = writeFallbackEnrichment(input());
    expect(enrichment.summary).toContain("42 minute delay");
    expect(enrichment.summary).toContain("high");
    expect(enrichment.issue).toContain("2 events");
  });

  it("says plainly that it is the degraded path", () => {
    expect(writeFallbackEnrichment(input()).summary).toContain("without the AI model");
  });

  it("stays inside the action allowlist and the action cap", () => {
    const enrichment = writeFallbackEnrichment(input());
    expect(enrichment.actions.length).toBeLessThanOrEqual(MAX_RECOMMENDED_ACTIONS);
    for (const action of enrichment.actions) {
      expect(RECOMMENDED_ACTION_TYPES).toContain(action.type);
    }
  });

  it("stays inside the tag enum", () => {
    for (const tag of writeFallbackEnrichment(input()).tags) {
      expect(EXTRACTED_TAGS).toContain(tag);
    }
  });

  it("handles an unscored finding with no drivers", () => {
    const enrichment = writeFallbackEnrichment(input({ priority: null, drivers: [] }));
    expect(enrichment.summary).toContain("no severity threshold");
    expect(enrichment.actions.length).toBeGreaterThan(0);
  });

  it("handles an unknown issue class without throwing", () => {
    const enrichment = writeFallbackEnrichment(
      input({ evidence: [evidence({ issueClass: "something_new" })] }),
    );
    expect(enrichment.issue).toContain("Operational issues");
    expect(enrichment.tags).toEqual(["other"]);
  });
});
