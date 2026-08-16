import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { env } from "../env";
import { logJson } from "../log";
import type { ProviderName } from "./types";

/**
 * Which enrichment provider is in force, as a runtime lookup rather than a
 * startup constant.
 *
 * `LLM_PROVIDER` is parsed once per process (env.ts), and the worker is a
 * separate process from the web app — so a browser control cannot change what
 * the worker read at boot. A row in `app_settings` can, because both processes
 * already talk to Postgres. The env var stays the default; the row overrides it
 * when present.
 *
 * That ordering is what keeps "a reviewer with no API key lands on the fallback
 * writer" true without anyone configuring anything: the override is an override,
 * never the only path.
 */
export const PROVIDER_SETTING_KEY = "llm_provider";

// The same two names env.ts accepts. Deliberately re-declared rather than
// imported from the env schema: this one validates a value coming out of a
// database that a future migration or a manual UPDATE could put anything into.
const providerNameSchema = z.enum(["fallback", "anthropic"]);

export type { ProviderName };

export type ResolvedProvider = {
  name: ProviderName;
  /** Where the value came from, so the UI can say "default" rather than "chosen". */
  source: "override" | "env";
};

/**
 * The override, or null when none is set or the stored value is unusable.
 *
 * Every failure mode here returns null rather than throwing. This function sits
 * on the enrichment path, and a toggle that can break enrichment is worse than
 * no toggle: a corrupt row or an unreachable settings table degrades to "use the
 * environment", which is exactly what the system did before the toggle existed.
 */
export async function readProviderOverride(): Promise<ProviderName | null> {
  let raw: string | undefined;

  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value FROM app_settings WHERE key = ${PROVIDER_SETTING_KEY};
    `);
    raw = rows[0]?.value;
  } catch (err) {
    logJson({
      msg: "provider_setting.read_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (raw === undefined) return null;

  const parsed = providerNameSchema.safeParse(raw);
  if (!parsed.success) {
    logJson({ msg: "provider_setting.invalid_value", value: raw });
    return null;
  }

  return parsed.data;
}

export async function writeProviderOverride(name: ProviderName): Promise<void> {
  await db.execute(sql`
    INSERT INTO app_settings (key, value)
    VALUES (${PROVIDER_SETTING_KEY}, ${name})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  `);

  logJson({ msg: "provider_setting.written", provider: name });
}

export async function clearProviderOverride(): Promise<void> {
  await db.execute(sql`DELETE FROM app_settings WHERE key = ${PROVIDER_SETTING_KEY};`);
}

export async function resolveProviderName(): Promise<ResolvedProvider> {
  const override = await readProviderOverride();

  return override === null
    ? { name: env.LLM_PROVIDER, source: "env" }
    : { name: override, source: "override" };
}
