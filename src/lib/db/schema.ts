import { desc, sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Immutable, append-only evidence. Never updated after insert.
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Client/simulator-supplied idempotency key. Scoped to restaurant, not
    // globally unique, so one tenant's IDs can't collide with another's.
    eventId: text("event_id").notNull(),
    restaurantId: text("restaurant_id").notNull(),
    orderId: text("order_id"),
    eventType: text("event_type").notNull(),
    // Root-cause taxonomy, deliberately independent of event_type (see
    // deriveIssueClass.ts) — deterministic only, never set from
    // LLM-extracted free text. Priority/severity rules (slice 4) read it;
    // correlation does not (findings have no issue_class column).
    issueClass: text("issue_class").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Event-type-specific fields. Customer free text (complaint_text,
    // review_text) lives here as inert data — prompt-fencing is a slice-5
    // concern, not a schema one.
    payload: jsonb("payload").notNull(),
    source: text("source").notNull().default("simulator"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("events_restaurant_id_event_id_key").on(
      table.restaurantId,
      table.eventId,
    ),
    index("events_order_id_idx")
      .on(table.orderId)
      .where(sql`${table.orderId} is not null`),
    index("events_restaurant_issue_class_occurred_at_idx").on(
      table.restaurantId,
      table.issueClass,
      table.occurredAt,
    ),
    check(
      "events_event_type_check",
      sql`${table.eventType} in ('delivery_delay', 'complaint', 'refund', 'negative_review')`,
    ),
    // A root-cause taxonomy independent of event_type, not a copy of it —
    // e.g. a refund caused by a late delivery classes as 'delivery_delay',
    // not 'refund'. See src/lib/events/deriveIssueClass.ts.
    check(
      "events_issue_class_check",
      sql`${table.issueClass} in ('delivery_delay', 'complaint', 'refund', 'negative_review', 'missing_items', 'wrong_order')`,
    ),
  ],
);

// Merged outbox + queue (CLAUDE.md invariant 3). One row per event, written
// in the same statement as the event insert — no separate outbox, no relay.
export const eventJobs = pgTable(
  "event_jobs",
  {
    // Shares the event's own id rather than a surrogate key: event_jobs is
    // strictly 1:1 with events, so this enforces that by construction.
    eventId: uuid("event_id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    // 'pending' = never attempted; 'failed' = errored, waiting for
    // next_attempt_at. Both are claim-eligible on the same terms — keeping
    // them distinct is what lets the DB tell "never tried" from "tried and
    // will retry". See src/lib/queue/claimJob.ts.
    status: text("status").notNull().default("pending"),
    // Incremented at claim time, not just on failure, so a worker that
    // claims and then hard-crashes still eventually exhausts retries.
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    // Fencing token, regenerated on every claim. A worker replays the token
    // it was handed when writing its disposition, so a worker whose job was
    // stale-reclaimed while it was still running updates zero rows instead
    // of clobbering the new claim. Deliberately not claimed_at: that round
    // trips through a JS Date, which truncates Postgres's microseconds and
    // makes the equality check silently never match.
    claimToken: uuid("claim_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The claim query's time-gated branch: both statuses are eligible on
    // identical terms, so one index covers both.
    index("event_jobs_next_attempt_at_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} in ('pending', 'failed')`),
    // The claim query's stale-reclaim branch — a different column and
    // predicate, so it earns its own partial index rather than being folded
    // into the one above. Two partial indexes let Postgres BitmapOr across
    // them instead of falling back to a seq scan as finished jobs pile up.
    index("event_jobs_processing_claimed_at_idx")
      .on(table.claimedAt)
      .where(sql`${table.status} = 'processing'`),
    check(
      "event_jobs_status_check",
      sql`${table.status} in ('pending', 'processing', 'succeeded', 'failed', 'dead_letter')`,
    ),
  ],
);

// Runtime demo overrides, not business data. One row per setting, read at the
// point of use rather than at startup — which is the entire reason it exists:
// the worker is a separate process, so a value it reads once at boot cannot be
// changed from a browser without a restart.
//
// Generic key/value on purpose. A column per setting would mean a migration per
// demo affordance, and nothing here outlives the demo.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Living, mutable, versioned entities. Correlation has no static key — a
// finding is "open" while evidence keeps arriving for a restaurant within a
// rolling window of the last event (see docs/decisions.md). issue_class is
// deliberately NOT a column here: a finding can span multiple issue classes.
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: text("restaurant_id").notNull(),
    // Informational/display only — populated when any attached evidence
    // carries one. Never part of how a finding is matched.
    orderId: text("order_id"),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("accepted"),
    priority: text("priority"),
    // Which severity signals fired and why, as returned by scorePriority().
    // Correlation-owned and written in the same UPDATE as `priority`, so the
    // two can never disagree.
    //
    // Persisted because until slice 6 the system's own severity reasoning was
    // visible only to the language model — it went into the prompt and was
    // then discarded. The operator could see *that* a finding was critical but
    // never *why*, which puts the least trustworthy element (the prose) in
    // charge of explaining the most trustworthy one (the threshold rules).
    priorityDrivers: jsonb("priority_drivers"),
    // Short LLM-generated title, same lifecycle as summary: nullable until
    // first enrichment, degrades to a fallback title on LLM failure.
    issue: text("issue"),
    summary: text("summary"),
    recommendedActions: jsonb("recommended_actions"),
    summarySource: text("summary_source"),
    // LLM-derived structured labels (e.g. ["missing_items"]). Display
    // metadata only — never read by correlation or priority code.
    extractedTags: jsonb("extracted_tags"),
    // Which evidence the narrative actually rests on, as real event ids. The
    // model never sees or emits a UUID: it cites opaque labels (E1..En) which
    // are validated against the set we issued and mapped back here in code, so
    // a hallucinated citation is detectably invalid rather than plausibly real.
    //
    // NULL on fallback rows — deliberately not "all of them", which would give
    // this column two meanings and make a degraded finding light up every event
    // as cited. NULL reads as "no citation data"; summary_source carries the
    // llm-vs-fallback distinction on its own.
    citedEventIds: jsonb("cited_event_ids"),
    // Which model wrote this prose. Needed to interpret a bad summary, and to
    // tell pre- from post-model-change rows apart. NULL on fallback rows.
    llmModel: text("llm_model"),
    // What the model has cost this finding, summed over every enrichment it has
    // had — a finding is enriched once per version, and all of them were spent
    // on this one row.
    //
    // NULL, not 0, on a finding no model ever touched. The three columns move
    // together and are written only by enrichFinding; nothing reads them except
    // display. Cost is stored rather than derived from the token counts at
    // render time because it is an accounting fact about a call that already
    // happened, and must not restate itself when Anthropic changes a price —
    // see llm/pricing.ts.
    llmInputTokens: integer("llm_input_tokens"),
    llmOutputTokens: integer("llm_output_tokens"),
    // Integer micro-dollars (1e-6 USD). bigint because cents are too coarse for
    // a sub-cent call and a float would drift the moment anything sums them.
    // NULL also covers "model ran, but we hold no rate for it".
    llmCostMicrosUsd: bigint("llm_cost_micros_usd", { mode: "number" }),
    // When the prose was written, which is not updated_at — correlation touches
    // that too. Display only.
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    // Which version of the evidence set the prose describes, copied from the
    // version enrichment fenced its write on.
    //
    // This, not enriched_at, is how "the prose is behind the evidence" is
    // detected: `enriched_version < version`. Comparing enriched_at against
    // last_event_at would mix two different clocks — enriched_at is wall time,
    // last_event_at is the business time an event occurred, which for a
    // backfill is days in the past — so that comparison is false in normal
    // operation and true for reasons that have nothing to do with staleness.
    enrichedVersion: integer("enriched_version"),
    eventCount: integer("event_count").notNull().default(0),
    firstEventAt: timestamp("first_event_at", { withTimezone: true }).notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    // Lifecycle marker, correlation-owned: set when the rolling window
    // lapses with no new evidence. Deliberately separate from resolved_at
    // (operator-owned) so an operator-untouched finding still self-closes
    // instead of blocking new findings for that restaurant indefinitely.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("findings_status_idx").on(table.status),
    index("findings_priority_idx").on(table.priority),
    index("findings_last_event_at_idx").on(desc(table.lastEventAt)),
    // At most one open finding per restaurant. Also serves as the
    // open-finding lookup index for correlation matching.
    uniqueIndex("findings_restaurant_id_open_key")
      .on(table.restaurantId)
      .where(sql`${table.closedAt} is null`),
    check(
      "findings_status_check",
      sql`${table.status} in ('accepted', 'processing', 'ready', 'failed')`,
    ),
    check(
      "findings_priority_check",
      sql`${table.priority} is null or ${table.priority} in ('low', 'medium', 'high', 'critical')`,
    ),
    check(
      "findings_summary_source_check",
      sql`${table.summarySource} is null or ${table.summarySource} in ('llm', 'fallback')`,
    ),
  ],
);

// Join table — evidence assembly. Evidence is assembled from this table,
// never from model output.
export const findingEvents = pgTable(
  "finding_events",
  {
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    attachedAt: timestamp("attached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.findingId, table.eventId] }),
    // One event evidences at most one finding.
    uniqueIndex("finding_events_event_id_key").on(table.eventId),
  ],
);

// Append-only audit log of persisted operator actions.
export const operatorActions = pgTable(
  "operator_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    note: text("note"),
    actor: text("actor").notNull().default("operator"),
    // What the operator was looking at when they acted.
    //
    // Prose is COPIED here, evidence is REFERENCED by id — and that asymmetry is
    // the whole point of the column. A finding's `summary` is overwritten by the
    // next enrichment, so feedback storing only finding_id points at prose that
    // no longer exists: the judgement survives and the thing judged is gone.
    // `events` rows never change, so their ids are enough to rehydrate the
    // model's exact input.
    //
    // ⚠ That second half is a convention, not a constraint. Nothing in the
    // database prevents `UPDATE events`, and today nothing does it — the table
    // is written once by enqueueEvent and read forever after. If a mutation path
    // is ever added, every thumbs_down snapshot taken before it silently starts
    // rehydrating to different input than the operator judged, which makes the
    // eval set quietly wrong rather than loudly broken. Copy the payload in here
    // instead, or don't add the mutation.
    //
    // Always carries version/priority/status; thumbs_down additionally carries
    // the full artifact under judgement. See src/lib/actions/recordAction.ts.
    context: jsonb("context"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("operator_actions_finding_id_idx").on(table.findingId),
    check(
      "operator_actions_action_type_check",
      sql`${table.actionType} in ('mark_reviewed', 'mark_resolved', 'thumbs_down', 'thumbs_up')`,
    ),
  ],
);

// The second queue: "rewrite this finding's prose", requested from the UI.
//
// A separate table rather than another event_jobs row, and the deciding reason
// is semantic rather than structural. A dead-lettered event job marks its
// finding failed — its evidence never made it into prose. A dead-lettered
// re-enrichment must NOT: the prose already on the finding is still valid, and
// the rewrite was an operator's optional request. Sharing the table would force
// a branch exactly where runJob is currently unconditional.
//
// Structurally it also could not share: event_jobs.event_id is the primary key
// precisely to enforce 1:1 with events (see above), so a second job per event is
// impossible without discarding that guarantee.
//
// Every other column mirrors event_jobs deliberately — same status vocabulary,
// same claim-token fencing, same backoff schedule — so the two queues read the
// same way even though they are drained by separate statements.
export const enrichmentJobs = pgTable(
  "enrichment_jobs",
  {
    // A surrogate key, unlike event_jobs: a finding can legitimately be
    // re-enriched many times over its life, so there is no 1:1 to enforce.
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    // The version at the moment the operator asked, kept for the log line only.
    // The worker re-reads the finding's current version when it claims the job,
    // so the rewrite always describes the evidence that exists then.
    requestedVersion: integer("requested_version").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    claimToken: uuid("claim_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // At most one outstanding rewrite per finding — same partial-unique-index
    // shape as findings_restaurant_id_open_key. A double click is then a no-op
    // enforced by the database rather than by the button being disabled.
    uniqueIndex("enrichment_jobs_finding_id_open_key")
      .on(table.findingId)
      .where(sql`${table.status} in ('pending', 'processing', 'failed')`),
    index("enrichment_jobs_next_attempt_at_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} in ('pending', 'failed')`),
    index("enrichment_jobs_processing_claimed_at_idx")
      .on(table.claimedAt)
      .where(sql`${table.status} = 'processing'`),
    check(
      "enrichment_jobs_status_check",
      sql`${table.status} in ('pending', 'processing', 'succeeded', 'failed', 'dead_letter')`,
    ),
  ],
);
