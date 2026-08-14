import { NextResponse } from "next/server";
import { normalizeEvent } from "@/lib/events/normalize";
import { ingestEventSchema } from "@/lib/events/schema";
import { enqueueEvent } from "@/lib/queue/enqueueEvent";

// Returns before any AI/worker processing (invariant 2): the only work
// after validation is one INSERT ... RETURNING. event_jobs.status stays at
// its DB default 'pending' — the worker (slice 3) picks it up
// independently, never invoked from this handler.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ restaurantId: string }> },
) {
  const { restaurantId } = await params;
  if (!restaurantId) {
    return NextResponse.json(
      { error: "invalid_restaurant_id", message: "restaurantId is required" },
      { status: 400 },
    );
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

  const parsed = ingestEventSchema.safeParse(body);
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

  const row = normalizeEvent(restaurantId, parsed.data);

  try {
    const result = await enqueueEvent(row);
    return NextResponse.json(
      { status: "accepted", duplicate: result.duplicate, event_id: row.eventId, id: result.id },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "ingestion_failed",
        event_id: row.eventId,
        restaurant_id: row.restaurantId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json(
      { error: "internal_error", message: "Unexpected error processing event" },
      { status: 500 },
    );
  }
}
