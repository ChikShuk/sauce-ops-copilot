import { NextResponse } from "next/server";
import { findingDetail } from "@/lib/findings/queries";

export const dynamic = "force-dynamic";

// The detail panel is fetched on demand rather than streamed with the board:
// evidence and prose are an order of magnitude larger than a card, and at most
// one finding is open at a time. The board stream carries `version`, so the
// panel knows to re-fetch without the stream having to carry the payload.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ findingId: string }> },
) {
  const { findingId } = await params;

  const detail = await findingDetail(findingId);
  if (!detail) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(detail);
}
