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

## 2026-08-14 — Ingestion route path: restaurant_id from the URL, not the body

**Context:** The brief specifies `POST /restaurants/{restaurantId}/events`. `restaurant_id` could be accepted in the request body too, requiring either a mismatch check against the path or trusting one over the other silently.
**Decision:** `restaurant_id` comes only from the route path (`src/app/api/restaurants/[restaurantId]/events/route.ts`), dropped from the request body schema entirely.
**Alternatives:** Accepting `restaurant_id` in both places and 400ing on mismatch (rejected — one source of truth is simpler than a validation rule guarding against a state that dropping the field makes impossible).
**Consequence:** No mismatch state to test or explain. `normalizeEvent`/`enqueueEvent` take `restaurantId` as an explicit parameter rather than reading it off the parsed body.

## 2026-08-14 — issue_class is a genuine root-cause taxonomy, not a copy of event_type

**Context:** The first draft of the ingestion design derived `issue_class` from `event_type` with no transformation for 3 of 4 event types (`delivery_delay`, `refund`, `negative_review` all defaulted straight through), and no CHECK constraint — flagged mid-review as two columns holding identical strings, which any reviewer would notice.
**Decision:** `issue_class` gets its own CHECK constraint (`IN ('delivery_delay', 'complaint', 'refund', 'negative_review', 'missing_items', 'wrong_order')`) and a derivation rule that genuinely differs from `event_type`: `complaint.category` and `refund.reason` (a shared `IssueCategory` enum: `missing_items` | `wrong_order` | `late_delivery` | `other`) override the default when present and not `'other'`. Concretely: **a refund with `reason: 'late_delivery'` gets `issue_class = 'delivery_delay'`, not `'refund'`** — verified against a real request, `SELECT`ed back from the DB. `negative_review` stays a deliberate pass-through (no structured root-cause field in this slice's minimal payload) rather than an oversight.
**Alternatives:** Keeping it a documented pass-through/extension point with no CHECK constraint (rejected — slice 4's recurrence-based priority rules are more useful counting by root cause than by event mechanism: a restaurant with 2 late deliveries and 1 refund-for-lateness is 3 lateness incidents, not 2-and-1 unrelated ones).
**Consequence:** `deriveIssueClass.ts` branches only on `event_type` and the explicit `category`/`reason` field — never on `complaint_text`/`review_text`/`rating`. Worth recording verbatim, as the clearest statement of this boundary so far, for reuse in the architecture doc: **the invariant-1 boundary is about what kind of input drives `issue_class`, not just whether an LLM is involved** — a "helpful" keyword classifier on free text would still violate it even without touching `src/lib/llm/`. A comment stating this lives directly in `deriveIssueClass.ts`, not only here.

## 2026-08-14 — Duplicate response returns the existing row's id; no-write lookup via UNION ALL, not DO UPDATE

**Context:** Invariant 4 requires the UI to visibly show a duplicate was recognized. A bare `duplicate: true` boolean doesn't let the UI link to what it's a duplicate *of* — the more useful answer is "this event already exists, here's what it's attached to," and slice 6 needs an id to link either way. The first attempt to get the existing row's `id` on a conflict used the standard Postgres upsert-discrimination trick, `ON CONFLICT ... DO UPDATE SET restaurant_id = events.restaurant_id RETURNING id, (xmax = 0) AS inserted` — caught in review before implementation: this still writes a new row version on every duplicate (bumps `xmax`, takes a row lock, creates a dead tuple), which breaks `events`' documented immutability. The actual failure test here is "submit the same event five times," which would produce five row versions of a row meant to never be touched again, and concurrent duplicates would serialize on each other's row lock for no reason.
**Decision:** Kept `ON CONFLICT (restaurant_id, event_id) DO NOTHING` (zero writes on conflict, same as slice 1) and added a `UNION ALL` fallback branch in the same statement — a plain, lock-free `SELECT` of the existing row, gated by `NOT EXISTS (SELECT 1 FROM new_event)` so it only runs on the duplicate path:
```sql
SELECT id, true AS inserted FROM new_event
UNION ALL
SELECT id, false AS inserted FROM events
WHERE restaurant_id = $1 AND event_id = $2 AND NOT EXISTS (SELECT 1 FROM new_event);
```
Response contract: `201` new / `200` duplicate, both bodies now carry `id` — the *existing* row's id on a duplicate. Verified against real requests: resubmitting the same `(restaurantId, event_id)` returns the identical `id` as the original insert, with zero new `events`/`event_jobs` rows created.
**Alternatives:** The `DO UPDATE` self-assignment trick (rejected, as above — correctness bug, not just a stylistic choice); a second round-trip query only on the duplicate path (rejected — the `UNION ALL` gets the same result in one statement, preserving invariant 3's single-statement guarantee).
**Consequence:** `enqueueEvent` always returns `{ id, duplicate }` uniformly. The query is a few lines longer than plain `DO NOTHING`, but the `NOT EXISTS` guard keeps the lookup branch a no-op read on the (overwhelmingly common) non-duplicate path.

## 2026-08-14 — occurred_at bounded to protect the rolling correlation window

**Context:** `occurred_at` drives slice 1's rolling correlation window (`last_event_at >= occurred_at - 3h`). Caught in review: an unvalidated, unbounded `occurred_at` — e.g. a client error placing it a year in the future — would create a `findings` row whose `last_event_at` is also far in the future. That finding's window never lapses, so `closed_at` never gets set, and `UNIQUE(restaurant_id) WHERE closed_at IS NULL` means it silently swallows every subsequent real event at that restaurant into itself, forever.
**Decision:** Reject `occurred_at` more than 5 minutes ahead or more than 7 days behind the server clock, at Zod validation time, with a clear message. Verified against a real request (`occurred_at` one year out → `400`, no row created).
**Alternatives:** No bound (rejected — this is what surfaced the bug above); a much wider or narrower window (5 min / 7 days chosen as generous enough for real clock skew and backfill while still bounding the blast radius of a bad timestamp; not tuned further, since nothing yet depends on the exact figures).
**Consequence:** This is input validation protecting a downstream correctness invariant, not generic hygiene — worth being explicit about in the architecture doc, since the connection (a timestamp bound protects a queue-closing constraint two tables away) isn't obvious from the schema alone.

## 2026-08-14 — Raw sql CTE via db.execute, and .strict() Zod schemas, for the ingestion boundary

**Context:** Needed to decide how the atomic event+job write is expressed in code, and how strict request validation should be.
**Decision:** `enqueueEvent` uses `db.execute(sql\`...\`)` with the raw CTE (the same single canonical statement slice 1 already verified), not query-builder composition — there are two data-modifying CTEs plus a `UNION ALL`, which the query builder can't express as one statement anyway, so there's no abstraction to gain. Every Zod object in `src/lib/events/schema.ts` — the top-level discriminated union members and each payload — uses `.strict()`, so unknown fields 400 instead of silently vanishing.
**Alternatives:** Composing the write via Drizzle's query builder in multiple round trips (rejected — breaks the single-statement atomicity guarantee); non-strict Zod objects (rejected — this is a graded correctness exercise; unknown fields silently dropped is a worse failure mode than a 400 telling the caller their request didn't match).
**Consequence:** `enqueueEvent.ts` reads as one dense SQL statement with a comment block explaining the non-obvious parts (why `DO NOTHING` not `DO UPDATE`, why `.toISOString()` not a bare `Date` — postgres.js's raw parameter binder needs a string at this layer, unlike through the query builder, which knows the column's type). Note the comment block sits *above* the function, not inside the template literal: an earlier revision put it inside, where JS `//` is literal text rather than a comment, which produced invalid SQL and broke every ingestion request until it was caught in slice 3 (fixed in `0f6a921`).

## 2026-08-14 — 'failed' is a resting status distinct from 'pending'

**Context:** `event_jobs.status`'s CHECK constraint enumerates five values, but a failed attempt with retries remaining could just as easily go straight back to `'pending'` with a future `next_attempt_at` — in which case `'failed'` would never be stored and the enum value would be dead weight.
**Decision:** `'pending'` means "never attempted"; `'failed'` means "errored at least once, waiting for `next_attempt_at`". The claim query's time-gated branch is therefore `status IN ('pending', 'failed') AND next_attempt_at <= now()`.
**Alternatives:** Collapsing failed-with-retries-left back into `'pending'` (rejected — it wastes an already-migrated enum value, and leaves the DB unable to distinguish "never tried" from "tried once, about to retry", which is exactly what an ops view wants to see).
**Consequence:** The existing partial index widened from `WHERE status = 'pending'` to `WHERE status IN ('pending', 'failed')` — a direct generalization of the same query, not a new index shape. Both statuses share identical claim semantics, which is the signal this is the right cut.

## 2026-08-14 — Stale-'processing' reclaim, with the timeout derived from the LLM bounds

**Context:** The claim statement commits immediately rather than holding a row lock across the handler call — it has to, since slice 5's LLM call must not pin a DB lock for its duration. That leaves nothing to free a job whose worker claimed it and then hard-crashed: it sits in `'processing'` forever.
**Decision:** Fold a staleness branch into the claim query's eligibility set (`status = 'processing' AND claimed_at < now() - PROCESSING_TIMEOUT_MS`), so the next worker reclaims it. `attempts` increments on every claim including reclaims, so a crash-loop still burns retry budget. `PROCESSING_TIMEOUT_MS` is **derived**, in `src/lib/config.ts`, as `LLM_TIMEOUT_MS * MAX_LLM_ATTEMPTS + PROCESSING_MARGIN_MS` (45s today) from LLM constants stubbed there now and consumed for real in slice 5.
**Alternatives:** A hardcoded timeout with a "revisit when the LLM lands" note in this log (rejected — a note here doesn't survive to slice 5; a derived constant widens automatically when the LLM bounds change, so a legitimately slow call can't be stale-reclaimed and burn a retry it never earned). Holding the row lock for the duration of processing (rejected — pins a DB connection per in-flight job and turns a slow LLM call into database pressure).
**Consequence:** A second partial index (`event_jobs_processing_claimed_at_idx` on `claimed_at WHERE status = 'processing'`) so the OR'd claim query can BitmapOr across both branches instead of degrading to a seq scan as finished jobs accumulate.

## 2026-08-14 — Claim-time dead-lettering, with an explicit last_error

**Context:** A job that crash-loops — claimed, worker dies, stale-reclaimed, dies again — never reaches `markFailed`, which is where the normal retry-budget check lives. Without another mechanism it would be reclaimed forever.
**Decision:** The claim statement itself checks the budget: if `attempts + 1 > max_attempts`, the job transitions to `'dead_letter'` instead of `'processing'`, and the worker skips the handler entirely on seeing that status. That branch also writes an explicit `last_error` naming the cause ("dead-lettered at claim: exceeded max_attempts (N) after repeated processing timeouts; last claimed by X").
**Alternatives:** Dead-lettering only in `markFailed` (rejected — unreachable for exactly the jobs that most need bounding). Leaving `last_error` untouched on that branch (rejected — the row would carry a stale message from an earlier attempt, or NULL if it crashed on its first, and an undiagnosable dead letter only half-answers the brief's requirement to handle permanently failed messages).
**Consequence:** Every dead letter carries a reason, whichever path produced it. The claim query is correspondingly denser — four `CASE` expressions keyed on the same budget predicate.

## 2026-08-14 — Fencing token: claimed_at failed silently, replaced by an opaque claim_token

**Context:** No row lock is held during processing (deliberately — see the stale-reclaim entry above), so a worker that stalls past `PROCESSING_TIMEOUT_MS` without actually dying can have its job reclaimed by another worker, then finish and write its own disposition, clobbering the new claim. The disposition writes need a fencing token: a value captured at claim time and replayed in the `WHERE` clause, so a superseded worker updates zero rows.

**What we tried first, and how it broke.** The obvious token was `claimed_at` — already on the row, already returned by the claim query, no schema change. It was wrong, and wrong in the worst way: silently. Postgres `timestamptz` stores microseconds (`19:05:31.692347+00`), but the value round-trips through a JS `Date` and back out via `.toISOString()`, which truncates to milliseconds (`19:05:31.692Z`). The equality check therefore *never* matched. Every `markSucceeded` and `markFailed` updated zero rows, logged `job.disposition_superseded`, and returned normally. Jobs stranded in `'processing'` forever; nothing threw, and the happy path looked like a concurrency-safety feature working correctly. Lint and typecheck were clean throughout — the bug lived entirely in a value's round-trip precision, which no static check inspects. It surfaced only because the verification script asserted the *post-state* of the row (`status = 'succeeded'`) rather than just that the call returned without error.

**Decision:** A dedicated `claim_token uuid` column, regenerated with `gen_random_uuid()` on every claim, replayed by the worker in the `WHERE` clause of both disposition writes. A superseded worker updates zero rows and logs `job.disposition_superseded` — now a genuine signal rather than the permanent state.

**Alternatives:** Fixing the precision instead of changing the mechanism — comparing `date_trunc('milliseconds', claimed_at)`, or returning `claimed_at::text` at full precision and casting back. Both work, and both were rejected for the same reason: they keep a correctness guarantee balanced on timestamp precision surviving two serialization layers and a timezone rendering. An opaque UUID has no semantics to get wrong — it is equal or it isn't.

**Consequence:** One nullable column and a migration, versus a one-line cast. Worth it: the failure mode being *silent* is the whole argument. A token that can't be subtly wrong is worth more than a token that's currently correct because someone reasoned carefully about microseconds once.

## 2026-08-14 — Placeholder handler is a no-op success, not a NotImplemented throw

**Context:** The worker loop needs something to call per claimed job, but correlation (slice 4) and LLM enrichment (slice 5) don't exist yet.
**Decision:** `src/worker/processEvent.ts` resolves without doing anything, commented as the seam where slices 4-5 land.
**Alternatives:** `throw new Error("not implemented")` (rejected — it would route every real job to failure and then the DLQ, making working queue mechanics look broken and burning the retry budget of every event ingested before slice 4).
**Consequence:** Slice 3's observable success is `pending → processing → succeeded` plus the log line, which is exactly what the queue mechanics are supposed to produce. The retry/backoff/DLQ paths can't be exercised through the happy path, so they were verified by driving the queue functions directly against manufactured job rows.

## 2026-08-14 — Poll interval is idle-only; sleep is abortable

**Context:** A naive loop sleeps every iteration, which makes the poll interval a per-job tax and caps throughput at one job per interval regardless of how fast processing is. Separately, an idle worker asleep in a poll interval ignores a shutdown signal until the timer expires.
**Decision:** Sleep only when a claim returns nothing — after a successful claim, and after a claim-time dead-letter, the loop continues immediately. And the sleep is abortable: the signal handler resolves the in-flight timer, extracted into `src/lib/sleep.ts` (`createSleeper()`) so the wake behaviour is directly exercisable rather than trapped inside the loop.
**Alternatives:** Sleeping unconditionally each iteration (rejected — throughput would be bounded by the interval instead of by processing time, which is the wrong answer to the brief's traffic-spike question). Leaving the sleep inline in `index.ts` (rejected — Windows never generates SIGTERM, so the signal path can only be verified in the Linux container at slice 10; extracting the sleeper at least makes the wake mechanism itself verifiable now).
**Consequence:** Under load a burst drains as fast as workers can consume it. Verified: `wake()` cut a requested 60000ms sleep to 65ms, while an un-woken sleep ran its full duration.

## 2026-08-14 — Backoff constants are demo-appropriate placeholders

**Context:** Retry scheduling needs a formula and numbers.
**Decision:** Exponential, base 1s, cap 5m, no jitter, in `src/lib/queue/backoff.ts`.
**Alternatives:** Jittered backoff (rejected for now — a single worker process has no thundering herd to spread, and jitter would add non-determinism to verification for no benefit at this scale).
**Consequence:** With the default `max_attempts = 5` the schedule actually exercised is 1s, 2s, 4s, 8s before the fifth failure dead-letters, so the 5m cap is never reached in practice. These are chosen for demo-ability, not tuned from any real failure distribution — worth saying plainly rather than implying rigor that isn't there.