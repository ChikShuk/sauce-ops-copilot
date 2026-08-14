import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db/client";
import { findingDetail, listFindings, queueCounts } from "../../src/lib/findings/queries";
import { processEvent } from "../../src/worker/processEvent";
import { eventRowById as eventRow, resetDb } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";
import { failingProvider, stubProvider } from "../helpers/providers";

const AT = new Date("2026-08-14T20:10:00Z");

// The board is deliberately unscoped by restaurant, so these assertions are
// only exact against a clean table.
beforeEach(async () => {
  await resetDb();
});

async function ingest(spec: {
  restaurantId: string;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
  eventType?: string;
  issueClass?: string;
  orderId?: string | null;
  failing?: boolean;
}) {
  const event = await seedEvent({
    restaurantId: spec.restaurantId,
    occurredAt: spec.occurredAt ?? AT,
    payload: spec.payload,
    eventType: spec.eventType,
    issueClass: spec.issueClass,
    orderId: spec.orderId,
  });

  await processEvent(
    await eventRow(event.id),
    spec.failing ? failingProvider() : stubProvider(),
  );

  return event;
}

// seedEvent inserts an events row directly, bypassing enqueueEvent — so there
// is no job row unless a test puts one there. Retry state is a property of
// those rows, so these tests have to supply them.
//
// next_attempt_at defaults to an hour out: that is what a job waiting out its
// backoff looks like, and it keeps a worker running against this database from
// claiming the row while the test is asserting on it.
async function putJob(
  eventId: string,
  state: { status: string; attempts?: number; inSeconds?: number },
) {
  await db.execute(sql`
    INSERT INTO event_jobs (event_id, status, attempts, next_attempt_at)
    VALUES (${eventId}, ${state.status}, ${state.attempts ?? 0},
            now() + make_interval(secs => ${state.inSeconds ?? 3600}))
    ON CONFLICT (event_id) DO UPDATE
      SET status = EXCLUDED.status,
          attempts = EXCLUDED.attempts,
          next_attempt_at = EXCLUDED.next_attempt_at;
  `);
}

describe("listFindings: the board", () => {
  // Verifies the Known-limitations claim that the dashboard shows every
  // restaurant's findings. It is true because there is no filter to remove.
  it("returns findings for every restaurant, with no tenant scoping", async () => {
    const first = newRestaurantId();
    const second = newRestaurantId();
    await ingest({ restaurantId: first });
    await ingest({ restaurantId: second });

    const board = await listFindings();

    expect(board).toHaveLength(2);
    expect(board.map((card) => card.restaurantId).sort()).toEqual([first, second].sort());
  });

  it("orders by priority before recency, so the board answers what to do first", async () => {
    // Older but critical.
    await ingest({
      restaurantId: newRestaurantId(),
      occurredAt: new Date(AT.getTime() - 60 * 60_000),
      payload: { delay_minutes: 95 },
    });
    // Newer but medium.
    await ingest({ restaurantId: newRestaurantId(), payload: { delay_minutes: 25 } });

    const board = await listFindings();

    expect(board.map((card) => card.priority)).toEqual(["critical", "medium"]);
  });

  it("breaks priority ties by recency", async () => {
    const older = await ingest({
      restaurantId: newRestaurantId(),
      occurredAt: new Date(AT.getTime() - 60 * 60_000),
      payload: { delay_minutes: 95 },
    });
    const newer = await ingest({
      restaurantId: newRestaurantId(),
      payload: { delay_minutes: 95 },
    });

    const board = await listFindings();
    const restaurants = board.map((card) => card.restaurantId);

    expect(restaurants).toEqual([newer.restaurantId, older.restaurantId]);
  });

  it("sorts an unscored finding last rather than first", async () => {
    await ingest({ restaurantId: newRestaurantId(), payload: { delay_minutes: 25 } });

    // A finding correlation has not scored yet. array_position returns NULL for
    // it, and Postgres sorts NULLs first under DESC — without NULLS LAST this
    // would head the board.
    await db.execute(sql`UPDATE findings SET priority = NULL WHERE priority = 'medium';`);
    await ingest({ restaurantId: newRestaurantId(), payload: { delay_minutes: 95 } });

    const board = await listFindings();

    expect(board.map((card) => card.priority)).toEqual(["critical", null]);
  });

  it("carries the persisted drivers, not an empty list", async () => {
    await ingest({ restaurantId: newRestaurantId(), payload: { delay_minutes: 95 } });

    const [card] = await listFindings();

    expect(card.drivers.length).toBeGreaterThan(0);
    expect(card.drivers[0]).toMatchObject({ signal: "delay_minutes", level: "critical" });
    expect(card.drivers[0].detail).toContain("95");
  });

  it("reports whether prose exists without carrying it", async () => {
    await ingest({ restaurantId: newRestaurantId() });
    const [enriched] = await listFindings();
    expect(enriched.hasSummary).toBe(true);
    expect(enriched).not.toHaveProperty("summary");

    await db.execute(sql`UPDATE findings SET summary = NULL, status = 'failed';`);
    const [failed] = await listFindings();
    expect(failed.hasSummary).toBe(false);
  });
});

