import { describe, expect, it } from "vitest";
import { CORRELATION_WINDOW_MS } from "../../src/lib/config";
import {
  classifyAgainstWindow,
  isWithinWindow,
  summarizeEvidence,
} from "../../src/lib/correlation/window";

const at = (iso: string) => new Date(iso);

// The finding from the brief's reference scenario, mid-life: 17:55 -> 18:12.
const window = {
  firstEventAt: at("2026-08-14T17:55:00Z"),
  lastEventAt: at("2026-08-14T18:12:00Z"),
};

describe("classifyAgainstWindow", () => {
  it("accepts an event inside the evidence interval", () => {
    expect(classifyAgainstWindow(window, at("2026-08-14T18:00:00Z"))).toBe("inside");
  });

  it("accepts an event after the interval but within the window", () => {
    expect(classifyAgainstWindow(window, at("2026-08-14T20:10:00Z"))).toBe("inside");
  });

  it("accepts an event before the interval but within the window — out-of-order arrival", () => {
    expect(classifyAgainstWindow(window, at("2026-08-14T16:00:00Z"))).toBe("inside");
  });

  it("rejects forward, past the window", () => {
    expect(classifyAgainstWindow(window, at("2026-08-14T21:13:00Z"))).toBe("future_side");
  });

  it("rejects backward, past the window — the case the one-sided predicate misses", () => {
    expect(classifyAgainstWindow(window, at("2026-08-14T14:54:00Z"))).toBe("past_side");
  });

  it("rejects a week-old backfill as past_side, never as a match", () => {
    expect(classifyAgainstWindow(window, at("2026-08-08T18:00:00Z"))).toBe("past_side");
  });

  // Inclusivity is arbitrary but deliberate, so pin both sides of each edge.
  it("includes an event exactly one window past last_event_at", () => {
    const edge = new Date(window.lastEventAt.getTime() + CORRELATION_WINDOW_MS);
    expect(classifyAgainstWindow(window, edge)).toBe("inside");
    expect(classifyAgainstWindow(window, new Date(edge.getTime() + 1))).toBe("future_side");
  });

  it("includes an event exactly one window before first_event_at", () => {
    const edge = new Date(window.firstEventAt.getTime() - CORRELATION_WINDOW_MS);
    expect(classifyAgainstWindow(window, edge)).toBe("inside");
    expect(classifyAgainstWindow(window, new Date(edge.getTime() - 1))).toBe("past_side");
  });

  it("isWithinWindow agrees with classify", () => {
    expect(isWithinWindow(window, at("2026-08-14T18:00:00Z"))).toBe(true);
    expect(isWithinWindow(window, at("2026-08-08T18:00:00Z"))).toBe(false);
  });
});

describe("summarizeEvidence", () => {
  it("derives count and bounds regardless of input order", () => {
    const summary = summarizeEvidence([
      { occurredAt: at("2026-08-14T20:10:00Z"), orderId: null },
      { occurredAt: at("2026-08-14T17:55:00Z"), orderId: null },
      { occurredAt: at("2026-08-14T18:12:00Z"), orderId: null },
    ]);
    expect(summary.eventCount).toBe(3);
    expect(summary.firstEventAt.toISOString()).toBe("2026-08-14T17:55:00.000Z");
    expect(summary.lastEventAt.toISOString()).toBe("2026-08-14T20:10:00.000Z");
  });

  it("takes the first non-null order_id and leaves it null when absent", () => {
    expect(
      summarizeEvidence([
        { occurredAt: at("2026-08-14T17:55:00Z"), orderId: null },
        { occurredAt: at("2026-08-14T18:12:00Z"), orderId: "order_5001" },
      ]).orderId,
    ).toBe("order_5001");

    expect(
      summarizeEvidence([{ occurredAt: at("2026-08-14T17:55:00Z"), orderId: null }]).orderId,
    ).toBeNull();
  });

  it("throws on an empty evidence set rather than inventing bounds", () => {
    expect(() => summarizeEvidence([])).toThrow();
  });
});
