import { z } from "zod";

// Operator verbs — what a restaurant operator would actually go and do. The
// brief's own examples are of this shape ("contact the affected customer",
// "review the packaging workflow during the evening shift").
//
// Deliberately NOT operator_actions.action_type (mark_reviewed / mark_resolved /
// thumbs_up / thumbs_down). Those are what an operator does *to a finding* in
// the dashboard; these are what they do *about the problem*. Sharing one enum
// would conflate two unrelated concepts and make recommendations circular —
// "we recommend you mark this reviewed" is not advice.
export const RECOMMENDED_ACTION_TYPES = [
  "contact_customer",
  "issue_refund",
  "comp_next_order",
  "escalate_to_manager",
  "check_kitchen_capacity",
  "review_courier_assignment",
  "audit_order_accuracy",
  "no_action_needed",
] as const;

export type RecommendedActionType = (typeof RECOMMENDED_ACTION_TYPES)[number];

// A finer-grained read of free customer text than issue_class, which is derived
// deterministically from structured fields only. These two taxonomies overlap
// by design and must not be merged: issue_class drives correlation and
// priority, extracted_tags drive nothing and are display metadata.
export const EXTRACTED_TAGS = [
  "missing_items",
  "wrong_order",
  "late_delivery",
  "cold_food",
  "rude_courier",
  "packaging",
  "payment_issue",
  "other",
] as const;

export type ExtractedTag = (typeof EXTRACTED_TAGS)[number];

export const MAX_RECOMMENDED_ACTIONS = 3;
export const MAX_ISSUE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 800;
export const MAX_RATIONALE_CHARS = 200;

// Structured outputs reject minLength/maxLength/minItems/maxItems, so this
// schema carries no length constraints at all — bounds are clamped in code
// after parsing (see parse.ts). Keeping the schema free of them means the same
// object can be both the API's JSON Schema and our validator, rather than
// maintaining two drifting definitions.
//
// strictObject (not object) so additionalProperties: false is emitted: an
// injected extra top-level key is a validation failure, not silently stripped.
export const enrichmentOutputSchema = z.strictObject({
  issue: z.string(),
  summary: z.string(),
  recommended_actions: z.array(
    z.strictObject({
      type: z.enum(RECOMMENDED_ACTION_TYPES),
      rationale: z.string(),
    }),
  ),
  extracted_tags: z.array(z.enum(EXTRACTED_TAGS)),
  // Opaque evidence labels (E1..En), never event UUIDs. Validated against the
  // set we issued; see parse.ts.
  cited_labels: z.array(z.string()),
});

export type EnrichmentOutput = z.infer<typeof enrichmentOutputSchema>;

// The `$schema` key zod emits is metadata, not a constraint — strip it rather
// than send a key the structured-outputs validator has no use for.
function stripSchemaKeyword(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

export function buildOutputJsonSchema(): Record<string, unknown> {
  return stripSchemaKeyword(
    z.toJSONSchema(enrichmentOutputSchema, { target: "draft-2020-12" }) as Record<string, unknown>,
  );
}
