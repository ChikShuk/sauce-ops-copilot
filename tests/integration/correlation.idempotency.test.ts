import { describe, expect, it } from "vitest";
import { correlateEvent } from "../../src/lib/correlation/correlateEvent";
import { evidenceFor, findingsFor } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";

const AT = new Date("2026-08-14T20:10:00Z");

describe("redelivery", () => {
  it("leaves the finding byte-identical — no version bump, no count change", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });

    const first = await correlateEvent(event);
    const after = (await findingsFor(restaurantId))[0];

    // The worker's stale-reclaim path can hand the same event back.
    const second = await correlateEvent(event);
    expect(second.outcome).toBe("already_attached");
    expect(second.findingId).toBe(first.findingId);

    const again = (await findingsFor(restaurantId))[0];
    expect(again.version).toBe(after.version);
    expect(again.event_count).toBe(after.event_count);
    expect(again.priority).toBe(after.priority);
    expect(again.first_event_at).toBe(after.first_event_at);
    expect(again.last_event_at).toBe(after.last_event_at);

    expect(await evidenceFor(first.findingId)).toHaveLength(1);
  });

  it("survives five redeliveries without inflating anything", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });

    await correlateEvent(event);
    const baseline = (await findingsFor(restaurantId))[0];

    for (let i = 0; i < 5; i++) await correlateEvent(event);

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(1);
    expect(findings[0].version).toBe(baseline.version);
    expect(findings[0].event_count).toBe(1);
    expect(await evidenceFor(findings[0].id)).toHaveLength(1);
  });

  it("a redelivered event whose finding has since closed does not create an empty finding", async () => {
    const restaurantId = newRestaurantId();

    const first = await seedEvent({ restaurantId, occurredAt: AT });
    await correlateEvent(first);

    // Roll the window forward so the original finding gets closed and replaced.
    const later = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 4 * 60 * 60_000),
    });
    await correlateEvent(later);

    // Now redeliver the first event. Without the up-front guard this would find
    // no open finding matching it, create one, then no-op on the attach —
    // leaving a finding with zero evidence.
    const redelivered = await correlateEvent(first);
    expect(redelivered.outcome).toBe("already_attached");

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(await evidenceFor(finding.id)).not.toHaveLength(0);
      expect(finding.event_count).toBeGreaterThan(0);
    }
  });
});