describe("listFindings: retry state comes from the jobs behind the evidence", () => {
  it("is null when nothing is being retried", async () => {
    await ingest({ restaurantId: newRestaurantId() });
    expect((await listFindings())[0].retry).toBeNull();
  });

  it("surfaces a retrying job so it is distinguishable from a completed result", async () => {
    const event = await ingest({ restaurantId: newRestaurantId() });
    await putJob(event.id, { status: "failed", attempts: 2, inSeconds: 4 });

    const [card] = await listFindings();

    expect(card.retry).not.toBeNull();
    expect(card.retry?.attempts).toBe(2);
    expect(card.retry?.maxAttempts).toBe(5);
  });

  it("reports the soonest retry when several of a finding's jobs are waiting", async () => {
    const restaurantId = newRestaurantId();
    const first = await ingest({ restaurantId });
    const second = await ingest({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
    });

    await putJob(first.id, { status: "failed", attempts: 4, inSeconds: 30 });
    await putJob(second.id, { status: "failed", attempts: 1, inSeconds: 2 });

    const [card] = await listFindings();

    expect(card.retry?.attempts).toBe(1);
  });
});

describe("findingDetail", () => {
  it("returns every evidence row, labelled as the model saw it", async () => {
    const restaurantId = newRestaurantId();
    await ingest({ restaurantId, occurredAt: new Date(AT.getTime() - 120_000) });
    await ingest({ restaurantId, occurredAt: new Date(AT.getTime() - 60_000) });
    await ingest({ restaurantId, occurredAt: AT });

    const [card] = await listFindings();
    const detail = await findingDetail(card.id);

    expect(detail?.evidence.map((item) => item.label)).toEqual(["E1", "E2", "E3"]);
    // Same ordering as fetchEnrichmentSnapshot, so E1 here is the E1 the model
    // was issued rather than a coincidentally similar numbering.
    const occurred = detail?.evidence.map((item) => Date.parse(item.occurredAt)) ?? [];
    expect(occurred).toEqual([...occurred].sort((a, b) => a - b));
  });

  it("marks exactly the events the summary cites", async () => {
    const restaurantId = newRestaurantId();
    await ingest({ restaurantId, occurredAt: new Date(AT.getTime() - 60_000) });
    await ingest({ restaurantId, occurredAt: AT });

    const [card] = await listFindings();
    const detail = await findingDetail(card.id);

    // The stub provider cites the first evidence item and nothing else.
    expect(detail?.citedEventIds).toHaveLength(1);
    expect(detail?.evidence.filter((item) => item.cited)).toHaveLength(1);
    expect(detail?.evidence[0].cited).toBe(true);
    expect(detail?.evidence[1].cited).toBe(false);
  });

  it("records no citations on the degraded path rather than lighting up every event", async () => {
    const restaurantId = newRestaurantId();
    await ingest({ restaurantId, failing: true });
    await ingest({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
      failing: true,
    });

    const [card] = await listFindings();
    const detail = await findingDetail(card.id);

    expect(detail?.summarySource).toBe("fallback");
    expect(detail?.citedEventIds).toBeNull();
    expect(detail?.evidence.every((item) => !item.cited)).toBe(true);
  });

  it("reads the display fields out of each event's payload", async () => {
    const restaurantId = newRestaurantId();
    await ingest({
      restaurantId,
      occurredAt: new Date(AT.getTime() - 60_000),
      payload: { delay_minutes: 42 },
    });
    await ingest({
      restaurantId,
      occurredAt: AT,
      eventType: "negative_review",
      issueClass: "negative_review",
      payload: { rating: 2, review_text: "Cold and late." },
    });

    const [card] = await listFindings();
    const detail = await findingDetail(card.id);

    expect(detail?.evidence[0].delayMinutes).toBe(42);
    expect(detail?.evidence[1].rating).toBe(2);
    expect(detail?.evidence[1].customerText).toBe("Cold and late.");
  });

  it("returns null for a finding that does not exist", async () => {
    expect(await findingDetail("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("queueCounts", () => {
  it("counts the work that has no finding to badge yet", async () => {
    const event = await seedEvent({ restaurantId: newRestaurantId(), occurredAt: AT });

    // A job that has never been claimed, so correlation has not run and there
    // is nothing on the board for it.
    await putJob(event.id, { status: "pending" });
    expect(await queueCounts()).toMatchObject({ queued: 1, analyzing: 0, retrying: 0 });

    await putJob(event.id, { status: "failed", attempts: 1 });
    expect(await queueCounts()).toMatchObject({ queued: 0, retrying: 1 });

    await putJob(event.id, { status: "dead_letter", attempts: 6 });
    expect(await queueCounts()).toMatchObject({ retrying: 0, failed: 1 });
  });

  it("does not count completed work — the findings themselves represent that", async () => {
    const event = await seedEvent({ restaurantId: newRestaurantId(), occurredAt: AT });
    await putJob(event.id, { status: "succeeded", attempts: 1 });

    expect(await queueCounts()).toEqual({ queued: 0, analyzing: 0, retrying: 0, failed: 0 });
  });
});
