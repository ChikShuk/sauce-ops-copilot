import { sql } from "drizzle-orm";
import { z } from "zod";
import { parsePriorityDrivers } from "../correlation/drivers";
import { PRIORITY_LEVELS, type Priority } from "../correlation/priority";
import { db } from "../db/client";
import {
  readCustomerText,
  readDelayMinutes,
  readRating,
  readRefundAmountCents,
} from "../events/payload";
import { FINDING_STATUSES } from "./types";
import type {
  EvidenceItem,
  FindingCard,
  FindingDetail,
  FindingStatus,
  LlmUsage,
  OperatorActionRecord,
  QueueCounts,
  RecommendedAction,
} from "./types";

// The board is a demo-scale surface and this bound exists so a runaway
// simulator can't turn one SSE tick into a megabyte. Findings past it are the
// oldest and lowest-priority by the sort below.
const BOARD_LIMIT = 200;

// PRIORITY_LEVELS is the single source of priority ordering. Interpolated here
// rather than written inline as ARRAY['low','medium',...]: a level added in
// priority.ts and not mirrored here would sort silently wrong, and neither lint
// nor typecheck reads SQL inside a template literal.
//
// NULLS LAST is load-bearing. `priority` is nullable and array_position returns
// NULL for a value not in the array, and Postgres sorts NULLs *first* under
// DESC — without this an unscored finding would head the board.
const priorityRank = sql`array_position(
  ARRAY[${sql.join(
    PRIORITY_LEVELS.map((level) => sql`${level}`),
    sql`, `,
  )}]::text[],
  f.priority
)`;

// timestamptz comes back from postgres.js already parsed into a Date, but a
// driver or a cast can just as easily hand back the string. Normalize once
// here so everything downstream of a query holds an ISO string.
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

const stringArraySchema = z.array(z.string());
const actionsSchema = z.array(z.object({ type: z.string(), rationale: z.string() }));

// jsonb columns are untyped on the way out. Every one of them degrades to an
// empty/absent value rather than throwing: a malformed tag array must not take
// the whole board down.
function parseStringArray(raw: unknown): string[] {
  const parsed = stringArraySchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function parseActions(raw: unknown): RecommendedAction[] {
  const parsed = actionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// The audit row's context is jsonb written by recordAction, but a hand-edited
// or older row could carry anything. Only the version is needed for display, and
// its absence is not worth failing a panel render over.
const contextVersionSchema = z.object({ version: z.number() });

function parseContextVersion(raw: unknown): number | null {
  const parsed = contextVersionSchema.safeParse(raw);
  return parsed.success ? parsed.data.version : null;
}

function parseCitedEventIds(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  const parsed = stringArraySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseStatus(raw: unknown): FindingStatus {
  const value = String(raw);
  return (FINDING_STATUSES as readonly string[]).includes(value)
    ? (value as FindingStatus)
    : "accepted";
}

function parsePriority(raw: unknown): Priority | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw);
  return (PRIORITY_LEVELS as readonly string[]).includes(value) ? (value as Priority) : null;
}

type CardRow = {
  id: string;
  restaurant_id: string;
  order_id: string | null;
  version: number;
  status: string;
  priority: string | null;
  priority_drivers: unknown;
  issue: string | null;
  has_summary: boolean;
  summary_source: string | null;
  llm_input_tokens: number | string | null;
  llm_output_tokens: number | string | null;
  llm_cost_micros_usd: number | string | null;
  extracted_tags: unknown;
  event_count: number;
  first_event_at: unknown;
  last_event_at: unknown;
  enriched_at: unknown;
  enriched_version: number | null;
  updated_at: unknown;
  closed_at: unknown;
  reviewed_at: unknown;
  resolved_at: unknown;
  retry_attempts: number | null;
  retry_max_attempts: number | null;
  retry_next_attempt_at: unknown;
};

// bigint arrives from postgres.js as a string, integer as a number. Both are
// well inside the safe-integer range here — a million dollars is 1e12 micros —
// so a single Number() is correct for either.
function toNumberOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// The three columns are written together and are null together on a finding no
// model has touched. Tokens are what makes the record exist — cost can be null
// on its own when the model that ran has no rate on file.
function toUsage(row: CardRow): LlmUsage | null {
  const inputTokens = toNumberOrNull(row.llm_input_tokens);
  const outputTokens = toNumberOrNull(row.llm_output_tokens);
  if (inputTokens === null || outputTokens === null) return null;

  return {
    inputTokens,
    outputTokens,
    costMicrosUsd: toNumberOrNull(row.llm_cost_micros_usd),
  };
}

function toCard(row: CardRow): FindingCard {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    orderId: row.order_id,
    version: row.version,
    status: parseStatus(row.status),
    priority: parsePriority(row.priority),
    drivers: parsePriorityDrivers(row.priority_drivers),
    issue: row.issue,
    hasSummary: row.has_summary === true,
    summarySource:
      row.summary_source === "llm" || row.summary_source === "fallback"
        ? row.summary_source
        : null,
    llmUsage: toUsage(row),
    extractedTags: parseStringArray(row.extracted_tags),
    eventCount: row.event_count,
    firstEventAt: toIso(row.first_event_at),
    lastEventAt: toIso(row.last_event_at),
    enrichedAt: toIsoOrNull(row.enriched_at),
    enrichedVersion: row.enriched_version,
    updatedAt: toIso(row.updated_at),
    closedAt: toIsoOrNull(row.closed_at),
    reviewedAt: toIsoOrNull(row.reviewed_at),
    resolvedAt: toIsoOrNull(row.resolved_at),
    retry:
      row.retry_attempts === null || row.retry_max_attempts === null
        ? null
        : {
            attempts: row.retry_attempts,
            maxAttempts: row.retry_max_attempts,
            nextAttemptAt: toIso(row.retry_next_attempt_at),
          },
  };
}

