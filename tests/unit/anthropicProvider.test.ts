import { beforeEach, describe, expect, it, vi } from "vitest";

// The retry contract — "one regeneration on a rejected response, then give up
// and let the caller fall back" — lives in the provider, so it is tested against
// a mocked SDK rather than through a stub that re-implements the same loop.
const create = vi.fn();
const constructorArgs: unknown[] = [];

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
    constructor(options: unknown) {
      constructorArgs.push(options);
    }
  },
  // Declared inside the factory because vi.mock is hoisted above the imports.
  // The real class carries more, but everything the provider can observe about
  // a timeout is that it is a thrown non-EnrichmentValidationError.
  APIConnectionTimeoutError: class extends Error {
    constructor({ message }: { message: string }) {
      super(message);
      this.name = "APIConnectionTimeoutError";
    }
  },
}));

import { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { LLM_TIMEOUT_MS, MAX_LLM_ATTEMPTS, PROCESSING_TIMEOUT_MS } from "../../src/lib/config";
import { anthropicProvider } from "../../src/lib/llm/anthropic";
import type { EnrichmentInput } from "../../src/lib/llm/types";

function message(text: string, overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    ...overrides,
  };
}

const validBody = JSON.stringify({
  issue: "Missing items",
  summary: "Two orders arrived incomplete.",
  recommended_actions: [{ type: "audit_order_accuracy", rationale: "Recurring packing errors." }],
  extracted_tags: ["missing_items"],
  cited_labels: ["E1"],
});

const input: EnrichmentInput = {
  findingId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
  priority: "high",
  drivers: [{ signal: "event_count", level: "medium", detail: "2 related events" }],
  eventCount: 2,
  firstEventAt: new Date("2026-08-14T18:04:00.000Z"),
  lastEventAt: new Date("2026-08-14T19:12:00.000Z"),
  evidence: [
    {
      label: "E1",
      eventId: "11111111-1111-1111-1111-111111111111",
      eventType: "complaint",
      issueClass: "missing_items",
      occurredAt: new Date("2026-08-14T18:04:00.000Z"),
      delayMinutes: null,
      rating: null,
      refundAmountCents: null,
      customerText: "Fries were missing.",
    },
  ],
};

beforeEach(() => {
  create.mockReset();
});

