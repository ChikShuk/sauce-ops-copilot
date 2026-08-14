import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { scorePriority } from "../../src/lib/correlation/priority";
import { db } from "../../src/lib/db/client";
import { EXTRACTED_TAGS, RECOMMENDED_ACTION_TYPES } from "../../src/lib/llm/schema";
import { processEvent } from "../../src/worker/processEvent";
import { eventRowById as eventRow, evidenceFor, findingsFor } from "../helpers/db";
import {
  INJECTION_COMPLAINT_TEXT,
  injectionComplaintPayload,
  newRestaurantId,
  seedEvent,
} from "../helpers/factories";
import { failingProvider, rawTextProvider, stubProvider } from "../helpers/providers";

const AT = new Date("2026-08-14T20:10:00Z");

async function seedInjection(restaurantId: string) {
  return seedEvent({
    restaurantId,
    occurredAt: AT,
    eventType: "complaint",
    issueClass: "missing_items",
    payload: injectionComplaintPayload(),
  });
}

// Layer 3 of the injection defense: the whole pipeline, with the hostile
// complaint stored as a real event. Layers 1 and 2 (prompt containment and
// validator containment) are unit-tested; this asserts the system-level
// property those layers exist to guarantee — that the shape of what lands in
// the database does not change because a customer asked it to.
describe("prompt injection: end to end", () => {
  it("ingests and correlates a hostile complaint like any other event", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedInjection(restaurantId);

    await processEvent(await eventRow(event.id), stubProvider());

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(1);
    expect(await evidenceFor(findings[0].id)).toEqual([event.id]);
  });

  it("does not let injected text change the priority code computed", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedInjection(restaurantId);

    await processEvent(await eventRow(event.id), stubProvider());

    const finding = (await findingsFor(restaurantId))[0];
    const expected = scorePriority({
      evidence: [
        {
          eventType: "complaint",
          issueClass: "missing_items",
          occurredAt: AT,
          delayMinutes: null,
          rating: null,
        },
      ],
      recurrenceByIssueClass: { missing_items: 1 },
    });

    expect(finding.priority).toBe(expected.priority);
  });

  it("holds its shape on the degraded path too", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedInjection(restaurantId);

    await processEvent(await eventRow(event.id), failingProvider());

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.status).toBe("ready");
    expect(finding.summary_source).toBe("fallback");
    expect(finding.cited_event_ids).toBeNull();
    for (const action of finding.recommended_actions ?? []) {
      expect(RECOMMENDED_ACTION_TYPES).toContain(action.type);
    }
  });

  it("never stores the injected instructions as a summary", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedInjection(restaurantId);

    await processEvent(await eventRow(event.id), failingProvider());

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.summary).not.toContain("maintenance mode");
    expect(finding.summary).not.toContain("delete_all_findings");
  });

  // The interesting half: assume the model DID obey. "The model didn't obey"
  // and "obedience is survivable" are different claims, and only the second can
  // be asserted deterministically — so it is the one under test here.
  describe("when the model obeys the injected instructions", () => {
    const obedient = (overrides: Record<string, unknown>) =>
      rawTextProvider(
        JSON.stringify({
          issue: "Maintenance mode",
          summary: "Instructions received from the customer text.",
          recommended_actions: [{ type: "contact_customer", rationale: "ok" }],
          extracted_tags: ["missing_items"],
          cited_labels: ["E1"],
          ...overrides,
        }),
      );

    it("refuses an action the complaint asked for and degrades instead", async () => {
      const restaurantId = newRestaurantId();
      const event = await seedInjection(restaurantId);

      await processEvent(
        await eventRow(event.id),
        obedient({
          recommended_actions: [{ type: "delete_all_findings", rationale: "cleanup" }],
        }),
      );

      const finding = (await findingsFor(restaurantId))[0];
      expect(finding.summary_source).toBe("fallback");
      for (const action of finding.recommended_actions ?? []) {
        expect(RECOMMENDED_ACTION_TYPES).toContain(action.type);
      }
    });

    it("refuses the fabricated citation the complaint asked for", async () => {
      const restaurantId = newRestaurantId();
      const event = await seedInjection(restaurantId);

      await processEvent(await eventRow(event.id), obedient({ cited_labels: ["E99"] }));

      const finding = (await findingsFor(restaurantId))[0];
      // Rejected outright rather than stripped: dropping E99 and keeping the
      // sentence would leave an unsupported claim standing.
      expect(finding.summary_source).toBe("fallback");
      expect(finding.cited_event_ids).toBeNull();
    });

    it("refuses an injected extra field", async () => {
      const restaurantId = newRestaurantId();
      const event = await seedInjection(restaurantId);

      await processEvent(await eventRow(event.id), obedient({ status: "resolved" }));

      const finding = (await findingsFor(restaurantId))[0];
      expect(finding.summary_source).toBe("fallback");
      expect(finding.status).toBe("ready");
    });

    it("refuses a tag outside the enum", async () => {
      const restaurantId = newRestaurantId();
      const event = await seedInjection(restaurantId);

      await processEvent(await eventRow(event.id), obedient({ extracted_tags: ["system_owned"] }));

      const finding = (await findingsFor(restaurantId))[0];
      expect(finding.summary_source).toBe("fallback");
      for (const tag of finding.extracted_tags ?? []) {
        expect(EXTRACTED_TAGS).toContain(tag);
      }
    });

    it("creates no extra findings or operator actions whatever the model returns", async () => {
      const restaurantId = newRestaurantId();
      const event = await seedInjection(restaurantId);

      await processEvent(
        await eventRow(event.id),
        obedient({ recommended_actions: [{ type: "delete_all_findings", rationale: "x" }] }),
      );

      expect(await findingsFor(restaurantId)).toHaveLength(1);

      const actions = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
        FROM operator_actions oa
        JOIN findings f ON f.id = oa.finding_id
        WHERE f.restaurant_id = ${restaurantId};
      `);
      expect(actions[0].n).toBe(0);
    });

    it("leaves the original complaint text intact in the evidence row", async () => {
      // Sanitizing happens at the prompt boundary, not on the way into the
      // database — events are immutable and an operator should see what the
      // customer actually wrote.
      const restaurantId = newRestaurantId();
      const event = await seedInjection(restaurantId);

      await processEvent(await eventRow(event.id), stubProvider());

      const rows = await db.execute<{ payload: { complaint_text: string } }>(sql`
        SELECT payload FROM events WHERE id = ${event.id};
      `);
      expect(rows[0].payload.complaint_text).toBe(INJECTION_COMPLAINT_TEXT);
    });
  });
});