const CARD_COLUMNS = sql`
  f.id, f.restaurant_id, f.order_id, f.version, f.status, f.priority,
  f.priority_drivers, f.issue, (f.summary IS NOT NULL) AS has_summary,
  f.summary_source, f.llm_input_tokens, f.llm_output_tokens,
  f.llm_cost_micros_usd, f.extracted_tags,
  f.event_count, f.first_event_at, f.last_event_at, f.enriched_at,
  f.enriched_version, f.updated_at, f.closed_at, f.reviewed_at, f.resolved_at
`;

// A finding's retry state is a property of the jobs behind its evidence, not of
// the finding itself — findings have no retry concept. LATERAL rather than a
// GROUP BY because we want one specific row (the soonest retry) and its whole
// shape, not aggregates over several columns that could come from different jobs.
const RETRY_LATERAL = sql`
  LEFT JOIN LATERAL (
    SELECT j.attempts AS retry_attempts,
           j.max_attempts AS retry_max_attempts,
           j.next_attempt_at AS retry_next_attempt_at
    FROM finding_events fe
    JOIN event_jobs j ON j.event_id = fe.event_id
    WHERE fe.finding_id = f.id AND j.status = 'failed'
    ORDER BY j.next_attempt_at ASC
    LIMIT 1
  ) jobs ON true
`;

/**
 * The board. Deliberately unfiltered by restaurant — there is no auth and no
 * tenant scoping in this build, and the README says so plainly under Known
 * limitations. Sorted by priority before recency because the board answers
 * "what do I deal with first", not "what just happened"; sorting by time would
 * make the priority rail decoration.
 */
export async function listFindings(): Promise<FindingCard[]> {
  const rows = await db.execute<CardRow>(sql`
    SELECT ${CARD_COLUMNS}, jobs.retry_attempts, jobs.retry_max_attempts,
           jobs.retry_next_attempt_at
    FROM findings f
    ${RETRY_LATERAL}
    ORDER BY ${priorityRank} DESC NULLS LAST, f.last_event_at DESC
    LIMIT ${BOARD_LIMIT};
  `);

  return rows.map(toCard);
}

type EvidenceRow = {
  id: string;
  event_id: string;
  event_type: string;
  issue_class: string;
  occurred_at: unknown;
  received_at: unknown;
  payload: unknown;
};

