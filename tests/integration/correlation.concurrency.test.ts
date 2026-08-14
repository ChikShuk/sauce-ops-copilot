import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { correlateEvent } from "../../src/lib/correlation/correlateEvent";
import { db } from "../../src/lib/db/client";
import { evidenceFor, findingsFor } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";

const AT = new Date("2026-08-14T20:10:00Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("concurrent correlation", () => {
  it("two workers, no existing finding: exactly one is created and both events attach", async () => {
    const restaurantId = newRestaurantId();

    const [a, b] = await Promise.all([
      seedEvent({ restaurantId, occurredAt: AT }),
      seedEvent({ restaurantId, occurredAt: new Date(AT.getTime() + 60_000) }),
    ]);

    // Both find no open finding and race to INSERT; the partial unique index
    // lets one win, and the loser retries once in a fresh transaction where the
    // winner's finding is visible.
    const [ra, rb] = await Promise.all([correlateEvent(a), correlateEvent(b)]);

    expect(ra.findingId).toBe(rb.findingId);

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(1);
    expect(findings[0].event_count).toBe(2);
    expect(await evidenceFor(findings[0].id)).toHaveLength(2);
  });

  it("a burst of concurrent events for one restaurant produces one finding with all evidence", async () => {
    const restaurantId = newRestaurantId();
    const count = 6;

    const seeded = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        seedEvent({ restaurantId, occurredAt: new Date(AT.getTime() + i * 60_000) }),
      ),
    );

    const results = await Promise.all(seeded.map((event) => correlateEvent(event)));

    const findingIds = new Set(results.map((r) => r.findingId));
    expect(findingIds.size).toBe(1);

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(1);
    expect(findings[0].event_count).toBe(count);
    expect(await evidenceFor(findings[0].id)).toHaveLength(count);

    // No lost updates: every attach bumped the version exactly once.
    expect(findings[0].version).toBeGreaterThanOrEqual(count + 1);
  });

  // The tests above pass whether or not the race actually occurs — under load
  // the transactions often just serialize, and a green run proves nothing about
  // the recovery path. This one forces the collision deterministically by
  // holding a competing transaction open across the correlation attempt, so the
  // 23505 is guaranteed and the retry is genuinely exercised.
  it("recovers when a concurrent creator wins the race (forced 23505)", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A competing worker inserts the open finding but does not commit yet.
    const competitor = db.transaction(async (tx) => {
      const at = AT.toISOString();
      await tx.execute(sql`
        INSERT INTO findings (restaurant_id, status, event_count, first_event_at, last_event_at)
        VALUES (${restaurantId}, 'accepted', 0, ${at}, ${at});
      `);
      await hold;
    });

    await sleep(250); // let the competing INSERT land, still uncommitted

    // Watch for the retry log: "attached" alone would also be the outcome if
    // the race never happened and the lookup simply found the row, so the
    // outcome on its own cannot prove the recovery path ran.
    const logged = vi.spyOn(console, "log");

    // correlateEvent's own lookup sees nothing (the competitor is uncommitted),
    // so it takes the create path — and its INSERT blocks on the unique index
    // against the competitor's in-flight row.
    const correlation = correlateEvent(event);

    await sleep(250);
    release(); // commit the competitor -> our blocked INSERT now fails 23505
    await competitor;

    const result = await correlation;

    const retried = logged.mock.calls
      .flat()
      .some((line) => typeof line === "string" && line.includes("correlation.insert_race_retry"));
    logged.mockRestore();

    // The 23505 was actually raised, matched by SQLSTATE + constraint name, and
    // recovered from — not merely assumed.
    expect(retried).toBe(true);

    // The retry ran in a fresh transaction, saw the winner, and attached.
    expect(result.outcome).toBe("attached");

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(1);
    expect(findings[0].event_count).toBe(1);
    expect(await evidenceFor(findings[0].id)).toEqual([event.id]);
  });

  it("concurrent events for different restaurants do not interfere", async () => {
    const a = newRestaurantId();
    const b = newRestaurantId();

    const [ea, eb] = await Promise.all([
      seedEvent({ restaurantId: a, occurredAt: AT }),
      seedEvent({ restaurantId: b, occurredAt: AT }),
    ]);
    await Promise.all([correlateEvent(ea), correlateEvent(eb)]);

    expect(await findingsFor(a)).toHaveLength(1);
    expect(await findingsFor(b)).toHaveLength(1);
  });
});
