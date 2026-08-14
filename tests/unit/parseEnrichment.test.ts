import { describe, expect, it } from "vitest";
import { EnrichmentValidationError, parseEnrichment } from "../../src/lib/llm/parse";
import { MAX_RECOMMENDED_ACTIONS, MAX_SUMMARY_CHARS } from "../../src/lib/llm/schema";

const labels = new Map([
  ["E1", "11111111-1111-1111-1111-111111111111"],
  ["E2", "22222222-2222-2222-2222-222222222222"],
]);

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issue: "Missing items during evening shift",
    summary: "Two orders arrived incomplete within the hour.",
    recommended_actions: [{ type: "audit_order_accuracy", rationale: "Recurring packing errors." }],
    extracted_tags: ["missing_items"],
    cited_labels: ["E1"],
    ...overrides,
  });
}

describe("parseEnrichment", () => {
  it("maps validated labels back to real event ids", () => {
    const parsed = parseEnrichment(response({ cited_labels: ["E2", "E1"] }), labels);

    expect(parsed.citedEventIds).toEqual([
      "22222222-2222-2222-2222-222222222222",
      "11111111-1111-1111-1111-111111111111",
    ]);
  });

  it("dedupes a label cited twice", () => {
    const parsed = parseEnrichment(response({ cited_labels: ["E1", "E1"] }), labels);
    expect(parsed.citedEventIds).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  it("rejects a response that is not JSON", () => {
    expect(() => parseEnrichment("Sure! Here is the summary:", labels)).toThrow(
      EnrichmentValidationError,
    );
  });

  it("clamps an overlong summary rather than failing", () => {
    const parsed = parseEnrichment(response({ summary: "x".repeat(5000) }), labels);
    expect(parsed.summary).toHaveLength(MAX_SUMMARY_CHARS);
  });

  it("clamps rather than rejects an over-long action list", () => {
    const parsed = parseEnrichment(
      response({
        recommended_actions: [
          { type: "contact_customer", rationale: "a" },
          { type: "issue_refund", rationale: "b" },
          { type: "comp_next_order", rationale: "c" },
          { type: "escalate_to_manager", rationale: "d" },
        ],
      }),
      labels,
    );

    expect(parsed.actions).toHaveLength(MAX_RECOMMENDED_ACTIONS);
  });

  // Layer 2 of the injection defense. These cases assume the model DID obey the
  // injected instructions — a separate claim from "the model didn't obey", and
  // the only one of the two that can be asserted deterministically. Every one
  // of them must be a rejection, not a silent repair.
  describe("when the model obeyed an injected instruction", () => {
    it("rejects an action type outside the allowlist", () => {
      expect(() =>
        parseEnrichment(
          response({
            recommended_actions: [{ type: "delete_all_findings", rationale: "cleanup" }],
          }),
          labels,
        ),
      ).toThrow(EnrichmentValidationError);
    });

    it("rejects a fabricated citation instead of dropping it", () => {
      // The injected text asks for "E99". Dropping the label and keeping the
      // sentence it supported would leave an unsupported claim standing, which
      // is exactly what the grounding rule exists to prevent — so this has to
      // fail the whole response and force a regeneration.
      expect(() => parseEnrichment(response({ cited_labels: ["E99"] }), labels)).toThrow(
        /cited labels not in the evidence set: E99/,
      );
    });

    it("rejects a mix of real and fabricated citations", () => {
      expect(() =>
        parseEnrichment(response({ cited_labels: ["E1", "E99"] }), labels),
      ).toThrow(EnrichmentValidationError);
    });

    it("rejects an injected extra top-level key", () => {
      expect(() =>
        parseEnrichment(response({ status: "resolved" }), labels),
      ).toThrow(EnrichmentValidationError);
    });

    it("rejects a summary that cites nothing at all", () => {
      expect(() => parseEnrichment(response({ cited_labels: [] }), labels)).toThrow(
        /cited no evidence/,
      );
    });
  });

  it("allows an empty citation list when there is no evidence to cite", () => {
    const parsed = parseEnrichment(response({ cited_labels: [] }), new Map());
    expect(parsed.citedEventIds).toEqual([]);
  });
});
