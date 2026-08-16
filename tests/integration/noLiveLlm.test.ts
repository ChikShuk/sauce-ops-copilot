import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/lib/db/client";
import { env } from "../../src/lib/env";
import { getProvider } from "../../src/lib/llm";
import { clearProviderOverride } from "../../src/lib/settings/provider";

/**
 * The guard in tests/setup.integration.ts, asserted.
 *
 * Without this file that guard is a comment: someone deletes two lines, every
 * test still passes, and the suite quietly starts billing an API again. Same
 * standard as the mutation-testing entries in docs/decisions.md — a safety
 * property that nothing checks is a property that has already been lost.
 *
 * Skipped rather than failed under ALLOW_LIVE_LLM, because opting out is a
 * supported thing to do and should not look like a broken suite.
 */
describe.skipIf(process.env.ALLOW_LIVE_LLM === "true")(
  "the integration suite cannot reach a live model",
  () => {
    it("forces the deterministic provider regardless of the developer's .env", () => {
      expect(env.LLM_PROVIDER).toBe("fallback");
    });

    it("removes the API key, so no client can be constructed with credentials", () => {
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    // The env default is only half of it: provider selection is a runtime lookup
    // now, so a stored override has to be neutralised too. It is, because
    // getProvider degrades when the key is missing.
    it("still resolves the fallback writer when a stored override names anthropic", async () => {
      await db.execute(sql`
        INSERT INTO app_settings (key, value) VALUES ('llm_provider', 'anthropic')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
      `);

      try {
        expect((await getProvider()).name).toBe("fallback");
      } finally {
        await clearProviderOverride();
      }
    });
  },
);
