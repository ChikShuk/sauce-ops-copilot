import { env } from "../env";
import { logJson } from "../log";
import { resolveProviderName } from "../settings/provider";
import { anthropicProvider } from "./anthropic";
import { fallbackProvider } from "./fallback";
import type { EnrichmentProvider } from "./types";

/**
 * The provider in force right now.
 *
 * Resolved per call rather than once at first use, which is what lets the
 * dashboard's toggle take effect in a worker that is already running. The cost
 * is one indexed single-row SELECT per enrichment, next to an LLM call that
 * takes seconds.
 *
 * Importing the Anthropic module is safe with no API key present because its
 * client is constructed lazily — see the comment in anthropic.ts.
 */
export async function getProvider(): Promise<EnrichmentProvider> {
  const { name, source } = await resolveProviderName();

  // A toggle can ask for a provider this process cannot serve. Degrading here
  // means the finding still gets prose from the deterministic writer; not
  // degrading means a 401 from the API mid-job, which would be indistinguishable
  // from a real outage in the logs.
  if (name === "anthropic" && !env.ANTHROPIC_API_KEY) {
    logJson({ msg: "provider.no_api_key", requested: name, source, using: "fallback" });
    return fallbackProvider;
  }

  return name === "anthropic" ? anthropicProvider : fallbackProvider;
}
