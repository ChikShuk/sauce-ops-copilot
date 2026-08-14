# Design Decisions

## 2026-08-13 — Postgres as queue instead of Redis
**Context:** Need a queue for async event processing. The brief warns against adding Redis just to satisfy the assignment.
**Decision:** Postgres with `SELECT ... FOR UPDATE SKIP LOCKED` for job claiming, plus a transactional outbox table.
**Alternatives:** Redis + BullMQ (extra service, and permanent state would risk living outside the durable store); SQS (not runnable offline in Docker).
**Consequence:** One fewer container, outbox and jobs share transactions with business data. Ceiling is lower than a real broker — fine at this scale, noted in the README as a production change.

## 2026-08-14 — Merge outbox and jobs into a single event_jobs table

**Context:** The prior entry above specified a transactional outbox plus a relay into a separate jobs table. Revisiting during slice 1 schema design: the outbox pattern exists to bridge a database and a *separate* broker, where the write and the publish can't share a transaction. Here the queue is Postgres itself.
**Decision:** One table, `event_jobs` (`status`, `attempts`, `next_attempt_at`, `claimed_at`), written in the same statement as the event insert via a CTE. The worker claims from it directly with `SELECT ... FOR UPDATE SKIP LOCKED`. No outbox table, no relay step.
**Alternatives:** The original outbox+relay design (rejected as a moving part and failure mode — two tables in the same database, relayed between, adds no guarantee that the single-statement write doesn't already provide).
**Consequence:** "Event saved but crashed before queuing" is impossible by construction, not merely recoverable. If we later move to a real broker, `event_jobs` becomes the outbox and a relay is added at that seam — this entry supersedes, not edits, the entry above, per the "never rewrite history" git rule.

## 2026-08-14 — Rolling 3-hour open-finding window for correlation

**Context:** Needed a correlation key that reproduces the brief's own reference scenario: three events (`delivery_delay`, `complaint`, `negative_review`) at 17:55, 18:12, and 20:10 on one restaurant, all evidence of *one* finding. A static key — order-based, or `restaurant+issue_class+fixed_bucket` — splits this: `issue_class` in the key splits it by type into three findings, and any bucket boundary shorter than a day can fall between the first and last event (~2h15m apart).
**Decision:** No stored correlation key. A finding is "open" while evidence keeps arriving for a restaurant within a rolling window of the last event: look up the open finding for the restaurant; if `last_event_at >= occurred_at - 3h`, attach and extend; otherwise close the stale one and create a new finding, in the same transaction. `issue_class` stays on `events` only, read by priority rules, never by correlation.
**Alternatives:** `order_id`-based key (rejected — splits a mixed-order incident into per-order cards, doesn't scale as a dashboard); `restaurant+issue_class+fixed_bucket` key (rejected — fails the reference scenario on both axes, as above).
**Consequence:** Reproduces the brief's reference output correctly, and needs no bucket boundary tuning. Cost: two unrelated problems at the same restaurant within 3h of each other merge into one finding — documented in the README's "Known limitations" (human-owned section). The window length (3h) is a fixed constant, not tuned per restaurant volume.

## 2026-08-14 — closed_at as a correlation-owned lifecycle marker, separate from resolved_at

**Context:** The rolling-window model (above) needs an "open" marker to know which finding to match new evidence against, and to enforce at most one open finding per restaurant. The obvious candidate, `resolved_at IS NULL`, is operator-driven — a finding a window has lapsed on, but that no operator has touched, would still read as open.
**Decision:** Separate `closed_at` (correlation-owned, set when the window lapses and no operator has acted) from `resolved_at` (operator-owned, set by a `mark_resolved` action). Resolving a finding also sets `closed_at`. Partial unique index: `UNIQUE (restaurant_id) WHERE closed_at IS NULL`.
**Alternatives:** Using `resolved_at IS NULL` as the sole open marker (rejected — a window-lapsed, operator-untouched finding would permanently block new findings for that restaurant, since the unique index would never free up).
**Consequence:** Correlation self-heals without depending on operator behavior — the next event for a restaurant closes the stale finding and opens a new one automatically. One extra nullable timestamp column and one extra thing to explain in the architecture doc.

## 2026-08-14 — Tenant-scoped event idempotency key

**Context:** `events.event_id` is client/simulator-supplied, not server-generated. A single global unique constraint on `event_id` would let one restaurant's event IDs collide with another's.
**Decision:** `UNIQUE (restaurant_id, event_id)`, not a global unique on `event_id` alone.
**Alternatives:** Global `UNIQUE(event_id)` (rejected — real multi-tenancy bug, cheap to get right now, expensive to migrate later once IDs actually collide).
**Consequence:** Ingestion dedup check is `ON CONFLICT (restaurant_id, event_id) DO NOTHING`, one more column in the conflict target — no real cost.

## 2026-08-14 — UUID primary keys throughout, including event_jobs

**Context:** Earlier in slice-1 planning, a mixed strategy was approved: UUIDs for business entities, `BIGINT IDENTITY` for the outbox/jobs tables, since claim-ordering needs a cheap monotonic key. The subsequent merge of outbox+jobs into a single 1:1 `event_jobs` table (see above) removed the only table that needed that ordering — `event_jobs` now reuses `events.id` directly, and the claim query is served by a partial index on `next_attempt_at` instead of PK order.
**Decision:** UUID (`gen_random_uuid()`, native to Postgres 16, no extension) on every table, no surrogate `BIGINT IDENTITY` columns anywhere.
**Alternatives:** Keeping the originally-approved mixed strategy despite no table needing it anymore (rejected as needless inconsistency, once the constraint that motivated it was gone).
**Consequence:** Flagged explicitly as a deviation from the earlier-approved call, per review — this entry exists specifically to make that deviation visible rather than silently folding it into a routine schema decision.

## 2026-08-14 — updated_at maintained by a database trigger, not ORM convention

**Context:** `event_jobs.updated_at` and `findings.updated_at` need to reflect the true last-write time. Several of this schema's hot paths are raw SQL, not ORM writes: the racing `INSERT` and evidence-attach `UPDATE` on `findings`, and the `event_jobs` claim `UPDATE`. Drizzle's `$onUpdate()` only fires for writes made through the ORM.
**Decision:** A `set_updated_at()` trigger function with a `BEFORE UPDATE` trigger on both tables, added via a hand-written custom migration (`drizzle-kit generate --custom`) since triggers aren't expressible in Drizzle's declarative schema. `$onUpdate()` is kept too, as a no-cost belt-and-suspenders for ORM-path writes.
**Alternatives:** Relying on `$onUpdate()` alone (rejected — silently wrong for every raw-SQL write, and `findings.updated_at` is user-visible on the dashboard, so staleness there is a real bug, not a hygiene nit).
**Consequence:** One trigger function, two triggers, one extra migration file. Verified directly: a raw `UPDATE ... SET version = version + 1` on `findings` (bypassing Drizzle entirely) moved `updated_at`, confirming the trigger — not the ORM — is what's actually enforcing this.

## 2026-08-14 — postgres.js over node-postgres (pg) as the Postgres driver

**Context:** Needed a driver to pair with `drizzle-orm`.
**Decision:** `postgres` (postgres.js).
**Alternatives:** `pg` (node-postgres) — more battle-tested, but callback-oriented API; postgres.js is promise-native and its `sql.begin(async sql => {...})` is a clean fit for this project's transactional writes, and it's the more common pairing with `drizzle-orm/postgres-js` in current docs/examples.
**Consequence:** Slightly less mainstream than `pg`, but no functional gap for this project's needs.

## 2026-08-14 — Committed migrations via drizzle-kit generate, not push

**Context:** Needed a way to apply the schema to Postgres, locally and eventually via Docker Compose.
**Decision:** `drizzle-kit generate` producing SQL files committed to `src/lib/db/migrations/`, applied via a small owned script (`src/lib/db/migrate.ts`, using `drizzle-orm/postgres-js/migrator`) run through `tsx`. No `db:push` script.
**Alternatives:** `drizzle-kit push` (rejected — mutates the DB schema directly with no committed history; fine for disposable prototyping, but this project is reviewed by senior engineers and graded partly on correctness under failure, where an auditable migration history matters).
**Consequence:** One extra step (generate, then migrate) versus push's single command. Buys reproducibility and a reviewable diff of every schema change.

## 2026-08-14 — DLQ reserved for unexpected errors; LLM outages are never a job failure

**Context:** `event_jobs.status` includes `dead_letter`. Needed to decide what actually routes a job there, given invariant 1: an LLM failure must still leave the finding created, correlated, prioritized, and evidenced — only the prose degrades.
**Decision:** `dead_letter` is reserved for unexpected job-handler errors (bad data, bugs, constraint violations). An LLM provider timeout or outage is caught inline, the job writes the deterministic fallback summary, and the job still succeeds. Consequently `findings.status = 'failed'` can only originate from a DLQ'd job — never from "the model was unavailable."
**Alternatives:** Treating LLM failure as a retryable/DLQ-able job error (rejected — directly contradicts invariant 1's "LLM enriches a finding that already exists, never on the critical path").
**Consequence:** Slice 5's LLM integration must implement the fallback path as the failure handler, not rely on the job retry/DLQ machinery to paper over provider outages.

## 2026-08-14 — zod and a test runner deferred past slice 1

**Context:** Slice 1 is schema and migrations only — no HTTP boundary, no correlation logic yet to unit test.
**Decision:** Neither `zod` nor a test runner (Vitest) is installed this slice.
**Alternatives:** Installing both now "to be ready" (rejected — nothing in this slice validates a runtime boundary or has logic worth unit testing yet; per the coding conventions, no premature abstraction/tooling).
**Consequence:** `zod` lands in slice 2 (ingestion validation), a test runner in slice 4 (correlation, "unit tested") / slice 9 (failure tests).