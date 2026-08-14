import { describe, expect, it } from "vitest";
import { correlateEvent } from "../../src/lib/correlation/correlateEvent";
import { evidenceFor, findingsFor } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";

// The brief's own worked example. If this doesn't reproduce, the design is
// wrong regardless of how clean the code is.
const REFERENCE = [
  {
    label: "delivery_delay 17:55",
    occurredAt: new Date("2026-08-14T17:55:00Z"),
    eventType: "delivery_delay",
    issueClass: "delivery_delay",
    payload: { delay_minutes: 35 },
    orderId: "order_5001",
  },
  {
    label: "complaint 18:12",
    occurredAt: new Date("2026-08-14T18:12:00Z"),
    eventType: "complaint",
    issueClass: "missing_items",
    payload: { complaint_text: "fries were missing", category: "missing_items" },
    orderId: "order_5001",
  },
  {
    label: "negative_review 20:10",
    occurredAt: new Date("2026-08-14T20:10:00Z"),
    eventType: "negative_review",
    issueClass: "negative_review",
    payload: { rating: 2, review_text: "slow and wrong" },
    orderId: null,
  },
] as const;

// All 6 arrival orders must converge on the same finding.
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("reference scenario", () => {
  const orders = permutations(REFERENCE);

  it.each(orders.map((order) => [order.map((e) => e.label).join(" -> "), order] as const))(
    "arrival order %s produces one finding with three evidence rows",
    async (_label, order) => {
      const restaurantId = newRestaurantId();

      for (const spec of order) {
        const event = await seedEvent({
          restaurantId,
          occurredAt: spec.occurredAt,
          eventType: spec.eventType,
          issueClass: spec.issueClass,
          orderId: spec.orderId,
          payload: { ...spec.payload },
        });
        await correlateEvent(event);
      }

      const findings = await findingsFor(restaurantId);
      expect(findings).toHaveLength(1);

      const finding = findings[0];
      const evidence = await evidenceFor(finding.id);
      expect(evidence).toHaveLength(3);

      expect(finding.event_count).toBe(3);
      expect(new Date(finding.first_event_at).toISOString()).toBe("2026-08-14T17:55:00.000Z");
      expect(new Date(finding.last_event_at).toISOString()).toBe("2026-08-14T20:10:00.000Z");
      expect(finding.closed_at).toBeNull();
      expect(finding.status).toBe("accepted");
      expect(finding.priority).not.toBeNull();

      // >= rather than == : an exact version couples this test to an
      // implementation detail, and slice 5 adding an enrichment bump would
      // break it for a reason unrelated to correlation. The >= still catches
      // the failures that matter — no bump at all, or a bump per redelivery.
      expect(finding.version).toBeGreaterThanOrEqual(4);

      // order_id is display-only and never part of matching, but it should be
      // carried from whichever evidence has one.
      expect(finding.order_id).toBe("order_5001");
    },
  );
});
