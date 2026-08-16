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
 * Force `issue` into one form: first character capitalized, no trailing period.
 *
 * The same input shape produced "late delivery with missing items" on one run
 * and "Late delivery with missing items" on the next, because nothing specified
 * a form. That is the card's headline, so an inconsistent one reads as sloppy on
 * the most prominent element of the board.
 *
 * The prompt now asks for this too, and that alone is not enough: the 2026-08-16
 * entry in docs/decisions.md measured a correctly-worded prompt rule being
 * ignored in 2 of 18 samples. An instruction the model follows most of the time
 * is a mitigation, and anything that must always hold belongs here.
 *
 * The same entry *rejected* a deterministic check on prose, and the difference is
 * the reason this one is right: that check would have **rejected** a response and
 * degraded the finding to the fallback writer, costing an operator a real
 * narrative on a false positive. This only **transforms** — it classifies
 * nothing, refuses nothing, and its worst case is doing nothing at all. A rule
 * that can only no-op is categorically safer than one that can reject, and that
 * is the test to apply to the next output-shape rule rather than re-deriving it.
 *
 * Only the first character is touched. Lowercasing the rest would read as
 * thorough and would wreck "SLA", "DoorDash" and every proper noun the model
 * legitimately uses. Trailing `?` and `!` survive for the same reason — they
 * carry meaning a period does not.
 */
export function toSentenceCase(value: string): string {
  const withoutTrailingPeriod = value.replace(/\.+$/, "");
  return withoutTrailingPeriod.charAt(0).toUpperCase() + withoutTrailingPeriod.slice(1);
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
    // After clamp, not before: truncating at MAX_ISSUE_CHARS can leave a
    // trailing character of its own, so the normalizer has to see the final
    // string rather than the model's.
    issue: toSentenceCase(clamp(output.issue, MAX_ISSUE_CHARS)),
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
