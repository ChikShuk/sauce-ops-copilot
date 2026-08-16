import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import { enqueueReenrichment } from "@/lib/queue/enrichmentJobs";

export const dynamic = "force-dynamic";

/**
 * Ask for this finding's prose to be rewritten under the provider currently in
 * force.
 *
 * The route enqueues and returns; it never calls the model. That is not
 * fastidiousness — the web process holds no API key and no LLM client, and
 * enrichment that skipped the queue would also skip the status machine, the
 * retry ladder, the DLQ and the attempt accounting that every other enrichment
 * in this system gets. The worker claims this exactly as it claims an event.
 *
 * 202, not 201: the work is accepted, not done. The card then walks
 * processing -> ready over SSE, the same way it does after ingestion.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ findingId: string }> },
) {
  if (!env.ENABLE_PROVIDER_TOGGLE) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { findingId } = await params;

  const rows = await db.execute<{ version: number }>(sql`
    SELECT version FROM findings WHERE id = ${findingId};
  `);

  if (rows.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { jobId, created } = await enqueueReenrichment(findingId, rows[0].version);

  // A second click while one is outstanding is not an error — the partial unique
  // index already guarantees one rewrite per finding, so this reports the
  // request that is actually in flight.
  return NextResponse.json(
    {
      status: created ? "queued" : "already_queued",
      job_id: jobId,
      finding_id: findingId,
      requested_version: rows[0].version,
    },
    { status: 202 },
  );
}
