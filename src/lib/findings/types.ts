import { z } from "zod";
import { priorityDriverSchema } from "../correlation/drivers";
import { PRIORITY_LEVELS } from "../correlation/priority";

/**
 * The shapes the dashboard reads, defined once as schemas.
 *
 * These were hand-written TypeScript types until the SSE payload was found to
 * be a `JSON.parse(...) as BoardMessage` — an assertion, not a check. Every
 * other boundary in this system is validated (HTTP in, LLM out, env at
 * startup); HTTP *into the client* was the one that escaped the rule, and it
 * escaped it silently: the compiler is satisfied by the cast, so a payload
 * missing a field type-checks perfectly and fails at render time.
 *
 * So the schema is the definition and the type is derived from it with
 * `z.infer`. One source, the way `events/` and `llm/` already work — a type and
 * a validator maintained separately drift, and the drift is invisible until it
 * reaches a browser.
 *
 * Two conventions worth stating, because both are load-bearing:
 *
 *   - **`.nullable()`, not `.optional()`.** A nullable field must be *present*
 *     and may be null. Absence is an error. That is the entire point: the bug
 *     that prompted this was a missing key reaching `usage === null`, and
 *     `undefined !== null` made every such guard a lie. Nothing here is
 *     optional; the server sends every field or the payload is wrong.
 *   - **Unknown keys are stripped, not rejected.** Zod's default. A newer
 *     server that adds a field must not break an older tab, while a server that
 *     drops one must be caught. The asymmetry is deliberate.
 *
 * Ids and timestamps are `z.string()` rather than `z.uuid()` / `z.iso.datetime()`.
 * The job here is shape and presence, not format: a rejected board freezes the
 * dashboard at its last good state, which is far too heavy a penalty for an id
 * that fails a format check but renders perfectly well.
 */

export const FINDING_STATUSES = ["accepted", "processing", "ready", "failed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

// Every timestamp crossing into the UI is an ISO string, not a Date. These
// objects travel two boundaries that both require plain JSON — Server Component
// to Client Component props, and the SSE payload — and a Date survives neither
// intact. Formatting happens at the leaf that renders it.
export const retryStateSchema = z.object({
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  nextAttemptAt: z.string(),
});

export type RetryState = z.infer<typeof retryStateSchema>;

export const llmUsageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  // Integer micro-dollars (1e-6 USD). Null when the model that ran has no
  // published rate in llm/pricing.ts — tokens are still known, the price is
  // not, and the UI says so rather than showing a confident $0.00.
  costMicrosUsd: z.number().int().nullable(),
});

export type LlmUsage = z.infer<typeof llmUsageSchema>;

