import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/stream/route";
import { deriveCardState, type CardPresentation } from "../../src/lib/findings/cardState";
import type { Enrichment, EnrichmentInput, EnrichmentProvider } from "../../src/lib/llm/types";
import { currentBoard } from "../../src/lib/realtime/broadcaster";
import { runJob } from "../../src/worker/runJob";
import { resetDb } from "../helpers/db";
import { newRestaurantId, postEvent } from "../helpers/factories";
import { boardFrom, frameReader } from "../helpers/sse";

/**
 * "Refresh the page while an event is still processing."
 *
 * A refresh throws away the SSE connection and re-renders from currentBoard()
 * — the one board read that no test called. The risk is not that it crashes;
 * it is that the two paths disagree, so a refresh shows the operator something
 * different from what the live stream was showing a second earlier, and neither
 * is obviously wrong.
 */

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

// Runs the test's own code at the one moment the finding is genuinely
// half-done: enrichFinding has moved it to 'processing' and the model has not
// answered yet.
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

async function firstStreamBoard(): Promise<ReturnType<typeof boardFrom>> {
  const controller = new AbortController();
  const res = await GET(
    new Request("http://test.local/api/stream", { signal: controller.signal }),
  );
  const reader = frameReader(res);
  try {
    await reader.next(); // retry hint
    return boardFrom(await reader.next());
  } finally {
    controller.abort();
  }
}

beforeEach(async () => {
  await resetDb();
});

describe("refreshing the page mid-processing", () => {
  it("renders a processing finding as analyzing, never as a blank card", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    // An array, not a nullable local: a value assigned only inside a callback
    // is narrowed to `never` by the time it is read.
    const painted: CardPresentation[] = [];

    const provider = providerBusyDuring(async () => {
      const board = await currentBoard();
      expect(board.findings).toHaveLength(1);
      painted.push(deriveCardState(board.findings[0]));
    });

    expect(await runJob(`worker-${randomUUID().slice(0, 8)}`, provider)).toBe("succeeded");

    expect(painted).toHaveLength(1);
    const card = painted[0];
    expect(card.state).toBe("analyzing");
    expect(card.label).toBe("Analyzing");
    // The specific failure a cold load is prone to: prose has not been written
    // yet, so a card that renders the summary region unconditionally shows an
    // empty box on every refresh during processing.
    expect(card.placeholder).not.toBeNull();
  });

  it("paints the same board the live stream would have sent", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    const comparisons: { paint: unknown; stream: unknown }[] = [];

    const provider = providerBusyDuring(async () => {
      const paint = await currentBoard();
      const stream = await firstStreamBoard();
      comparisons.push({ paint, stream: { findings: stream.findings, queue: stream.queue } });
    });

    await runJob(`worker-${randomUUID().slice(0, 8)}`, provider);

    expect(comparisons).toHaveLength(1);
    const captured = comparisons[0];

    // The invariant that makes a refresh safe. If these diverge, an operator
    // who reloads sees one thing and the next SSE tick replaces it with
    // another — a flicker that looks like data changing when nothing did.
    expect(captured.paint).toEqual(captured.stream);
  });

  it("agrees with the stream once processing has finished too", async () => {
    const restaurantId = newRestaurantId();
    await ingest(restaurantId);

    await runJob(
      `worker-${randomUUID().slice(0, 8)}`,
      providerBusyDuring(() => Promise.resolve()),
    );

    const paint = await currentBoard();
    const stream = await firstStreamBoard();

    expect(paint.findings).toEqual(stream.findings);
    expect(paint.queue).toEqual(stream.queue);
    expect(deriveCardState(paint.findings[0]).state).toBe("ready");
  });
});