export async function findingDetail(findingId: string): Promise<FindingDetail | null> {
  const rows = await db.execute<
    CardRow & {
      summary: string | null;
      recommended_actions: unknown;
      llm_model: string | null;
      cited_event_ids: unknown;
    }
  >(sql`
    SELECT ${CARD_COLUMNS}, f.summary, f.recommended_actions, f.llm_model,
           f.cited_event_ids, jobs.retry_attempts, jobs.retry_max_attempts,
           jobs.retry_next_attempt_at
    FROM findings f
    ${RETRY_LATERAL}
    WHERE f.id = ${findingId};
  `);

  if (rows.length === 0) return null;

  const row = rows[0];
  const citedEventIds = parseCitedEventIds(row.cited_event_ids);
  const cited = new Set(citedEventIds ?? []);

  // Same ORDER BY as fetchEnrichmentSnapshot, so the E1..En labels below are
  // the labels the model was actually issued for this evidence set rather than
  // a second, coincidentally-similar numbering.
  const evidenceRows = await db.execute<EvidenceRow>(sql`
    SELECT e.id, e.event_id, e.event_type, e.issue_class, e.occurred_at,
           e.received_at, e.payload
    FROM finding_events fe
    JOIN events e ON e.id = fe.event_id
    WHERE fe.finding_id = ${findingId}
    ORDER BY e.occurred_at ASC, e.id ASC;
  `);

  const evidence: EvidenceItem[] = evidenceRows.map((item, index) => ({
    id: item.id,
    label: `E${index + 1}`,
    clientEventId: item.event_id,
    eventType: item.event_type,
    issueClass: item.issue_class,
    occurredAt: toIso(item.occurred_at),
    receivedAt: toIso(item.received_at),
    delayMinutes:
      item.event_type === "delivery_delay" ? readDelayMinutes(item.payload) : null,
    rating: item.event_type === "negative_review" ? readRating(item.payload) : null,
    refundAmountCents:
      item.event_type === "refund" ? readRefundAmountCents(item.payload) : null,
    customerText: readCustomerText(item.event_type, item.payload),
    cited: cited.has(item.id),
  }));

  const actionRows = await db.execute<{
    id: string;
    action_type: string;
    note: string | null;
    actor: string;
    created_at: unknown;
    context: unknown;
  }>(sql`
    SELECT id, action_type, note, actor, created_at, context
    FROM operator_actions
    WHERE finding_id = ${findingId}
    ORDER BY created_at DESC, id DESC;
  `);

  const actions: OperatorActionRecord[] = actionRows.map((item) => ({
    id: item.id,
    actionType: item.action_type,
    note: item.note,
    actor: item.actor,
    createdAt: toIso(item.created_at),
    version: parseContextVersion(item.context),
  }));

  return {
    ...toCard(row),
    summary: row.summary,
    recommendedActions: parseActions(row.recommended_actions),
    llmModel: row.llm_model,
    citedEventIds,
    evidence,
    actions,
  };
}

type QueueRow = {
  queued: number | string;
  analyzing: number | string;
  retrying: number | string;
  failed: number | string;
};

/**
 * Job-level counts, for work that has no finding to badge yet.
 *
 * An event whose job fails *before* correlation commits has no finding_events
 * row and therefore nothing on the board — without this the dashboard would sit
 * silent while the queue was busy retrying. 'succeeded' is deliberately absent:
 * completed work is represented by the findings themselves.
 */
export async function queueCounts(): Promise<QueueCounts> {
  const rows = await db.execute<QueueRow>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending') AS queued,
      count(*) FILTER (WHERE status = 'processing') AS analyzing,
      count(*) FILTER (WHERE status = 'failed') AS retrying,
      count(*) FILTER (WHERE status = 'dead_letter') AS failed
    FROM event_jobs;
  `);

  // count() comes back as bigint, which postgres.js hands over as a string.
  const row = rows[0];
  return {
    queued: Number(row.queued),
    analyzing: Number(row.analyzing),
    retrying: Number(row.retrying),
    failed: Number(row.failed),
  };
}