// What the collapsed card needs, and nothing more. Notably absent: `summary`.
// The prose lives in the detail panel, which is the structural version of "the
// model supports the deterministic facts rather than leading them" — it doesn't
// depend on type sizes holding a line.
export const findingCardSchema = z.object({
  id: z.string(),
  restaurantId: z.string(),
  orderId: z.string().nullable(),
  version: z.number().int(),
  status: z.enum(FINDING_STATUSES),
  priority: z.enum(PRIORITY_LEVELS).nullable(),
  drivers: z.array(priorityDriverSchema),
  issue: z.string().nullable(),
  // Whether prose exists, without carrying it. `status = 'failed'` does not
  // imply the summary is null — markFindingFailedForEvent updates
  // unconditionally, so a finding that was 'ready' and later absorbed an event
  // whose job dead-lettered keeps prose describing the smaller evidence set.
  // The card needs to tell those two failures apart.
  hasSummary: z.boolean(),
  summarySource: z.enum(["llm", "fallback"]).nullable(),
  // What the model has spent on this finding, summed across every enrichment.
  // Null when no model ever ran for it — which is what lets the card show the
  // model marker only where a model was genuinely involved, rather than
  // inferring it from a zero.
  llmUsage: llmUsageSchema.nullable(),
  extractedTags: z.array(z.string()),
  eventCount: z.number().int(),
  firstEventAt: z.string(),
  lastEventAt: z.string(),
  enrichedAt: z.string().nullable(),
  // The version the prose describes. Compared against `version` to tell whether
  // the summary has fallen behind the evidence — see cardState.ts for why this
  // is a version comparison and not a timestamp one.
  enrichedVersion: z.number().int().nullable(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  // Operator-owned, unlike closedAt. `resolvedAt` is what the board partitions
  // on — closedAt must never be used for that (docs/decisions.md): a finding
  // whose window merely lapsed is history an operator should still see, while a
  // resolved one is finished work.
  //
  // It is also the field with the worst failure mode on this card, and the one
  // that settled the argument for validating here. The partition is
  // `resolvedAt === null`; an absent key is `undefined`, which is not null, so
  // a finding would silently move out of the working list and into Resolved.
  // No error, no crash — just a live critical finding an operator never sees.
  reviewedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  // The soonest-retrying job among this finding's evidence, if any.
  retry: retryStateSchema.nullable(),
});

export type FindingCard = z.infer<typeof findingCardSchema>;

export const operatorActionRecordSchema = z.object({
  id: z.string(),
  actionType: z.string(),
  note: z.string().nullable(),
  actor: z.string(),
  createdAt: z.string(),
  // The finding version the operator was looking at. Read off the stored
  // context so the history can say which summary a thumbs-down was about.
  version: z.number().int().nullable(),
});

export type OperatorActionRecord = z.infer<typeof operatorActionRecordSchema>;

export const evidenceItemSchema = z.object({
  id: z.string(),
  // The opaque label this event was given when evidence was handed to the
  // model. Positional and stable for a given evidence set, and shown here so an
  // operator can line a citation up against the row it points at.
  label: z.string(),
  clientEventId: z.string(),
  eventType: z.string(),
  issueClass: z.string(),
  occurredAt: z.string(),
  receivedAt: z.string(),
  delayMinutes: z.number().nullable(),
  rating: z.number().nullable(),
  refundAmountCents: z.number().int().nullable(),
  customerText: z.string().nullable(),
  cited: z.boolean(),
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const recommendedActionSchema = z.object({
  type: z.string(),
  rationale: z.string(),
});

export type RecommendedAction = z.infer<typeof recommendedActionSchema>;

export const findingDetailSchema = findingCardSchema.extend({
  summary: z.string().nullable(),
  recommendedActions: z.array(recommendedActionSchema),
  llmModel: z.string().nullable(),
  // null when no citation data exists — the fallback writer deliberately writes
  // no citations rather than citing everything.
  citedEventIds: z.array(z.string()).nullable(),
  evidence: z.array(evidenceItemSchema),
  // Newest first. Shown in the panel so persistence is visible rather than
  // implied — without it there is no way to see that anything was written.
  actions: z.array(operatorActionRecordSchema),
});

export type FindingDetail = z.infer<typeof findingDetailSchema>;

// Job-level health, for work that has no finding to attach a badge to yet.
export const queueCountsSchema = z.object({
  queued: z.number().int(),
  analyzing: z.number().int(),
  retrying: z.number().int(),
  failed: z.number().int(),
});

export type QueueCounts = z.infer<typeof queueCountsSchema>;

/**
 * One SSE message: a complete, ordered board plus the ids that changed.
 *
 * Defined here rather than in `realtime/broadcaster.ts`, where it used to live,
 * because the client needs the schema as a *value* and importing it from the
 * broadcaster would pull the database client into the browser bundle. The
 * broadcaster imports the type back from here.
 */
export const boardMessageSchema = z.object({
  type: z.literal("board"),
  findings: z.array(findingCardSchema),
  queue: queueCountsSchema,
  changed: z.array(z.string()),
});

export type BoardMessage = z.infer<typeof boardMessageSchema>;

// The two pieces of board state the stream replaces together. Kept as one
// object so a rejected payload can be dropped by returning the same reference —
// see findings/boardPayload.ts.
export type Board = {
  findings: FindingCard[];
  queue: QueueCounts;
};
