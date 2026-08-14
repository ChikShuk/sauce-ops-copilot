import { describe, expect, it } from "vitest";
import {
  EXTRACTED_TAGS,
  RECOMMENDED_ACTION_TYPES,
  buildOutputJsonSchema,
  enrichmentOutputSchema,
} from "../../src/lib/llm/schema";

const validOutput = {
  issue: "Missing items during evening shift",
  summary: "Three orders in two hours arrived incomplete.",
  recommended_actions: [{ type: "audit_order_accuracy", rationale: "Recurring packing errors." }],
  extracted_tags: ["missing_items"],
  cited_labels: ["E1", "E2"],
};

describe("enrichmentOutputSchema", () => {
  it("accepts a well-formed response", () => {
    expect(enrichmentOutputSchema.safeParse(validOutput).success).toBe(true);
  });

  it("rejects an action type outside the allowlist", () => {
    const result = enrichmentOutputSchema.safeParse({
      ...validOutput,
      recommended_actions: [{ type: "delete_all_findings", rationale: "cleanup" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tag outside the enum", () => {
    const result = enrichmentOutputSchema.safeParse({
      ...validOutput,
      extracted_tags: ["escalate_to_root"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra top-level keys rather than stripping them", () => {
    const result = enrichmentOutputSchema.safeParse({ ...validOutput, priority: "critical" });
    expect(result.success).toBe(false);
  });

  it("rejects an extra key inside a recommended action", () => {
    const result = enrichmentOutputSchema.safeParse({
      ...validOutput,
      recommended_actions: [
        { type: "contact_customer", rationale: "Apologise.", execute: true },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("buildOutputJsonSchema", () => {
  const schema = buildOutputJsonSchema();

  it("drops the $schema metadata keyword", () => {
    expect(schema).not.toHaveProperty("$schema");
  });

  it("closes every object so injected keys are refused by the API too", () => {
    expect(schema.additionalProperties).toBe(false);

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const actionItems = properties.recommended_actions.items as Record<string, unknown>;
    expect(actionItems.additionalProperties).toBe(false);
  });

  it("marks every field required", () => {
    expect(schema.required).toEqual([
      "issue",
      "summary",
      "recommended_actions",
      "extracted_tags",
      "cited_labels",
    ]);
  });

  it("carries the allowlists into the schema the model is constrained by", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    const actionItems = properties.recommended_actions.items as {
      properties: { type: { enum: string[] } };
    };
    expect(actionItems.properties.type.enum).toEqual([...RECOMMENDED_ACTION_TYPES]);

    const tagItems = properties.extracted_tags.items as { enum: string[] };
    expect(tagItems.enum).toEqual([...EXTRACTED_TAGS]);
  });

  // Structured outputs reject minLength/maxLength/minItems/maxItems/pattern and
  // numeric bounds. If a future edit adds a .max() to the Zod schema, the emitted
  // JSON Schema would carry a keyword the API refuses — and the failure would be
  // a 400 at runtime on every enrichment, not a type error. Pin it here instead.
  it("emits only keywords structured outputs supports", () => {
    const unsupported = [
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "pattern",
      "minimum",
      "maximum",
      "multipleOf",
    ];

    const serialized = JSON.stringify(schema);
    for (const keyword of unsupported) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
  });
});
