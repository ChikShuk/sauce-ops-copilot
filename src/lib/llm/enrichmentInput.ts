import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../correlation/evidence";
import type { Priority } from "../correlation/priority";
import {
  readCustomerText,
  readDelayMinutes,
  readRating,
  readRefundAmountCents,
} from "../events/payload";
import type { LabeledEvidence } from "./types";

// Enrichment reads evidence separately from correlation rather than widening
// correlation/evidence.ts, and the reason is the invariant, not convenience:
// that reader deliberately drops `payload` so nothing in the correlation path
// can start branching on free text. Two readers over the same join is the
// deterministic/model boundary made physical — the same reason correlation/ and
// llm/ are separate folders.

type EnrichmentEvidenceRow = {
  event_id: string;
  event_type: string;
  issue_class: string;
  occurred_at: string;
  payload: unknown;
};

type FindingRow = {
  version: number;
  priority: string | null;
  event_count: number;
  first_event_at: string;
  last_event_at: string;
};

export type FindingEnrichmentSnapshot = {
  version: number;
  priority: Priority | null;
  eventCount: number;
  firstEventAt: Date;
  lastEventAt: Date;
  evidence: LabeledEvidence[];
};

export async function fetchEnrichmentSnapshot(
  tx: SqlExecutor,
  findingId: string,
): Promise<FindingEnrichmentSnapshot | null> {
  const findings = await tx.execute<FindingRow>(sql`
    SELECT version, priority, event_count, first_event_at, last_event_at
    FROM findings
    WHERE id = ${findingId};
  `);

  if (findings.length === 0) {
    return null;
  }

  const finding = findings[0];

  const rows = await tx.execute<EnrichmentEvidenceRow>(sql`
    SELECT e.id AS event_id, e.event_type, e.issue_class, e.occurred_at, e.payload
    FROM finding_events fe
    JOIN events e ON e.id = fe.event_id
    WHERE fe.finding_id = ${findingId}
    ORDER BY e.occurred_at ASC, e.id ASC;
  `);

  // Labels are positional and opaque. The model never sees an event id, so a
  // hallucinated citation cannot coincidentally name a real row — it names
  // something outside the issued set, which is detectable.
  const evidence: LabeledEvidence[] = rows.map((row, index) => ({
    label: `E${index + 1}`,
    eventId: row.event_id,
    eventType: row.event_type,
    issueClass: row.issue_class,
    occurredAt: new Date(row.occurred_at),
    delayMinutes: row.event_type === "delivery_delay" ? readDelayMinutes(row.payload) : null,
    rating: row.event_type === "negative_review" ? readRating(row.payload) : null,
    refundAmountCents: row.event_type === "refund" ? readRefundAmountCents(row.payload) : null,
    customerText: readCustomerText(row.event_type, row.payload),
  }));

  return {
    version: finding.version,
    priority: finding.priority as Priority | null,
    eventCount: finding.event_count,
    firstEventAt: new Date(finding.first_event_at),
    lastEventAt: new Date(finding.last_event_at),
    evidence,
  };
}
