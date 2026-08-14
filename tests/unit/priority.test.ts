import { describe, expect, it } from "vitest";
import {
  BASE_PRIORITY,
  maxPriority,
  PRIORITY_THRESHOLDS,
  scorePriority,
  type PriorityEvidence,
} from "../../src/lib/correlation/priority";

const ev = (over: Partial<PriorityEvidence> = {}): PriorityEvidence => ({
  eventType: "delivery_delay",
  issueClass: "delivery_delay",
  occurredAt: new Date("2026-08-14T18:00:00Z"),
  delayMinutes: null,
  rating: null,
  ...over,
});

const score = (evidence: PriorityEvidence[], recurrence: Record<string, number> = {}) =>
  scorePriority({ evidence, recurrenceByIssueClass: recurrence });

describe("maxPriority", () => {
  it("returns the more severe of two levels, either order", () => {
    expect(maxPriority("low", "high")).toBe("high");
    expect(maxPriority("high", "low")).toBe("high");
    expect(maxPriority("critical", "high")).toBe("critical");
    expect(maxPriority("medium", "medium")).toBe("medium");
  });
});

describe("scorePriority — floor", () => {
  it("floors at low when no signal fires", () => {
    const result = score([ev()]);
    expect(result.priority).toBe(BASE_PRIORITY);
    expect(result.drivers).toEqual([]);
  });
});

describe("scorePriority — delay_minutes, max across evidence", () => {
  const { medium, high, critical } = PRIORITY_THRESHOLDS.delayMinutes;

  it.each([
    [medium - 1, "low"],
    [medium, "medium"],
    [high, "high"],
    [critical, "critical"],
  ])("a %i minute delay scores %s", (minutes, expected) => {
    expect(score([ev({ delayMinutes: minutes })]).priority).toBe(expected);
  });

  it("takes the worst delay in the set, not the latest", () => {
    const result = score([
      ev({ delayMinutes: critical }),
      ev({ delayMinutes: 1 }),
    ]);
    expect(result.priority).toBe("critical");
    expect(result.drivers[0].detail).toContain(String(critical));
  });
});

describe("scorePriority — event_count", () => {
  const { medium, high, critical } = PRIORITY_THRESHOLDS.eventCount;

  it.each([
    [medium - 1, "low"],
    [medium, "medium"],
    [high, "high"],
    [critical, "critical"],
  ])("%i events score %s", (count, expected) => {
    expect(score(Array.from({ length: count }, () => ev())).priority).toBe(expected);
  });
});

describe("scorePriority — review_rating, descending, min across evidence", () => {
  const { medium, high } = PRIORITY_THRESHOLDS.reviewRating;

  it.each([
    [medium + 1, "low"],
    [medium, "medium"],
    [high, "high"],
    [1, "high"],
  ])("a %i-star review scores %s", (rating, expected) => {
    expect(score([ev({ eventType: "negative_review", rating })]).priority).toBe(expected);
  });

  it("never reaches critical on rating alone — recurrence is what escalates", () => {
    expect(score([ev({ rating: 1 })]).priority).not.toBe("critical");
  });

  it("takes the worst rating in the set", () => {
    const result = score([ev({ rating: 5 }), ev({ rating: 1 })]);
    expect(result.drivers[0].detail).toContain("1-star");
  });
});

describe("scorePriority — recurrence", () => {
  const { medium, high, critical } = PRIORITY_THRESHOLDS.recurrence;

  it.each([
    [medium - 1, "low"],
    [medium, "medium"],
    [high, "high"],
    [critical, "critical"],
  ])("%i same-class events in the window score %s", (count, expected) => {
    expect(score([ev()], { delivery_delay: count }).priority).toBe(expected);
  });

  it("names the issue class in the driver detail", () => {
    const result = score([ev()], { missing_items: high });
    expect(result.drivers[0].detail).toBe(`${high} missing_items events in 24h`);
  });
});

describe("scorePriority — combination", () => {
  it("takes the max across signals rather than summing them", () => {
    // Two mediums must not compound into a high.
    const result = score(
      [ev({ delayMinutes: PRIORITY_THRESHOLDS.delayMinutes.medium }), ev()],
      {},
    );
    expect(result.priority).toBe("medium");
    expect(result.drivers).toHaveLength(2);
  });

  it("a same-class pattern outranks the same number of mixed-class events", () => {
    const evidence = [ev(), ev(), ev()];
    const mixed = score(evidence, {});
    const pattern = score(evidence, { delivery_delay: 3 });
    expect(mixed.priority).toBe("medium");
    expect(pattern.priority).toBe("high");
  });

  it("orders drivers strongest first", () => {
    const result = score(
      [ev({ delayMinutes: PRIORITY_THRESHOLDS.delayMinutes.critical }), ev()],
      { delivery_delay: PRIORITY_THRESHOLDS.recurrence.medium },
    );
    expect(result.priority).toBe("critical");
    expect(result.drivers[0].level).toBe("critical");
    expect(result.drivers.at(-1)?.level).toBe("medium");
  });

  it("is pure — same input, same output", () => {
    const input = {
      evidence: [ev({ delayMinutes: 30 })],
      recurrenceByIssueClass: { delivery_delay: 2 },
    };
    expect(scorePriority(input)).toEqual(scorePriority(input));
  });
});
