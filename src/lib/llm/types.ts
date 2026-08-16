import type { Priority, PriorityDriver } from "../correlation/priority";
import type { ExtractedTag, RecommendedActionType } from "./schema";

// One evidence row as the model sees it. `label` is the only identifier that
// crosses the prompt boundary — event UUIDs never do, so a fabricated citation
// can't accidentally name a real row.
export type LabeledEvidence = {
  label: string;
  eventId: string;
  eventType: string;
  issueClass: string;
  occurredAt: Date;
  delayMinutes: number | null;
  rating: number | null;
  refundAmountCents: number | null;
  // Customer-authored free text. Untrusted: fenced as data in the prompt, never
  // concatenated into instructions.
  customerText: string | null;
};

export type EnrichmentInput = {
  findingId: string;
  priority: Priority | null;
  // Why that priority, decided by code. Handed to the model as a given so the
  // summary narrates a fact instead of inventing a rationale.
  drivers: PriorityDriver[];
  eventCount: number;
  firstEventAt: Date;
  lastEventAt: Date;
  evidence: LabeledEvidence[];
};

export type RecommendedAction = {
  type: RecommendedActionType;
  rationale: string;
};

// What one enrichment consumed, already priced. Null on any writer that spends
// nothing (the fallback) or that reports no usage at all — distinct from zeros,
// which would claim a model ran and cost nothing.
export type EnrichmentUsage = {
  // Every billed input token, cache reads and writes folded in. One number
  // because "how many tokens did this cost me" is the operator's question; the
  // breakdown only matters to the pricing rules, which have already run.
  inputTokens: number;
  outputTokens: number;
  // Integer micro-dollars (1e-6 USD), or null for a model with no known rate.
  costMicrosUsd: number | null;
};

export type Enrichment = {
  issue: string;
  summary: string;
  actions: RecommendedAction[];
  tags: ExtractedTag[];
  // Real event ids, mapped in code from validated labels. Null when the writer
  // produces no citations at all (the fallback) — distinct from an empty array,
  // which would mean "cited nothing despite being able to".
  citedEventIds: string[] | null;
  source: "llm" | "fallback";
  model: string | null;
  usage: EnrichmentUsage | null;
};

export type EnrichmentProvider = {
  readonly name: string;
  enrich(input: EnrichmentInput): Promise<Enrichment>;
};
