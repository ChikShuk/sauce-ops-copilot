import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { correlateEvent } from "../../src/lib/correlation/correlateEvent";
import { db } from "../../src/lib/db/client";
import { processEvent } from "../../src/worker/processEvent";
import { eventRowById as eventRow, findingsFor } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";
import { stubProvider } from "../helpers/providers";

const AT = new Date("2026-08-14T20:10:00Z");

/**
 * The crashed-winner shape: a worker correlates an event, commits, and dies
 * before enrichment writes. Correlation ran, so the finding holds the new
 * evidence; enrichment did not, so its prose still describes the old set.
 *
 * Calling correlateEvent without enrichFinding reproduces exactly that,
 * because those are the two halves processEvent runs in sequence.
 */
async function correlateWithoutEnriching(eventId: string) {
  return correlateEvent(await eventRow(eventId));
}

describe("enrichment repair: prose that fell behind its evidence", () => {
  it("rewrites a summary describing fewer events than the finding now holds", async () => {
    const restaurantId = newRestaurantId();
    const first = await seedEvent({ restaurantId, occurredAt: AT });
    await processEvent(await eventRow(first.id), stubProvider({ issue: "One event" }));

    const second = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    await correlateWithoutEnriching(second.id);

    const stale = (await findingsFor(restaurantId))[0];
    expect(stale.issue).toBe("One event");
    expect(stale.event_count).toBe(2);
    // The signal the dashboard renders: the prose describes an older version of
    // the evidence set than the finding now holds.
    expect(stale.enriched_version).toBeLessThan(stale.version);

    // Stale-reclaim hands the same event back. correlateEvent returns
    // 'already_attached', which used to return early and skip enrichment
    // forever — that early return was the only reason this state was permanent.
    const provider = stubProvider({ issue: "Both events" });
    await processEvent(await eventRow(second.id), provider);

    const repaired = (await findingsFor(restaurantId))[0];
    expect(provider.calls).toHaveLength(1);
    expect(repaired.issue).toBe("Both events");
    expect(repaired.status).toBe("ready");
    expect(repaired.enriched_version).toBe(repaired.version);
  });

  // The comparison this repair rests on has to be a version comparison.
  // enriched_at is wall time and last_event_at is the business time an event
  // occurred, so a timestamp form would be false precisely when staleness is
  // real — including for every backfilled event, whose occurred_at is days
  // before any prose could possibly have been written about it.
  it("detects staleness for a backfilled finding, whose evidence is older than any prose", async () => {
    const restaurantId = newRestaurantId();
    const old = new Date(AT.getTime() - 5 * 24 * 60 * 60_000);
    const first = await seedEvent({ restaurantId, occurredAt: old });
    await processEvent(await eventRow(first.id), stubProvider({ issue: "One old event" }));

    const second = await seedEvent({
      restaurantId,
      occurredAt: new Date(old.getTime() + 60_000),
    });
    await correlateWithoutEnriching(second.id);

    const stale = (await findingsFor(restaurantId))[0];
    // Prose written today about an event from five days ago: enriched_at is far
    // *later* than last_event_at, so the timestamp comparison says "current".
    expect(Date.parse(stale.enriched_at ?? "")).toBeGreaterThan(
      Date.parse(stale.last_event_at),
    );
    // The version comparison gets it right.
    expect(stale.enriched_version).toBeLessThan(stale.version);

    const provider = stubProvider({ issue: "Both old events" });
    await processEvent(await eventRow(second.id), provider);

    expect(provider.calls).toHaveLength(1);
    expect((await findingsFor(restaurantId))[0].issue).toBe("Both old events");
  });

  it("hands the repair the persisted drivers rather than an empty list", async () => {
    const restaurantId = newRestaurantId();
    const first = await seedEvent({
      restaurantId,
      occurredAt: AT,
      payload: { delay_minutes: 95 },
    });
    await processEvent(await eventRow(first.id), stubProvider());

    const second = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
      payload: { delay_minutes: 20 },
    });
    await correlateWithoutEnriching(second.id);

    const provider = stubProvider();
    await processEvent(await eventRow(second.id), provider);

    // Without priority_drivers the repair would have to either recompute the
    // severity rules or send the model no reason for the priority at all.
    const drivers = provider.calls[0].drivers;
    expect(drivers.length).toBeGreaterThan(0);
    expect(drivers.some((driver) => driver.signal === "delay_minutes")).toBe(true);
  });

  it("recovers a finding left stuck in processing", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });
    const correlated = await correlateWithoutEnriching(event.id);

    // The other shape of the same crash: the worker died after enrichFinding
    // claimed the finding but before it wrote.
    await db.execute(sql`
      UPDATE findings SET status = 'processing' WHERE id = ${correlated.findingId};
    `);

    await processEvent(await eventRow(event.id), stubProvider());

    const repaired = (await findingsFor(restaurantId))[0];
    expect(repaired.status).toBe("ready");
    expect(repaired.summary).toBe("Stubbed summary.");
  });

  it("repairs a finding whose very first enrichment never ran", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });
    await correlateWithoutEnriching(event.id);

    expect((await findingsFor(restaurantId))[0].enriched_at).toBeNull();

    const provider = stubProvider();
    await processEvent(await eventRow(event.id), provider);

    expect(provider.calls).toHaveLength(1);
    expect((await findingsFor(restaurantId))[0].status).toBe("ready");
  });
});

describe("enrichment repair: redelivery that changed nothing", () => {
  it("still spends no LLM call when the prose is already current", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });
    const row = await eventRow(event.id);

    await processEvent(row, stubProvider());

    // The repair check must not turn every redelivery into a regeneration —
    // that would make the stale-reclaim path expensive rather than safe.
    const second = stubProvider({ issue: "Should never be written" });
    await processEvent(row, second);

    expect(second.calls).toHaveLength(0);
    expect((await findingsFor(restaurantId))[0].issue).toBe("Stubbed issue");
  });
});
