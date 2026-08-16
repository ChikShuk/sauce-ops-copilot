import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// The provider default and the API key are environment, and the suite must not
// depend on the developer's .env either way — both are driven explicitly here,
// the same shape deadLetterFinding.test.ts uses for the failure trigger.
const environment = {
  provider: "fallback" as "fallback" | "anthropic",
  apiKey: undefined as string | undefined,
  toggleEnabled: true,
};

vi.mock("../../src/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/env")>();
  return {
    env: {
      ...actual.env,
      get LLM_PROVIDER() {
        return environment.provider;
      },
      get ANTHROPIC_API_KEY() {
        return environment.apiKey;
      },
      get ENABLE_PROVIDER_TOGGLE() {
        return environment.toggleEnabled;
      },
    },
  };
});

import { PUT } from "../../src/app/api/settings/provider/route";
import { db } from "../../src/lib/db/client";
import { getProvider } from "../../src/lib/llm";
import {
  clearProviderOverride,
  readProviderOverride,
  resolveProviderName,
  writeProviderOverride,
} from "../../src/lib/settings/provider";
import { processEvent } from "../../src/worker/processEvent";
import { eventRowById as eventRow, findingsFor } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";

const AT = new Date("2026-08-14T20:10:00Z");

async function put(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await PUT(
    new Request("http://test.local/api/settings/provider", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("provider setting: the env var is a default, not the only path", () => {
  it("uses LLM_PROVIDER when nothing has been chosen", async () => {
    await clearProviderOverride();
    environment.provider = "anthropic";

    expect(await resolveProviderName()).toEqual({ name: "anthropic", source: "env" });
  });

  it("prefers the stored override, and says the value was chosen", async () => {
    environment.provider = "anthropic";
    await writeProviderOverride("fallback");

    expect(await resolveProviderName()).toEqual({ name: "fallback", source: "override" });
  });

  it("returns to the env default when the override is removed", async () => {
    environment.provider = "anthropic";
    await writeProviderOverride("fallback");
    await clearProviderOverride();

    expect(await resolveProviderName()).toEqual({ name: "anthropic", source: "env" });
  });

  // A row nothing in the app would ever write — a manual UPDATE, a bad
  // migration. The toggle sits on the enrichment path, so an unreadable value
  // must degrade to the environment rather than throw and take a job with it.
  it("ignores a corrupt stored value instead of failing enrichment", async () => {
    environment.provider = "fallback";
    await db.execute(sql`
      INSERT INTO app_settings (key, value) VALUES ('llm_provider', 'gpt-9000')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    `);

    expect(await readProviderOverride()).toBeNull();
    expect(await resolveProviderName()).toEqual({ name: "fallback", source: "env" });

    await clearProviderOverride();
  });
});

describe("getProvider: what the worker actually runs", () => {
  it("returns the deterministic writer when the override names it", async () => {
    environment.provider = "anthropic";
    environment.apiKey = "sk-test-present";
    await writeProviderOverride("fallback");

    expect((await getProvider()).name).toBe("fallback");
  });

  // The failure the toggle exists to prevent: choosing a provider this process
  // cannot serve should degrade, not surface as a 401 halfway through a job.
  it("degrades to the fallback writer when anthropic is chosen with no key", async () => {
    environment.provider = "fallback";
    environment.apiKey = undefined;
    await writeProviderOverride("anthropic");

    expect((await getProvider()).name).toBe("fallback");
  });

  it("returns the anthropic provider when a key is present", async () => {
    environment.apiKey = "sk-test-present";
    await writeProviderOverride("anthropic");

    expect((await getProvider()).name).toBe("anthropic");
  });
});

describe("PUT /api/settings/provider", () => {
  it("writes the override and reports where the value now comes from", async () => {
    environment.toggleEnabled = true;
    environment.provider = "anthropic";
    environment.apiKey = "sk-test-present";
    await clearProviderOverride();

    const res = await put({ provider: "fallback" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "fallback", source: "override" });
    expect(await readProviderOverride()).toBe("fallback");
  });

  // Said at the moment of choosing rather than discovered three seconds later in
  // a summary that came out as a template.
  it("refuses the real model when no API key is configured", async () => {
    environment.toggleEnabled = true;
    environment.apiKey = undefined;
    await clearProviderOverride();

    const res = await put({ provider: "anthropic" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_api_key");
    expect(await readProviderOverride()).toBeNull();
  });

  it("rejects an unknown provider name", async () => {
    environment.toggleEnabled = true;

    const res = await put({ provider: "gpt-9000" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("does not exist when the demo flag is off", async () => {
    environment.toggleEnabled = false;

    const res = await put({ provider: "fallback" });

    expect(res.status).toBe(404);
    environment.toggleEnabled = true;
  });
});

describe("the override reaches enrichment", () => {
  it("writes template prose when the override says fallback, with no provider injected", async () => {
    environment.provider = "anthropic";
    environment.apiKey = "sk-test-present";
    await writeProviderOverride("fallback");

    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });

    // No provider argument: this is the production path, resolving whatever the
    // toggle currently names.
    await processEvent(await eventRow(event.id));

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.status).toBe("ready");
    expect(finding.summary_source).toBe("fallback");
    expect(finding.llm_model).toBeNull();

    await clearProviderOverride();
  });
});
