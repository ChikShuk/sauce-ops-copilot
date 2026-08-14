import {
  MAX_ISSUE_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_RECOMMENDED_ACTIONS,
  MAX_SUMMARY_CHARS,
  enrichmentOutputSchema,
} from "./schema";
import type { RecommendedAction } from "./types";
import type { ExtractedTag } from "./schema";

// Distinguishable so the provider can tell "the model produced something we
// won't accept" (retryable — regenerate once) from a transport or auth failure
// (not retryable in the same way).
export class EnrichmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrichmentValidationError";
  }
}

export type ParsedEnrichment = {
  issue: string;
  summary: string;
  actions: RecommendedAction[];
  tags: ExtractedTag[];
  citedEventIds: string[];
};

function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/**
 * Validate a model response against the schema and the evidence it was given.
 *
 * Pure by design: the regenerate-then-fallback path is the most security-
 * relevant behavior in this slice, and it should be testable without a network
 * or a database.
 *
 * A citation the model made up is a validation *failure*, not a field to drop.
 * Dropping it would leave the sentence it was supporting standing with nothing
 * underneath — which is precisely the unsupported conclusion the grounding rule
 * exists to prevent. Rejecting sends the caller back for one regeneration and
 * then to the deterministic fallback.
 */
export function parseEnrichment(
  raw: string,
  labelToEventId: ReadonlyMap<string, string>,
): ParsedEnrichment {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new EnrichmentValidationError(
      `response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = enrichmentOutputSchema.safeParse(parsedJson);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new EnrichmentValidationError(`response failed schema validation: ${detail}`);
  }

  const output = result.data;

  const unknownLabels = output.cited_labels.filter((label) => !labelToEventId.has(label));
  if (unknownLabels.length > 0) {
    throw new EnrichmentValidationError(
      `cited labels not in the evidence set: ${unknownLabels.join(", ")}`,
    );
  }

  if (labelToEventId.size > 0 && output.cited_labels.length === 0) {
    throw new EnrichmentValidationError("summary cited no evidence");
  }

  // Order-preserving dedupe: a label cited twice is sloppy, not hostile.
  const citedEventIds = [...new Set(output.cited_labels)].map(
    (label) => labelToEventId.get(label) as string,
  );

  return {
    issue: clamp(output.issue, MAX_ISSUE_CHARS),
    summary: clamp(output.summary, MAX_SUMMARY_CHARS),
    // Over-listing actions is verbosity, not a safety problem, so this clamps
    // rather than rejects — unlike an out-of-allowlist type, which the schema
    // has already refused above.
    actions: output.recommended_actions.slice(0, MAX_RECOMMENDED_ACTIONS).map((action) => ({
      type: action.type,
      rationale: clamp(action.rationale, MAX_RATIONALE_CHARS),
    })),
    tags: [...new Set(output.extracted_tags)],
    citedEventIds,
  };
}
