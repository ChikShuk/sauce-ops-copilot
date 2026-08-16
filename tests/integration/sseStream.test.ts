import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/stream/route";
import type { Enrichment, EnrichmentInput, EnrichmentProvider } from "../../src/lib/llm/types";
import type { BoardMessage } from "../../src/lib/realtime/broadcaster";
import { runJob } from "../../src/worker/runJob";
import { findingsFor, resetDb } from "../helpers/db";
import { newRestaurantId, postEvent } from "../helpers/factories";
import { boardFrom, frameReader } from "../helpers/sse";

/**
 * "Disconnect the dashboard during processing and reconnect."
 *
 * broadcaster.test.ts already covers the subscribe/unsubscribe/resubscribe
 * cycle beneath this — including the slice-6 regression where a reconnecting
 * client was served the cached board it left behind. What it does not cover is
 * the route itself: the ReadableStream, the retry hint, and the abort handler
 * that stops a closed tab's subscription from outliving it. Those are the parts
 * a browser actually talks to.
 *
 * Every reconnect assertion below is on the FIRST frame of the second
 * connection. Asserting on a later frame would pass even with the cache bug
 * restored, because the poller refreshes the stale board a second later — the
 * bug is invisible except in the first thing a reconnecting client is handed.
 */

// Opening a stream is two steps (await the Response, then wrap its body), and
// every test needs both.
async function connect(): Promise<{
  reader: ReturnType<typeof frameReader>;
  abort: () => void;
}> {
  const controller = new AbortController();
  const res = await GET(
    new Request("http://test.local/api/stream", { signal: controller.signal }),
  );

  expect(res.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
  expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");

  return { reader: frameReader(res), abort: () => controller.abort() };
}

// The first frame is always the reconnect hint; the board follows it.
async function firstBoard(reader: ReturnType<typeof frameReader>): Promise<BoardMessage> {
  const retry = await reader.next();
  expect(retry.raw.trim()).toBe("retry: 3000");
  return boardFrom(await reader.next());
}

/**
 * Reads board frames until one satisfies `until`, ignoring keepalives.
 *
 * The poller emits on every change it notices, so a finding's trip from queued
 * to ready can arrive as one frame or three depending on tick timing. Waiting
 * for a condition rather than counting frames keeps that a scheduling detail —
 * and every frame read on the way is validated by boardFrom, which is the point
 * of reading them one at a time instead of sleeping past them.
 */
async function boardWhere(
  reader: ReturnType<typeof frameReader>,
  until: (board: BoardMessage) => boolean,
  maxFrames = 10,
): Promise<BoardMessage> {
  for (let read = 0; read < maxFrames; read += 1) {
    const frame = await reader.next();
    if (frame.event !== "board") continue;

    const board = boardFrom(frame);
    if (until(board)) return board;
  }
  throw new Error(`no matching board arrived within ${maxFrames} frames`);
}

async function ingest(restaurantId: string): Promise<string> {
  const response = await postEvent(restaurantId, {
    event_id: `evt_${randomUUID()}`,
    event_type: "delivery_delay",
    order_id: "order_5001",
    occurred_at: new Date(Date.now() - 60_000).toISOString(),
    payload: { delay_minutes: 40 },
  });

  const id = response.body.id;
  if (id === undefined) throw new Error(`ingestion failed: ${JSON.stringify(response.body)}`);
  return id;
}

/**
 * A provider that runs the test's own code while the model is notionally
 * thinking. enrichFinding puts the finding into 'processing' before calling the
 * provider, so this is the only point at which a dashboard can observe a
 * half-done finding without faking the status with an UPDATE.
 */
function providerBusyDuring(during: () => Promise<void>): EnrichmentProvider {
  return {
    name: "busy",
    async enrich(input: EnrichmentInput): Promise<Enrichment> {
      await during();
      return {
        issue: "Stubbed issue",
        summary: "Stubbed summary.",
        actions: [{ type: "contact_customer", rationale: "Stubbed rationale." }],
        tags: ["other"],
        citedEventIds: input.evidence.slice(0, 1).map((item) => item.eventId),
        source: "llm",
        model: "stub-model-1",
        usage: { inputTokens: 1_200, outputTokens: 300, costMicrosUsd: 5_400 },
      };
    },
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("the SSE route", () => {
  it("opens with the browser's reconnect delay, then a full board", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    const { reader, abort } = await connect();
    try {
      const board = await firstBoard(reader);
      expect(board.type).toBe("board");
      // Nothing is highlighted on connect — for this client every card is new.
      expect(board.changed).toEqual([]);
      expect(board.queue.queued).toBe(1);
    } finally {
      abort();
    }
  });

  it("shows a client that disconnected mid-processing the finished state when it returns", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    // Collected into an array rather than a nullable local: a value assigned
    // only inside a callback is narrowed to `never` by the time it is read.
    const midFlight: BoardMessage[] = [];

    // Disconnect happens while the model is still running, so the board this
    // client last saw is genuinely mid-processing.
    const provider = providerBusyDuring(async () => {
      const { reader, abort } = await connect();
      try {
        midFlight.push(await firstBoard(reader));
      } finally {
        abort();
        await reader.expectDone();
      }
    });

    const outcome = await runJob(`worker-${randomUUID().slice(0, 8)}`, provider);
    expect(outcome).toBe("succeeded");

    // What the operator was looking at when their connection dropped.
    expect(midFlight).toHaveLength(1);
    const seen = midFlight[0];
    expect(seen.findings).toHaveLength(1);
    expect(seen.findings[0].status).toBe("processing");
    expect(seen.findings[0].hasSummary).toBe(false);

    // The reconnect. This is the assertion the slice-6 cache bug fails: the
    // finding changed from 'processing' to 'ready' entirely while nobody was
    // connected, so a board cached at disconnect cannot contain it.
    const { reader, abort } = await connect();
    try {
      const board = await firstBoard(reader);
      expect(board.findings).toHaveLength(1);
      expect(board.findings[0].id).toBe(seen.findings[0].id);
      expect(board.findings[0].status).toBe("ready");
      expect(board.findings[0].hasSummary).toBe(true);
      expect(board.queue.queued).toBe(0);
      expect(board.queue.analyzing).toBe(0);
    } finally {
      abort();
    }
  });

  /**
   * The connect frame is built by `subscribe`; every frame after it is built by
   * the poller. Two call paths, and only the first was ever read here — so a
   * poller emitting a board the dashboard refuses was invisible to this file.
   * That happened: updates went out without `llmUsage`, the client dropped all
   * of them, and the board froze on its connect snapshot while still reporting
   * itself live.
   *
   * `llmUsage` is asserted explicitly rather than left to the schema, because it
   * is the field that carries a *nullable object* — the shape most likely to be
   * dropped by a serializer or a stale build, and the one a cast hides best.
   */
  it("keeps polled updates readable by the dashboard, not just the connect frame", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    const { reader, abort } = await connect();
    try {
      // Correlation runs in the worker, so at connect there is a job and no
      // finding. Everything asserted below therefore arrived on the poll path.
      const connected = await firstBoard(reader);
      expect(connected.findings).toEqual([]);

      const outcome = await runJob(
        `worker-${randomUUID().slice(0, 8)}`,
        providerBusyDuring(() => Promise.resolve()),
      );
      expect(outcome).toBe("succeeded");

      const board = await boardWhere(reader, (next) => next.findings[0]?.status === "ready");
      expect(board.findings[0].restaurantId).toBe(restaurantId);
      expect(board.findings[0].llmUsage).toEqual({
        inputTokens: 1_200,
        outputTokens: 300,
        costMicrosUsd: 5_400,
      });
    } finally {
      abort();
    }
  });

  it("closes the stream when the client aborts", async () => {
    await ingest(newRestaurantId());

    const { reader, abort } = await connect();
    await firstBoard(reader);

    abort();

    // Not merely "goes quiet": the route's abort handler must close the
    // controller, which is the same call that unsubscribes it from the poller.
    // A leaked subscription would leave this stream open and the reader waiting.
    await reader.expectDone();
  });

  it("serves a later connection correctly after an earlier one was aborted", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    const dropped = await connect();
    await firstBoard(dropped.reader);
    dropped.abort();
    await dropped.reader.expectDone();

    // The broadcaster is process-wide and shared. An abort that removed the
    // wrong listener, or left the poller pointing at a dead one, would surface
    // here rather than in the aborted connection.
    const outcome = await runJob(
      `worker-${randomUUID().slice(0, 8)}`,
      providerBusyDuring(() => Promise.resolve()),
    );
    expect(outcome).toBe("succeeded");
    expect((await findingsFor(restaurantId))[0].status).toBe("ready");

    const { reader, abort } = await connect();
    try {
      const board = await firstBoard(reader);
      expect(board.findings).toHaveLength(1);
      expect(board.findings[0].status).toBe("ready");
    } finally {
      abort();
    }
  });
});
