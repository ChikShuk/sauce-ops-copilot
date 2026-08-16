/**
 * Types only, no imports.
 *
 * `provider.ts` reaches the database, so a client component importing anything
 * from it — even a type — is one careless `import` away from pulling Drizzle and
 * the connection pool into the browser bundle. The shapes the UI needs live
 * here, where that cannot happen. Same reasoning as `lib/config.ts`.
 */
export type ProviderName = "fallback" | "anthropic";

export type ProviderToggleState = {
  /** ENABLE_PROVIDER_TOGGLE. False hides the control entirely. */
  enabled: boolean;
  active: ProviderName;
  /** "env" means nobody has chosen — this is the LLM_PROVIDER default. */
  source: "override" | "env";
  /**
   * Whether the web app can see an ANTHROPIC_API_KEY. The worker is a separate
   * process, so this is a strong hint rather than a guarantee — under Compose
   * they share one .env.
   */
  hasKey: boolean;
};
