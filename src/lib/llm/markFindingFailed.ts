import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { logJson } from "../log";

/**
 * Mark the finding this event evidences as failed, after its job dead-lettered.
 *
 * This is the only path to `findings.status = 'failed'`. An LLM outage is
 * explicitly not a job failure (docs/decisions.md), so `failed` means something
 * genuinely unexpected happened *after* correlation committed: the finding
 * exists with real evidence and a real priority, but we could not finish
 * processing the event that belongs to it.
 *
 * If correlation never committed there is no finding_events row and this is a
 * no-op — the event is lost to the DLQ, but no finding is misrepresented.
 *
 * Unconditional on the current status: a finding that was 'ready' from earlier
 * evidence and has since absorbed an event we failed to process is stale, and
 * saying so is more honest than leaving it looking complete.
 */
export async function markFindingFailedForEvent(eventId: string): Promise<void> {
  const updated = await db.execute<{ id: string }>(sql`
    UPDATE findings
    SET status = 'failed'
    WHERE id = (SELECT finding_id FROM finding_events WHERE event_id = ${eventId})
    RETURNING id;
  `);

  if (updated.length === 0) {
    logJson({ msg: "finding.no_failure_target", event_id: eventId });
    return;
  }

  logJson({ msg: "finding.marked_failed", event_id: eventId, finding_id: updated[0].id });
}
