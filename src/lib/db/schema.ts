import { desc, sql } from "drizzle-orm";
import {
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
    // When the prose was written, which is not updated_at — correlation touches
    // that too. The gap between this and last_event_at is how "prose is stale
    // relative to evidence" becomes visible.
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
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
