import type { PriorityDriver } from "../correlation/priority";
import type { Priority } from "../correlation/priority";

export const FINDING_STATUSES = ["accepted", "processing", "ready", "failed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

// Every timestamp crossing into the UI is an ISO string, not a Date. These
// objects travel two boundaries that both require plain JSON — Server Component
// to Client Component props, and the SSE payload — and a Date survives neither
// intact. Formatting happens at the leaf that renders it.
export type RetryState = {
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
};

// What the collapsed card needs, and nothing more. Notably absent: `summary`.
// The prose lives in the detail panel, which is the structural version of "the
// model supports the deterministic facts rather than leading them" — it doesn't
// depend on type sizes holding a line.
export type FindingCard = {
  id: string;
  restaurantId: string;
  orderId: string | null;
  version: number;
  status: FindingStatus;
  priority: Priority | null;
  drivers: PriorityDriver[];
  issue: string | null;
  // Whether prose exists, without carrying it. `status = 'failed'` does not
  // imply the summary is null — markFindingFailedForEvent updates
  // unconditionally, so a finding that was 'ready' and later absorbed an event
  // whose job dead-lettered keeps prose describing the smaller evidence set.
  // The card needs to tell those two failures apart.
  hasSummary: boolean;
  summarySource: "llm" | "fallback" | null;
  extractedTags: string[];
  eventCount: number;
  firstEventAt: string;
  lastEventAt: string;
  enrichedAt: string | null;
  // The version the prose describes. Compared against `version` to tell whether
  // the summary has fallen behind the evidence — see cardState.ts for why this
  // is a version comparison and not a timestamp one.
  enrichedVersion: number | null;
  updatedAt: string;
  closedAt: string | null;
  // Operator-owned, unlike closedAt. `resolvedAt` is what the board partitions
  // on — closedAt must never be used for that (docs/decisions.md): a finding
  // whose window merely lapsed is history an operator should still see, while a
  // resolved one is finished work.
  reviewedAt: string | null;
  resolvedAt: string | null;
  // The soonest-retrying job among this finding's evidence, if any.
  retry: RetryState | null;
};

export type OperatorActionRecord = {
  id: string;
  actionType: string;
  note: string | null;
  actor: string;
  createdAt: string;
  // The finding version the operator was looking at. Read off the stored
  // context so the history can say which summary a thumbs-down was about.
  version: number | null;
};

export type EvidenceItem = {
  id: string;
  // The opaque label this event was given when evidence was handed to the
  // model. Positional and stable for a given evidence set, and shown here so an
  // operator can line a citation up against the row it points at.
  label: string;
  clientEventId: string;
  eventType: string;
  issueClass: string;
  occurredAt: string;
  receivedAt: string;
  delayMinutes: number | null;
  rating: number | null;
  refundAmountCents: number | null;
  customerText: string | null;
  cited: boolean;
};

export type RecommendedAction = {
  type: string;
  rationale: string;
};

export type FindingDetail = FindingCard & {
  summary: string | null;
  recommendedActions: RecommendedAction[];
  llmModel: string | null;
  // null when no citation data exists — the fallback writer deliberately writes
  // no citations rather than citing everything.
  citedEventIds: string[] | null;
  evidence: EvidenceItem[];
  // Newest first. Shown in the panel so persistence is visible rather than
  // implied — without it there is no way to see that anything was written.
  actions: OperatorActionRecord[];
};

// Job-level health, for work that has no finding to attach a badge to yet.
export type QueueCounts = {
  queued: number;
  analyzing: number;
  retrying: number;
  failed: number;
};
