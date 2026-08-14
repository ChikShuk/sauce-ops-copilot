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

// A provider that is down. Stands in for a timeout, a 529, or a refusal — from
// enrichFinding's perspective those are the same event: the model produced
// nothing usable.
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
