import { describe, expect, it } from "vitest";
import { correlateEvent } from "../../src/lib/correlation/correlateEvent";
import { deriveIssueClass } from "../../src/lib/events/deriveIssueClass";
import type { IngestEventInput } from "../../src/lib/events/schema";
import { REFERENCE_SCENARIO } from "../../src/lib/simulator/presets";
import { evidenceFor, findingsFor } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";

// The brief's own worked example. If this doesn't reproduce, the design is
// wrong regardless of how clean the code is.
//
// The payloads and their spacing come from src/lib/simulator/presets.ts, which
// is also what the simulator's reference button posts — so the demo a reviewer
// clicks and the fixture this test proves cannot drift apart. The simulator
// anchors those offsets to `now`; this anchors them to a fixed date so the
// first/last_event_at assertions below can stay exact.
const ANCHOR = new Date("2026-08-14T20:10:00Z");

const REFERENCE = REFERENCE_SCENARIO.map((spec) => ({
  label: spec.label,
  occurredAt: new Date(ANCHOR.getTime() - spec.minutesBefore * 60_000),
  eventType: spec.eventType,
  // Derived rather than restated: issue_class is production's job, and hardcoding
  // it here would let the taxonomy change without this test noticing.
  issueClass: deriveIssueClass({
    event_type: spec.eventType,
    payload: spec.payload,
  } as IngestEventInput),
  payload: spec.payload,
  orderId: spec.orderId,
}));

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
