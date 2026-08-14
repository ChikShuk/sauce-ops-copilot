import { NextResponse } from "next/server";
import { recordAction } from "@/lib/actions/recordAction";
import { operatorActionSchema } from "@/lib/actions/schema";

export const dynamic = "force-dynamic";

// Zod at the boundary, same shape as the ingestion route: parse, and return the
// issues verbatim rather than a summary of them.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const { findingId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = operatorActionSchema.safeParse(body);
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

  try {
    const recorded = await recordAction(findingId, parsed.data);

    if (!recorded) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // Returns the resulting state so the client can settle its optimistic
    // update immediately rather than waiting on the next board snapshot.
    return NextResponse.json(recorded, { status: 201 });
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "operator_action_failed",
        finding_id: findingId,
        action_type: parsed.data.action_type,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json(
      { error: "internal_error", message: "Could not record that action" },
      { status: 500 },
    );
  }
}
