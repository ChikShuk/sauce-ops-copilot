import Anthropic from "@anthropic-ai/sdk";
import { LLM_TIMEOUT_MS, MAX_LLM_ATTEMPTS } from "../config";
import { env } from "../env";
import { logJson } from "../log";
import { EnrichmentValidationError, parseEnrichment } from "./parse";
import { buildPrompt } from "./prompt";
import { buildOutputJsonSchema } from "./schema";
import type { Enrichment, EnrichmentInput, EnrichmentProvider } from "./types";

// Narration, not reasoning. Correlation, priority, and evidence are already
// decided by the time this runs, so the model is writing two or three sentences
// and picking from an allowlist using facts it was handed. A frontier model
// would be paying Opus rates for prose — the deterministic boundary is exactly
// what makes the cheaper model sufficient here. See docs/decisions.md.
export const ENRICHMENT_MODEL = "claude-sonnet-5";

// Structured output is short. The ceiling exists so a runaway generation fails
// fast rather than burning the whole timeout.
const MAX_TOKENS = 4096;

const CORRECTION_PREFIX =
  "Your previous response was rejected by the validator. Fix it and return only the corrected JSON object.";

// Constructed on first use, not at module load: the SDK throws when it can find
// no API key, and this module is imported unconditionally by the provider
// factory — including on the fallback-only path, which must work with no key at
// all.
//
// maxRetries: 0 is load-bearing, not a preference. The SDK retries twice by
// default, so leaving it alone would make the real worst case 6 HTTP calls
// against a PROCESSING_TIMEOUT_MS derived (in config.ts) from
// MAX_LLM_ATTEMPTS = 2 — a slow-but-alive worker would get its job reclaimed
// mid-flight and burn a retry it never earned. Our bounded retry is the only
// retry, so the arithmetic in config.ts stays true.
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });
  }
  return client;
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function callModel(
  system: string,
  user: string,
  correction: string | null,
): Promise<Anthropic.Message> {
  return getClient().messages.create(
    {
      model: ENRICHMENT_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      output_config: {
        // Narration doesn't need deep reasoning, and the timeout is 15s.
        effort: "low",
        format: { type: "json_schema", schema: buildOutputJsonSchema() },
      },
      messages: [
        { role: "user", content: correction === null ? user : `${user}\n\n${correction}` },
      ],
    },
    // The TS SDK takes milliseconds.
    { timeout: LLM_TIMEOUT_MS },
  );
}

async function enrich(input: EnrichmentInput): Promise<Enrichment> {
  const { system, user } = buildPrompt(input);
  const labelToEventId = new Map(input.evidence.map((item) => [item.label, item.eventId]));

  let correction: string | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt += 1) {
    try {
      const message = await callModel(system, user, correction);

      // A refusal is a decision, not a hiccup — regenerating the same request
      // would just spend the budget to be refused again.
      if (message.stop_reason === "refusal") {
        throw new Error(
          `model refused: ${message.stop_details?.category ?? "unspecified"}`,
        );
      }

      if (message.stop_reason === "max_tokens") {
        throw new EnrichmentValidationError("response truncated at max_tokens");
      }

      const parsed = parseEnrichment(extractText(message.content), labelToEventId);

      return {
        ...parsed,
        source: "llm",
        model: message.model,
      };
    } catch (err) {
      lastError = err;

      // Only a rejected *response* is worth regenerating. A 401, a network
      // failure, or a refusal will produce the same outcome next time.
      if (!(err instanceof EnrichmentValidationError)) {
        throw err;
      }

      logJson({
        msg: "llm.response_rejected",
        finding_id: input.findingId,
        attempt,
        max_attempts: MAX_LLM_ATTEMPTS,
        reason: err.message,
      });

      correction = `${CORRECTION_PREFIX} Reason: ${err.message}`;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`enrichment failed after ${MAX_LLM_ATTEMPTS} attempts`);
}

export const anthropicProvider: EnrichmentProvider = {
  name: "anthropic",
  enrich,
};
