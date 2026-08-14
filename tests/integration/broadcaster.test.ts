import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db/client";
import { subscribe, type BoardMessage } from "../../src/lib/realtime/broadcaster";
import { processEvent } from "../../src/worker/processEvent";
import { eventRowById as eventRow, resetDb } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";
import { stubProvider } from "../helpers/providers";

const AT = new Date("2026-08-14T20:10:00Z");

beforeEach(async () => {
  await resetDb();
});

// Collects everything the broadcaster pushes, and lets a test wait for the
// next one rather than sleeping past the poll interval and hoping.
function collector() {
  const messages: BoardMessage[] = [];
  let notify: (() => void) | null = null;

  const listener = (message: BoardMessage) => {
    messages.push(message);
    notify?.();
  };

  async function waitForNext(timeoutMs = 5_000): Promise<BoardMessage> {
    const before = messages.length;
    if (messages.length > before) return messages[messages.length - 1];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no board message arrived")),
        timeoutMs,
      );
      notify = () => {
        clearTimeout(timer);
        notify = null;
        resolve();
      };
    });

    return messages[messages.length - 1];
  }

  return { messages, listener, waitForNext };
}

async function ingest(restaurantId: string, occurredAt = AT) {
  const event = await seedEvent({ restaurantId, occurredAt });
  await processEvent(await eventRow(event.id), stubProvider());
  return event;
}

describe("broadcaster", () => {
  it("delivers the board immediately on connect, with nothing highlighted", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    const sink = collector();
    const unsubscribe = await subscribe(sink.listener);

    try {
      expect(sink.messages).toHaveLength(1);
      expect(sink.messages[0].findings).toHaveLength(1);
      expect(sink.messages[0].findings[0].restaurantId).toBe(restaurantId);
      // Highlighting every card on connect would train an operator to ignore
      // the highlight.
      expect(sink.messages[0].changed).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  /**
   * The reconnect case the brief tests, and the one a cached snapshot gets
   * wrong. The poller stops when the last listener leaves, so anything that
   * happens while nobody is connected is invisible to a cache — a browser that
   * disconnects and comes back would be shown the board as it was when it left.
   */
  it("shows a reconnecting client what changed while nobody was listening", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    const first = collector();
    const stop = await subscribe(first.listener);
    expect(first.messages[0].findings[0].status).toBe("ready");
    stop();

    // Nobody is connected, so no poll is running.
    await db.execute(sql`UPDATE findings SET status = 'failed', summary = NULL;`);
    await ingest(newRestaurantId(), new Date(AT.getTime() + 60_000));

    const second = collector();
    const stopAgain = await subscribe(second.listener);

    try {
      const board = second.messages[0];
      expect(board.findings).toHaveLength(2);
      const reconnected = board.findings.find((card) => card.restaurantId === restaurantId);
      expect(reconnected?.status).toBe("failed");
      expect(reconnected?.hasSummary).toBe(false);
    } finally {
      stopAgain();
    }
  });

  it("pushes an update when a finding changes, naming what moved", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    const sink = collector();
    const unsubscribe = await subscribe(sink.listener);

    try {
      const findingId = sink.messages[0].findings[0].id;

      await db.execute(sql`
        UPDATE findings SET status = 'failed' WHERE id = ${findingId};
      `);

      const update = await sink.waitForNext();
      expect(update.changed).toContain(findingId);
      expect(update.findings.find((card) => card.id === findingId)?.status).toBe("failed");
    } finally {
      unsubscribe();
    }
  });

  it("pushes when queue depth moves even though no finding changed", async () => {
    const restaurantId = newRestaurantId();
    const event = await ingest(restaurantId);

    const sink = collector();
    const unsubscribe = await subscribe(sink.listener);

    try {
      expect(sink.messages[0].queue.retrying).toBe(0);

      // next_attempt_at in the future, which is what a job waiting out its
      // backoff actually looks like — and also keeps a worker that happens to
      // be running against this database from claiming the row mid-test.
      await db.execute(sql`
        INSERT INTO event_jobs (event_id, status, attempts, next_attempt_at)
        VALUES (${event.id}, 'failed', 2, now() + interval '1 hour')
        ON CONFLICT (event_id) DO UPDATE
          SET status = 'failed', attempts = 2, next_attempt_at = now() + interval '1 hour';
      `);

      const update = await sink.waitForNext();
      expect(update.queue.retrying).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});
