import { env } from "../env";
import { anthropicProvider } from "./anthropic";
import { fallbackProvider } from "./fallback";
import type { EnrichmentProvider } from "./types";

// The provider is chosen once, at first use. Importing the Anthropic module is
// safe with no API key present because its client is constructed lazily — see
// the comment in anthropic.ts.
export function getProvider(): EnrichmentProvider {
  return env.LLM_PROVIDER === "anthropic" ? anthropicProvider : fallbackProvider;
}
