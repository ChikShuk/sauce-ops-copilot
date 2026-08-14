import { describe, expect, it } from "vitest";
import { FORCE_FAIL_PREFIX, CORRELATION_WINDOW_MS } from "../../src/lib/config";
import { deriveIssueClass } from "../../src/lib/events/deriveIssueClass";
import { ingestEventSchema } from "../../src/lib/events/schema";
import {
  buildComplaint,
  buildDeliveryDelay,
  buildForceFailure,
  buildInjectionComplaint,
  buildReferenceScenario,
  buildRelatedEvent,
  sampleJsonBody,
  INJECTION_COMPLAINT_TEXT,
  REFERENCE_SCENARIO,
  type SimulatorPost,
} from "../../src/lib/simulator/presets";

const NOW = new Date("2026-08-14T20:10:00Z");
const RESTAURANT = "bellas_pizza";

const SINGLE_PRESETS: [string, (r: string, now: Date) => SimulatorPost][] = [
  ["delivery delay", buildDeliveryDelay],
  ["complaint", buildComplaint],
  ["related event", buildRelatedEvent],
  ["injection complaint", buildInjectionComplaint],
  ["force failure", buildForceFailure],
];

function allPosts(): SimulatorPost[] {
  return [
    ...SINGLE_PRESETS.map(([, build]) => build(RESTAURANT, NOW)),
    ...buildReferenceScenario(RESTAURANT, "chronological", NOW),
    ...buildReferenceScenario(RESTAURANT, "out_of_order", NOW),
  ];
}

describe("simulator presets: every button posts something the API accepts", () => {
  // The point of this file. Presets are pure data, so they can be checked
  // against the schema that actually guards the endpoint — a preset that drifts
  // from the schema fails here rather than in front of a reviewer.
  it.each(SINGLE_PRESETS)("%s validates against ingestEventSchema", (_label, build) => {
    const result = ingestEventSchema.safeParse(build(RESTAURANT, NOW).body);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it.each(["chronological", "out_of_order"] as const)(
    "the %s reference scenario validates in full",
    (order) => {
      for (const post of buildReferenceScenario(RESTAURANT, order, NOW)) {
        const result = ingestEventSchema.safeParse(post.body);
        expect(result.error?.issues ?? []).toEqual([]);
      }
    },
  );

  it("prefills the JSON escape hatch with something valid", () => {
    const result = ingestEventSchema.safeParse(JSON.parse(sampleJsonBody(NOW)));
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it("gives every post a unique event_id", () => {
    const ids = allPosts().map((post) => post.body.event_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("simulator presets: occurred_at stays inside the ingestion bounds", () => {
  // occurred_at is a correctness bound, not input hygiene — a far-future value
  // creates a finding whose window never lapses. The presets generate it in the
  // browser, so they have to respect it themselves.
  it.each(SINGLE_PRESETS)("%s is in the past and within 7 days", (_label, build) => {
    const at = Date.parse(build(RESTAURANT, NOW).body.occurred_at);
    expect(at).toBeLessThanOrEqual(NOW.getTime());
    expect(at).toBeGreaterThan(NOW.getTime() - 7 * 24 * 60 * 60_000);
  });

  it("never emits a future timestamp, even for the newest reference event", () => {
    for (const order of ["chronological", "out_of_order"] as const) {
      for (const post of buildReferenceScenario(RESTAURANT, order, NOW)) {
        expect(Date.parse(post.body.occurred_at)).toBeLessThanOrEqual(NOW.getTime());
      }
    }
  });
});

describe("simulator presets: the reference scenario reproduces the brief", () => {
  it("keeps the brief's spacing — 17:55, 18:12, 20:10", () => {
    expect(REFERENCE_SCENARIO.map((spec) => spec.minutesBefore)).toEqual([135, 118, 0]);
  });

  it("spans less than the correlation window, so all three converge", () => {
    const offsets = REFERENCE_SCENARIO.map((spec) => spec.minutesBefore);
    const spanMs = (Math.max(...offsets) - Math.min(...offsets)) * 60_000;
    expect(spanMs).toBeLessThan(CORRELATION_WINDOW_MS);
  });

  it("posts the same three events in both orders, newest first when out of order", () => {
    const chronological = buildReferenceScenario(RESTAURANT, "chronological", NOW);
    const outOfOrder = buildReferenceScenario(RESTAURANT, "out_of_order", NOW);

    const times = (posts: SimulatorPost[]) => posts.map((p) => Date.parse(p.body.occurred_at));

    // Same set of moments, different arrival sequence — which is the whole
    // claim the two buttons sit next to.
    expect([...times(outOfOrder)].sort()).toEqual([...times(chronological)].sort());
    expect(times(chronological)).toEqual([...times(chronological)].sort((a, b) => a - b));
    expect(times(outOfOrder)[0]).toBe(Math.max(...times(outOfOrder)));
    expect(times(outOfOrder)).not.toEqual(times(chronological));
  });

  it("carries order_5001 on the delay and the complaint, and none on the review", () => {
    const posts = buildReferenceScenario(RESTAURANT, "chronological", NOW);
    expect(posts[0].body.order_id).toBe("order_5001");
    expect(posts[1].body.order_id).toBe("order_5001");
    expect(posts[2].body.order_id).toBeUndefined();
  });
});

describe("simulator presets: the demo-specific ones", () => {
  it("derives missing_items from the complaint's category, not from its text", () => {
    const body = buildComplaint(RESTAURANT, NOW).body;
    expect(deriveIssueClass(body)).toBe("missing_items");
  });

  it("prefixes the forced failure with the exact string the worker matches on", () => {
    // Imported rather than retyped: a change to the prefix must not leave this
    // button silently posting an ordinary event.
    expect(buildForceFailure(RESTAURANT, NOW).body.event_id.startsWith(FORCE_FAIL_PREFIX)).toBe(
      true,
    );
  });

  it("posts the injection fixture verbatim, including its forged fence tokens", () => {
    const body = buildInjectionComplaint(RESTAURANT, NOW).body;
    if (body.event_type !== "complaint") throw new Error("expected a complaint");

    expect(body.payload.complaint_text).toBe(INJECTION_COMPLAINT_TEXT);
    expect(body.payload.complaint_text).toContain("</customer_text>");
    expect(body.payload.complaint_text).toContain("E99");
  });
});
