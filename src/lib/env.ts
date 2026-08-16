import "dotenv/config";
import { z } from "zod";

// Zod at every boundary includes this one. Previously each consumer hand-rolled
// its own `if (!process.env.X) throw`, which meant a missing ANTHROPIC_API_KEY
// surfaced as a 401 from the provider mid-job rather than as a startup failure.
//
// Parsed once at module load: both the worker and the Next app import this, and
// a bad environment should stop the process before it claims any work.
const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is not set"),
    LLM_PROVIDER: z.enum(["fallback", "anthropic"]).default("fallback"),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Demo affordance, not a feature. See src/worker/processEvent.ts — with this
    // on, an event whose event_id starts with "force_fail_" throws after
    // correlation commits, so the retry -> DLQ -> findings.status='failed'
    // branch can be demonstrated end to end instead of only unit-tested.
    // Defaults to off; .env.example and docker-compose.yml turn it on.
    ENABLE_DEMO_FAILURE_TRIGGER: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // The other demo affordance: with this on, the dashboard can switch the
    // enrichment provider at runtime (a row in app_settings overriding
    // LLM_PROVIDER) and ask for a finding's prose to be rewritten. Off by
    // default in code, on in .env.example.
    //
    // In production, provider selection is deployment config — a control that
    // lets anyone with the dashboard open change what the whole system spends
    // money on is a demo device, not a feature.
    ENABLE_PROVIDER_TOGGLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic",
      });
    }
  });

// `.env.example` ships keys with empty values (ANTHROPIC_API_KEY=), and dotenv
// loads those as "" rather than leaving them unset. Without this, copying the
// example file and running with the default fallback provider would fail
// validation on a key that is legitimately absent.
function blankToUndefined(source: NodeJS.ProcessEnv): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value === "" ? undefined : value]),
  );
}

function parseEnv(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse(blankToUndefined(process.env));

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }

  return parsed.data;
}

export const env = parseEnv();