describe("anthropicProvider", () => {
  it("returns a validated enrichment with the model attributed", async () => {
    create.mockResolvedValueOnce(message(validBody));

    const enrichment = await anthropicProvider.enrich(input);

    expect(create).toHaveBeenCalledTimes(1);
    expect(enrichment.source).toBe("llm");
    expect(enrichment.model).toBe("claude-sonnet-5");
    expect(enrichment.citedEventIds).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  it("regenerates exactly once when the response is rejected, then succeeds", async () => {
    create.mockResolvedValueOnce(message("not json at all"));
    create.mockResolvedValueOnce(message(validBody));

    const enrichment = await anthropicProvider.enrich(input);

    expect(create).toHaveBeenCalledTimes(2);
    expect(enrichment.source).toBe("llm");
  });

  it("tells the model why the previous response was rejected", async () => {
    create.mockResolvedValueOnce(message(JSON.stringify({ ...JSON.parse(validBody), cited_labels: ["E99"] })));
    create.mockResolvedValueOnce(message(validBody));

    await anthropicProvider.enrich(input);

    const secondCall = create.mock.calls[1][0] as { messages: { content: string }[] };
    expect(secondCall.messages[0].content).toContain("E99");
    expect(secondCall.messages[0].content).toContain("rejected by the validator");
  });

  it("gives up after MAX_LLM_ATTEMPTS so the caller can fall back", async () => {
    create.mockResolvedValue(message("still not json"));

    await expect(anthropicProvider.enrich(input)).rejects.toThrow(/not valid JSON/);
    expect(create).toHaveBeenCalledTimes(MAX_LLM_ATTEMPTS);
  });

  it("does not regenerate a fabricated citation into acceptance", async () => {
    // Both attempts cite a label that was never issued. The provider must fail
    // rather than strip the citation and keep the sentence.
    create.mockResolvedValue(
      message(JSON.stringify({ ...JSON.parse(validBody), cited_labels: ["E99"] })),
    );

    await expect(anthropicProvider.enrich(input)).rejects.toThrow(/E99/);
    expect(create).toHaveBeenCalledTimes(MAX_LLM_ATTEMPTS);
  });

  it("does not retry a refusal — the same request would be refused again", async () => {
    create.mockResolvedValueOnce(
      message("", { stop_reason: "refusal", stop_details: { category: "cyber" } }),
    );

    await expect(anthropicProvider.enrich(input)).rejects.toThrow(/refused/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry a transport error — only a rejected response is regenerable", async () => {
    create.mockRejectedValueOnce(new Error("connection reset"));

    await expect(anthropicProvider.enrich(input)).rejects.toThrow(/connection reset/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  /**
   * The timeout case the brief asks about, and the one the suite used to fold
   * into "the provider is down".
   *
   * Nothing downstream distinguishes a timeout from any other throw —
   * enrichFinding catches everything and degrades — so the only claim worth
   * asserting here is the one that is distinguishable, and it is a real one:
   * a timeout must NOT be regenerated. A rejected *response* is regenerated,
   * because the same request might parse next time. A deadline that already
   * expired would only expire again, and a second 15s attempt on top of the
   * first would push a healthy worker past PROCESSING_TIMEOUT_MS and get its
   * own job reclaimed underneath it.
   */
  it("does not regenerate after a timeout, unlike a rejected response", async () => {
    create.mockRejectedValue(new APIConnectionTimeoutError({ message: "Request timed out." }));

    await expect(anthropicProvider.enrich(input)).rejects.toThrow(/timed out/i);
    expect(create).toHaveBeenCalledTimes(1);

    // The contrast, in the same test so the asymmetry is impossible to read as
    // an accident: identical call count would mean the regeneration path had
    // stopped working, and the assertion above would still pass.
    create.mockReset();
    create.mockResolvedValue(message(JSON.stringify({ ...JSON.parse(validBody), cited_labels: ["E99"] })));

    await expect(anthropicProvider.enrich(input)).rejects.toThrow(/E99/);
    expect(create).toHaveBeenCalledTimes(MAX_LLM_ATTEMPTS);
  });

  it("keeps the worst case inside the stale-reclaim window", async () => {
    // One attempt bounded by LLM_TIMEOUT_MS, MAX_LLM_ATTEMPTS of them, no SDK
    // retries underneath — the three facts PROCESSING_TIMEOUT_MS is computed
    // from. Asserted together because the arithmetic in config.ts is only
    // sound if all three hold at once.
    create.mockResolvedValueOnce(message(validBody));
    await anthropicProvider.enrich(input);

    expect(create.mock.calls[0][1]).toEqual({ timeout: LLM_TIMEOUT_MS });
    expect(constructorArgs.at(-1)).toMatchObject({ maxRetries: 0 });
    expect(LLM_TIMEOUT_MS * MAX_LLM_ATTEMPTS).toBeLessThan(PROCESSING_TIMEOUT_MS);
  });

  it("treats a truncated response as regenerable", async () => {
    create.mockResolvedValueOnce(message('{"issue":', { stop_reason: "max_tokens" }));
    create.mockResolvedValueOnce(message(validBody));

    await expect(anthropicProvider.enrich(input)).resolves.toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("bounds each call with the timeout PROCESSING_TIMEOUT_MS is derived from", async () => {
    create.mockResolvedValueOnce(message(validBody));

    await anthropicProvider.enrich(input);

    expect(create.mock.calls[0][1]).toEqual({ timeout: LLM_TIMEOUT_MS });
  });

  it("disables the SDK's own retries so MAX_LLM_ATTEMPTS is the real attempt count", async () => {
    // With the SDK's default of 2, the worst case would be 6 HTTP calls against
    // a PROCESSING_TIMEOUT_MS computed from 2 — and a slow-but-alive worker
    // would get its job reclaimed mid-flight.
    create.mockResolvedValueOnce(message(validBody));
    await anthropicProvider.enrich(input);

    expect(constructorArgs.at(-1)).toMatchObject({ maxRetries: 0 });
  });

  it("constrains the response with a json_schema and low effort", async () => {
    create.mockResolvedValueOnce(message(validBody));
    await anthropicProvider.enrich(input);

    const body = create.mock.calls[0][0] as {
      model: string;
      output_config: { effort: string; format: { type: string } };
    };
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
  });
});
