import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { resolveProviderName, writeProviderOverride } from "@/lib/settings/provider";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  provider: z.enum(["fallback", "anthropic"]),
});

/**
 * Switch the enrichment provider for both processes, at runtime.
 *
 * Writes a row; that is the whole endpoint. The worker reads it on its next
 * enrichment, which is what makes this work across a process boundary without a
 * restart, a signal, or a shared cache.
 */
export async function PUT(req: Request) {
  // 404 rather than 403: with the flag off this control does not exist, and a
  // reviewer poking at the API should see the same thing the UI shows them.
  if (!env.ENABLE_PROVIDER_TOGGLE) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "validation_error",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  // Refused here rather than discovered at enrichment time. Without this,
  // selecting the real model with no key configured would look like it worked
  // and then quietly produce template summaries — the provider factory degrades
  // rather than throwing, which is right for a running job and wrong as the only
  // feedback an operator gets.
  //
  // This is the *web app's* environment. Under Compose both processes share one
  // .env, so it is a strong signal rather than a guarantee about the worker —
  // the same caveat the force-fail flag carries in page.tsx.
  if (parsed.data.provider === "anthropic" && !env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      {
        error: "no_api_key",
        message:
          "No ANTHROPIC_API_KEY is configured, so the real model cannot run. Set one in .env and restart, or stay on the deterministic writer.",
      },
      { status: 400 },
    );
  }

  await writeProviderOverride(parsed.data.provider);

  return NextResponse.json(await resolveProviderName());
}
