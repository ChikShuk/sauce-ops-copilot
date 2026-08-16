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

  // The card's headline varied run to run — "late delivery with missing items"
  // one time, "Late delivery with missing items" the next — because nothing
  // specified a form. The prompt now asks for one; this is what guarantees it,
  // since a prompt rule is a mitigation (docs/decisions.md, 2026-08-16).
  describe("issue is normalized to one form", () => {
    it("capitalizes a lower-case first word", () => {
      const parsed = parseEnrichment(response({ issue: "late delivery with missing items" }), labels);
      expect(parsed.issue).toBe("Late delivery with missing items");
    });

    it("strips a trailing period", () => {
      const parsed = parseEnrichment(response({ issue: "Repeated missing items." }), labels);
      expect(parsed.issue).toBe("Repeated missing items");
    });

    it("leaves an already-correct issue untouched", () => {
      const parsed = parseEnrichment(response({ issue: "Repeated missing items" }), labels);
      expect(parsed.issue).toBe("Repeated missing items");
    });

    // The reason this only touches the first character. Lowercasing the rest
    // would look more thorough and would quietly destroy every acronym and
    // proper noun the model legitimately uses.
    it("preserves acronyms and proper nouns after the first word", () => {
      const parsed = parseEnrichment(
        response({ issue: "repeated SLA breaches on DoorDash orders" }),
        labels,
      );
      expect(parsed.issue).toBe("Repeated SLA breaches on DoorDash orders");
    });

    // A period ends a sentence; these carry meaning, and a noun phrase that
    // genuinely ends in one is not the defect being fixed.
    it("keeps a trailing question or exclamation mark", () => {
      expect(parseEnrichment(response({ issue: "Missing items again?" }), labels).issue).toBe(
        "Missing items again?",
      );
      expect(parseEnrichment(response({ issue: "Missing items again!" }), labels).issue).toBe(
        "Missing items again!",
      );
    });

    it("is idempotent", () => {
      const once = parseEnrichment(response({ issue: "late deliveries." }), labels).issue;
      const twice = parseEnrichment(response({ issue: once }), labels).issue;
      expect(twice).toBe(once);
      expect(once).toBe("Late deliveries");
    });
  });
});
