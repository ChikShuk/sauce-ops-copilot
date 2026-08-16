import { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { parseEnrichment } from "../../src/lib/llm/parse";
import type { Enrichment, EnrichmentInput, EnrichmentProvider } from "../../src/lib/llm/types";

export type StubProvider = EnrichmentProvider & { calls: EnrichmentInput[] };

// Stands in for a healthy model: cites the first piece of evidence and returns
// a well-formed result. Records its inputs so tests can assert on call counts
// and on what actually reached the prompt layer.
export function stubProvider(
  overrides: Partial<Omit<Enrichment, "source" | "model">> = {},
): StubProvider {
  const calls: EnrichmentInput[] = [];

  return {
    name: "stub",
    calls,
    enrich(input: EnrichmentInput): Promise<Enrichment> {
      calls.push(input);
      return Promise.resolve({
        issue: "Stubbed issue",
        summary: "Stubbed summary.",
        actions: [{ type: "contact_customer", rationale: "Stubbed rationale." }],
        tags: ["other"],
        citedEventIds: input.evidence.slice(0, 1).map((item) => item.eventId),
        source: "llm",
        model: "stub-model-1",
        ...overrides,
      });
    },
  };
}

// A provider that is down. Stands in for a 529 or a refusal — from
// enrichFinding's perspective those are the same event: the model produced
// nothing usable.
//
// A timeout is deliberately NOT folded in here any more; it has its own
// provider below, because "a timeout degrades to fallback" is a claim the brief
// asks about specifically and it should not be proven by a test named for
// something else.
export function failingProvider(message = "simulated provider outage"): StubProvider {
  const calls: EnrichmentInput[] = [];

  return {
    name: "failing",
    calls,
    enrich(input: EnrichmentInput): Promise<Enrichment> {
      calls.push(input);
      return Promise.reject(new Error(message));
    },
  };
}

/**
 * A provider whose call outlives its deadline.
 *
 * Throws the SDK's own APIConnectionTimeoutError, which is what a real
 * LLM_TIMEOUT_MS expiry surfaces as: the deadline is the SDK's per-request
 * `timeout` option, not a race in our code, so there is no earlier point at
 * which a timeout is observable. Nothing downstream of the provider can tell
 * this apart from any other throw — that convergence is deliberate, and the
 * tests using this provider assert the consequences that *are* distinguishable:
 * that a timeout is not regenerated the way a schema rejection is, and that it
 * lands as a successful degrade rather than a retry.
 */
export function timingOutProvider(): StubProvider {
  const calls: EnrichmentInput[] = [];

  return {
    name: "timing-out",
    calls,
    enrich(input: EnrichmentInput): Promise<Enrichment> {
      calls.push(input);
      return Promise.reject(
        new APIConnectionTimeoutError({ message: "Request timed out." }),
      );
    },
  };
}

/**
 * A provider that runs raw model text through the real validator.
 *
 * This is how the malformed-output and injection-obedience paths get exercised
 * end to end without a network: the text is whatever we say the model returned,
 * but everything downstream — schema validation, the action allowlist, citation
 * checking — is production code, and a rejection propagates to enrichFinding
 * exactly as a real one would.
 *
 * The retry-then-give-up loop is not simulated here; it belongs to the Anthropic
 * provider and is tested directly against a mocked SDK in
 * tests/unit/anthropicProvider.test.ts.
 */
export function rawTextProvider(raw: string): StubProvider {
  const calls: EnrichmentInput[] = [];

  return {
    name: "raw-text",
    calls,
    enrich(input: EnrichmentInput): Promise<Enrichment> {
      calls.push(input);

      const labelToEventId = new Map(input.evidence.map((item) => [item.label, item.eventId]));
      const parsed = parseEnrichment(raw, labelToEventId);
      return Promise.resolve({ ...parsed, source: "llm", model: "raw-text-model" });
    },
  };
}
