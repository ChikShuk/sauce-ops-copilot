import { describe, expect, it } from "vitest";
import { CORRELATION_WINDOW_MS } from "../../src/lib/config";
import { correlateEvent } from "../../src/lib/correlation/correlateEvent";
import { evidenceFor, findingsFor } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";

const BASE = new Date("2026-08-14T20:10:00Z");
const offset = (ms: number) => new Date(BASE.getTime() + ms);

async function correlate(restaurantId: string, occurredAt: Date) {
  const event = await seedEvent({ restaurantId, occurredAt });
  return { event, result: await correlateEvent(event) };
}

describe("future-side miss: the window lapsed", () => {
  it("closes the stale finding and opens a replacement", async () => {
    const restaurantId = newRestaurantId();

    const first = await correlate(restaurantId, BASE);
    expect(first.result.outcome).toBe("created");

    // Well past the window in the forward direction.
    const second = await correlate(restaurantId, offset(CORRELATION_WINDOW_MS + 60_000));
    expect(second.result.outcome).toBe("replaced");
    expect(second.result.closedFindingId).toBe(first.result.findingId);

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(2);

    const stale = findings.find((f) => f.id === first.result.findingId);
    const live = findings.find((f) => f.id === second.result.findingId);
    expect(stale?.closed_at).not.toBeNull();
    expect(live?.closed_at).toBeNull();

    // Exactly one open finding per restaurant, always.
    expect(findings.filter((f) => f.closed_at === null)).toHaveLength(1);
  });
});

describe("past-side miss: a backfill", () => {
  it("creates a born-closed finding and leaves the live one untouched", async () => {
    const restaurantId = newRestaurantId();

    const live = await correlate(restaurantId, BASE);
    const liveBefore = (await findingsFor(restaurantId))[0];

    // Six days old — inside the ingestion validator's 7-day bound, so this is
    // a real event the system must accept, not a malformed one.
    const backfill = await correlate(restaurantId, offset(-6 * 24 * 60 * 60_000));
    expect(backfill.result.outcome).toBe("created");
    expect(backfill.result.findingId).not.toBe(live.result.findingId);

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(2);

    const backfilled = findings.find((f) => f.id === backfill.result.findingId);
    const stillLive = findings.find((f) => f.id === live.result.findingId);

    // Born closed: its window is by definition already past.
    expect(backfilled?.closed_at).not.toBeNull();
    // The live finding is untouched — closing is driven by elapsed time since
    // a finding's OWN last_event_at, never by an unrelated old event arriving.
    expect(stillLive?.closed_at).toBeNull();
    expect(stillLive?.version).toBe(liveBefore.version);
    expect(stillLive?.event_count).toBe(liveBefore.event_count);

    expect(findings.filter((f) => f.closed_at === null)).toHaveLength(1);
  });

  it("a backfill does not strand later in-window evidence — the scenario that motivated this design", async () => {
    const restaurantId = newRestaurantId();

    // 20:10, then a six-day-old backfill, then 18:12 (2h before 20:10).
    const live = await correlate(restaurantId, BASE);
    await correlate(restaurantId, offset(-6 * 24 * 60 * 60_000));
    const later = await correlate(restaurantId, offset(-118 * 60_000));

    // 18:12 must still join the 20:10 finding.
    expect(later.result.findingId).toBe(live.result.findingId);
    expect(later.result.outcome).toBe("attached");

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(2);
    expect(await evidenceFor(live.result.findingId)).toHaveLength(2);
  });

  it("does not merge a week-old event into the live finding — the bound the one-sided predicate lacks", async () => {
    const restaurantId = newRestaurantId();

    const live = await correlate(restaurantId, BASE);
    const backfill = await correlate(restaurantId, offset(-6 * 24 * 60 * 60_000));

    expect(backfill.result.findingId).not.toBe(live.result.findingId);

    // The live finding's window must not have been dragged six days backward.
    const findings = await findingsFor(restaurantId);
    const stillLive = findings.find((f) => f.id === live.result.findingId);
    expect(new Date(stillLive!.first_event_at).toISOString()).toBe(BASE.toISOString());
  });
});

describe("window boundary", () => {
  it("attaches at exactly one window past the last event, and not one ms beyond", async () => {
    const inclusive = newRestaurantId();
    const start = await correlate(inclusive, BASE);
    const edge = await correlate(inclusive, offset(CORRELATION_WINDOW_MS));
    expect(edge.result.findingId).toBe(start.result.findingId);

    const exclusive = newRestaurantId();
    const start2 = await correlate(exclusive, BASE);
    const past = await correlate(exclusive, offset(CORRELATION_WINDOW_MS + 1));
    expect(past.result.findingId).not.toBe(start2.result.findingId);
  });
});
