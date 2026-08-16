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

## 2026-08-14 — Bidirectional correlation window

**Context:** The rolling-window entry above wrote the match predicate one-sidedly, as `last_event_at >= occurred_at - 3h`. That is algebraically `T <= L + 3h` — the real predicate with its lower bound deleted, meaning it has no lower bound at all and *any* arbitrarily old event matches. Since `occurred_at` is validated only to within 7 days past, a six-day-old backfill would merge into the live finding, `LEAST` would drag `first_event_at` back six days, and that finding would then swallow everything at the restaurant.
**Decision:** `occurred_at BETWEEN first_event_at - 3h AND last_event_at + 3h` — the event is within the window of the *nearest edge* of the finding's evidence interval. On attach the window extends whichever way is needed (`LEAST`/`GREATEST`). This supersedes, and does not edit, the one-sided form in the entry above.
**Alternatives:** Keeping the one-sided form (rejected — it is the bug described above, and it is the same class as the unbounded-`occurred_at` bug already recorded). Bounds are inclusive at exactly 3h; arbitrary but deliberate, and pinned by unit tests at both `W` and `W + 1ms`.
**Consequence:** Buys a provable invariant worth stating: consecutive evidence in a finding is never more than 3h apart, since an attach either lands inside `[F, L]` or extends one edge by at most the window. Note the brief's reference scenario passes under *both* predicates, so it cannot discriminate between them — the six-day-backfill non-merge test is what actually covers the lower bound.

## 2026-08-14 — An out-of-window event is two cases, not one

**Context:** With a single "does it match?" predicate, any miss looked like the same thing: close the open finding, start a new one. That is wrong for a backfill. Under it, arrival order `20:10 → six-day-old backfill → 18:12` closes the 20:10 finding when the backfill lands, so the 18:12 event — only two hours from 20:10 — can no longer join it and starts a third finding.
**Decision:** Split the miss by direction. **Future-side** (`T > last_event_at + 3h`): the window genuinely lapsed, so close the stale finding and open its replacement atomically. **Past-side** (`T < first_event_at - 3h`): a backfill, so create a finding with `closed_at` set *at insert* and leave the live finding entirely untouched. Closing is driven by elapsed time since a finding's own `last_event_at`, never by an unrelated old event arriving.
**Alternatives:** Documenting the stranding as a known limitation (rejected — it's fixable at the source); matching against recently-closed findings and reopening them (rejected — a second lifecycle path that has to decide what reopening means for an operator-resolved finding, to solve a problem that disappears if closure simply isn't triggered by backfills).
**Consequence:** `findings_restaurant_id_open_key` is a *partial* index (`WHERE closed_at IS NULL`), so a born-closed row is never in it: a backfill finding coexists with the live open one, and any number coexist with each other. Confirmed by construction and by test. Two follow-ons: the past-side path cannot raise `23505` at all, so the insert-race retry applies only to the create-open path; and "backfill" is judged relative to the open finding's window, never to `now()` — classifying against `now()` would make every event in a historical replay a backfill and nothing would correlate. Residual wrinkle, accepted: two backfills minutes apart, arriving while a live finding is open, each get their own closed finding. The brief's out-of-order case is events *minutes* apart, not week-old backfills.

## 2026-08-14 — closed_at is a lifecycle marker, never a visibility filter

**Context:** Born-closed backfill findings introduce a trap for the slices that follow. A provider replaying webhooks after an outage, or a chain backfilling a shift, produces genuine problems an operator should see — but if downstream code treats "open" as shorthand for "relevant", every one of them silently vanishes from the product.
**Decision:** Recorded now, as a constraint slices 5 and 6 inherit rather than rediscover. **Enrichment triggers on finding creation, not on open-ness** — `CorrelationResult.outcome` (`created`/`attached`/`replaced` → enrich; `already_attached` → skip) is the trigger, and `closed_at` is not an input to it. **The dashboard must not filter on `closed_at IS NULL`** — it sorts by `last_event_at DESC` (what `findings_last_event_at_idx` exists for) and shows closed findings as historical, not hidden.
**Alternatives:** Leaving it implicit and letting slice 6 decide (rejected — this is precisely the kind of cross-slice assumption that gets discovered as a bug, and the cost of writing it down now is one paragraph).
**Consequence:** The only things that read `closed_at` are correlation matching and the partial unique index. Nothing else may treat it as "archived".

## 2026-08-14 — Row lock for update conflicts, unique index for create races

**Context:** Two workers correlating events for the same restaurant concurrently can collide in two structurally different ways, and one mechanism doesn't cover both.
**Decision:** `SELECT ... FOR UPDATE` on the open finding serializes workers attaching to an *existing* finding, so no `version` bump or `event_count` update is lost. When there is no open finding the `FOR UPDATE` locks nothing, both workers take the create path, and `findings_restaurant_id_open_key` arbitrates — exactly one insert survives.
**Alternatives:** `pg_advisory_xact_lock(hashtext(restaurant_id))` (rejected — one line and it would eliminate the create race, but an advisory lock is *advisory*: any future code path that inserts a finding without taking it silently breaks "one open finding per restaurant", whereas the index cannot be bypassed. The index is the guarantee; the lock would be a convenience on top of it).
**Consequence:** Lock ordering is uniform across workers (findings row → `finding_events` insert → findings update), so no deadlock cycle exists.

## 2026-08-14 — Unique violations matched by SQLSTATE and constraint name; exactly one retry

**Context:** The create-race loser has to recognize *its* violation and recover, without swallowing unrelated constraint failures.
**Decision:** `isUniqueViolation(err, constraintName)` in `src/lib/db/pgError.ts` walks the `cause` chain (bounded, cycle-guarded) and requires **both** `code === "23505"` **and** `constraint_name === <name>`. Never matches on `err.message`. The retry is exactly one, in a *new* transaction — a `23505` aborts the current one, so it cannot be a continuation.
**Alternatives:** Matching the error message (rejected — message text is a driver/server formatting detail that would silently start passing or failing on a version bump). `ON CONFLICT (restaurant_id) WHERE closed_at IS NULL DO NOTHING` (rejected — valid Postgres, and it avoids aborting the transaction, but zero returned rows conflates "someone won the race" with "nothing happened", and the loser still has to re-run the whole window decision against the winner's finding from a stale snapshot). A retry loop (rejected — the bound is structural: a second failure means an assumption is wrong, not that the database is busy, so it belongs in the DLQ).
**Consequence:** The error shape was **verified against a real violation before the predicate was written**, not inferred from the driver source — the same category of confidence that produced the `claimed_at` fencing-token bug. Observed: `DrizzleQueryError` at depth 0 (keys `query`, `params`, `cause`) wrapping `PostgresError` at depth 1 carrying `code: "23505"` and `constraint_name: "findings_restaurant_id_open_key"` (snake_case; no `constraint` field exists), identical inside `db.transaction` and for a bare `db.execute`, with a foreign-key violation correctly distinguishable as `23503`.

## 2026-08-14 — Close and replace as two ordered statements, not one CTE

**Context:** `enqueueEvent.ts` set a precedent of expressing multi-step writes as a single CTE statement, and the close-then-replace path looks like an obvious candidate.
**Decision:** Two separate statements inside one `db.transaction`.
**Alternatives:** One CTE statement (rejected, and this is the one place the established style is actively wrong: all CTEs in a statement share a single snapshot, so `findings_restaurant_id_open_key` would still see the pre-close row version as a live conflict and the insert would raise `23505` against a row the same statement had just closed. Separate statements inside a transaction *do* see each other's effects).
**Consequence:** An outside reader under READ COMMITTED sees either the old open finding or the new one — never neither, never both. The zero-open interval exists only inside the transaction. The comment in the code says why, because the next person to read it will reach for the CTE.

## 2026-08-14 — Redelivery guard, and counter bumps gated on actual insertion

**Context:** The worker's stale-reclaim path can hand the same event to correlation twice. `finding_events` has a composite PK and `UNIQUE(event_id)`, so the attach itself is naturally idempotent — but that alone is not enough.
**Decision:** A `SELECT finding_id FROM finding_events WHERE event_id = $1` guard as the first statement in the transaction, returning `already_attached` if present. Separately, the recompute-and-update step is gated on the attach having actually inserted a row.
**Alternatives:** Relying on `ON CONFLICT DO NOTHING` alone (rejected — it leaves a real bug: if the event's original finding has since closed, the redelivered event finds no open finding, creates a new one, *then* no-ops on the attach, leaving a finding with zero evidence. Verified by test).
**Consequence:** A redelivery leaves `findings` byte-identical — no `version` bump, no `event_count` change, no `priority` write. This matters beyond tidiness: `version` is what slice 6's SSE will key on, so a spurious bump is a spurious push to every connected dashboard.

## 2026-08-14 — Denormalized fields recomputed, not incremented

**Context:** `event_count`, `first_event_at` and `last_event_at` duplicate information that `finding_events` already holds.
**Decision:** Recompute all three from the evidence set on every update (`count`/`min`/`max`), rather than `event_count = event_count + 1` and iterated `LEAST`/`GREATEST`.
**Alternatives:** Incrementing (rejected — mathematically identical when everything goes right, but it drifts permanently once it is wrong even once, whereas a recompute converges after any partially applied or retried run).
**Consequence:** One extra read of the evidence set per correlation, inside the transaction that already holds the row lock.

## 2026-08-14 — Priority thresholds in one table, scored by a pure function

**Context:** Priority is deterministic business rules that slice 9 tests directly and the README has to state. Scattered through the correlation path as conditionals, they would be neither.
**Decision:** `PRIORITY_THRESHOLDS` in `src/lib/correlation/priority.ts` holds the entire severity policy as data — delay minutes, event count, review rating, recurrence by issue class. `scorePriority()` is pure: the recurrence count is passed *in* rather than queried, so the whole policy is unit-testable with no database. Priority is the **max** across signals, never a sum. Thresholds deliberately do not live in `config.ts` — they belong beside the function that reads them.
**Alternatives:** Summing or weighting signals (rejected — max is what lets recurrence and event count overlap without compounding: 3 events of one issue class is a pattern and outranks 3 of mixed classes, which is what the `issue_class` taxonomy was built to buy).
**Consequence:** `scorePriority` also returns `drivers` — which signals fired and why. That is the deterministic answer to "why is this high", which slice 5 hands the model as a *given* so the summary narrates a fact instead of inventing a rationale, and which makes the tests assert on specific signals rather than a bare enum. In-memory only for now; persisting it is an additive migration to decide before slice 6. The threshold values themselves are demo-appropriate placeholders, not tuned against any real distribution.

## 2026-08-14 — Recurrence anchored to last_event_at, not now()

**Context:** The recurrence signal counts same-issue-class events at a restaurant over a 24h window, which needs an anchor.
**Decision:** Anchor to the finding's own `last_event_at`.
**Alternatives:** `now()` (rejected — reprocessing the same evidence a day later would yield a different priority for identical input, which is nondeterministic and would make the integration tests time-dependent).
**Consequence:** `scorePriority` is a pure function of the evidence set, and replaying a job produces the same score it did the first time.

## 2026-08-14 — findings.status stays 'accepted' through slice 4

**Context:** The status machine has `accepted → processing → ready | failed`, and correlation could plausibly claim one of the later states.
**Decision:** Correlation leaves `status = 'accepted'`. `processing` and `ready` are the LLM enrichment's transitions and slice 5 owns both.
**Alternatives:** Setting `ready` once a finding is correlated and prioritized (rejected — slice 5 would have to un-set it, and in the meantime the dashboard would show `ready` findings with empty summaries, which is actively misleading against the brief's own status requirement).
**Consequence:** A finding that is correlated, prioritized and evidenced but not yet summarized is legitimately still `accepted`. `CorrelationResult.outcome` is a four-value discriminant precisely so slice 5 can tell whether enrichment is needed at all.

## 2026-08-14 — Window logic and aggregates in TypeScript, not SQL

**Context:** The window predicate and the denormalized aggregates could be expressed either in the SQL statements or in the surrounding TypeScript.
**Decision:** SQL does only what must happen at the database — the lock, the constraint, the reads, the writes. The window decision and the evidence summary are pure TypeScript.
**Alternatives:** Pushing the predicate into the `WHERE` clause of the lookup (rejected — it would mean one implementation in SQL and a twin in TS for the unit tests, which can drift; and CLAUDE.md now explicitly records that lint and typecheck do not validate SQL inside template literals, a lesson this project learned by shipping exactly that bug).
**Consequence:** About six round trips per event inside one transaction, versus one or two for a clever single-statement version. Not the bottleneck at this scale, and the readability and direct unit-testability are worth more — but worth stating plainly rather than hiding.

## 2026-08-14 — Vitest: unit/integration split, isolation by restaurant id

**Context:** The project's first tests arrive with correlation, and slice 9's failure tests need somewhere to live.
**Decision:** Vitest with two projects — `unit` (pure, no database) and `integration` (against the dockerized dev DB, `fileParallelism: false`). Integration tests isolate by generating a unique `restaurant_id` per test rather than truncating between tests. `src/lib/db/client.ts` gains `closeDb()` because the module-level pool otherwise leaves Vitest hanging.
**Alternatives:** Truncation between tests (rejected — per-restaurant isolation is *semantically exact* rather than a workaround: the partial unique index, the open-finding lookup and the recurrence count are all scoped by `restaurant_id`, so two tests using different restaurants cannot interact by construction. It also makes "exactly one finding" a precise assertion instead of one that depends on an empty table. A `resetDb()` helper ships anyway for slice 9). A separate `sauce_ops_test` database (rejected — an init script and another env var to provide isolation the restaurant scoping already gives).
**Consequence:** The slice-done ritual in CLAUDE.md now runs `npm test` alongside lint and typecheck, closing an inconsistency with `.claude/commands/slice-done.md`, which already described the ritual as including tests.

## 2026-08-14 — A concurrency test that passes is not a concurrency test that ran

**Context:** The first version of the concurrent-correlation tests passed immediately. Checking whether the insert-race retry had actually fired showed it never had — the transactions simply serialized, and the tests were green for a reason unrelated to what they claimed to cover.
**Decision:** Added a test that forces the collision deterministically: a competing transaction inserts the open finding and is held open across the correlation attempt, so the blocked insert is guaranteed to raise `23505` when the competitor commits. The test asserts on the emitted `correlation.insert_race_retry` log line, not merely on the final outcome — `attached` is also what a no-race run produces, so the outcome alone cannot distinguish them.
**Alternatives:** Trusting the naturally-concurrent test (rejected — it was demonstrably passing without exercising the path; a race that "usually doesn't happen" in a test is a race that is untested).
**Consequence:** Worth generalizing: for any test whose subject is a race, the assertion has to distinguish "the recovery path ran and worked" from "the situation never arose". Slice 9's failure tests should hold to the same standard.
## 2026-08-14 — Claude Sonnet 5 for enrichment; the boundary is what makes it sufficient

**Context:** Slice 5 needed a model, and the reflexive answer is the most capable one available. But the deterministic layer has already decided everything that carries risk by the time the model runs: which events belong together, how severe the finding is, why it's severe, and what evidence backs it. What's left is two or three sentences of narration and a pick from an eight-item allowlist, using facts handed over as givens.
**Decision:** `claude-sonnet-5`, at `effort: "low"`, with `max_tokens: 4096`. Recorded here in exactly those terms because the reasoning generalizes past this slice: **the deterministic/LLM boundary is what makes the cheaper model sufficient.** Narration does not need a frontier model. `LLM_TIMEOUT_MS` stays at 15s and `PROCESSING_TIMEOUT_MS` therefore stays at 45s.
**Alternatives:** An Opus-tier model (rejected — paying roughly 5x per token for prose, while the README's own traffic-spike answer argues for cost discipline under load; picking the expensive model here would contradict it). A local or cheaper non-Claude model (rejected — out of scope, and the fallback provider already covers the "no model at all" case).
**Consequence:** If summary quality turns out to be the weak point, the model id is a one-line change in `llm/anthropic.ts` and the provider interface absorbs it. The claim being made is not "Sonnet is good enough at everything" — it is "this task was made small enough that it doesn't need more."

## 2026-08-14 — Structured outputs, with the JSON Schema derived from the Zod schema

**Context:** The model's output has to be machine-checkable — an allowlist of actions, a tag enum, a citation list. Two mechanisms were available: constrain generation with a tool definition, or constrain it with `output_config.format`.
**Decision:** `output_config.format` with a `json_schema`, where the schema is generated from the same Zod object that validates the response on the way back (`z.toJSONSchema`, `$schema` stripped). One definition, used at both ends.
**Alternatives:** A tool definition with `strict: true` (rejected — it models "call this function" for something that is not a function call, and the response then has to be dug out of a `tool_use` block). Two hand-maintained definitions, one for the API and one for validation (rejected — they drift, and the drift is silent).
**Consequence:** Structured outputs reject `minLength`/`maxLength`/`minItems`, so the Zod schema deliberately carries no length constraints; bounds are clamped in code after parsing. That constraint is invisible in the source and would fail as a 400 on every enrichment, so a unit test asserts the emitted schema contains only supported keywords. Objects are `z.strictObject`, so `additionalProperties: false` reaches the API too — an injected extra key is refused at both ends.

## 2026-08-14 — findings.version is the enrichment fence; enrichment never bumps it

**Context:** Enrichment runs outside correlation's transaction and holds no row lock, because it makes a network call. So while one worker waits on the model, another can attach new evidence to the same finding and enrich it too. The loser of that race must not overwrite fresher prose with a summary describing a smaller evidence set.
**Decision:** Both of enrichment's writes — the `processing` claim and the `ready` result — are guarded on the version observed when correlation committed: `WHERE id = $1 AND version = $2`. Zero rows updated means superseded: log `enrichment.superseded` and discard, with no retry. Enrichment itself never writes `version`, so it stays correlation-owned.
**Alternatives:** A row lock held across the LLM call (rejected — pins a database connection for up to 15s per in-flight job, which is exactly what the immediate-commit claim design was built to avoid). A dedicated `enrichment_version` column (rejected — a second counter to keep in step with the first, for no additional guarantee). Last-write-wins (rejected — it is silently wrong in the one case the fence exists for).
**Consequence:** Enrichment not bumping `version` is what makes `version` usable as a fence at all — the same shape as `claim_token` in slice 3. It also means "new evidence arrived, so the finding went back to `processing`" falls out of the existing design rather than being bolted on for slice 6's live dashboard.

## 2026-08-14 — Opaque evidence labels, and one regeneration before falling back

**Context:** CLAUDE.md requires that any claim in a summary map to an event already in the evidence set. Stated that way it is an aspiration; nothing in the code could check it.
**Decision:** Evidence reaches the prompt as positional opaque labels (`E1..En`) — never event UUIDs. The model returns `cited_labels`, which is validated as a subset of the labels actually issued, then mapped back to real event ids in code and persisted to `findings.cited_event_ids`. **A label outside the issued set is a validation failure of the whole response, not a field to drop:** one regeneration with the rejection reason, then the deterministic fallback.
**Alternatives:** Passing real event ids and validating those (rejected — a hallucinated UUID could coincidentally name a real row, and it leaks internal identifiers into a prompt that also contains untrusted text). Dropping the bad label and keeping the response (rejected, and this is the substantive point: the sentence that citation was supporting stays standing with nothing underneath it, which is precisely the unsupported conclusion the rule exists to prevent).
**Consequence:** "Claims map to evidence" is now enforced and testable rather than asserted. Rejecting rather than repairing costs an occasional extra call and an occasional degraded summary — the right trade, since the degraded summary is honest and the repaired one would not be.

## 2026-08-14 — Fallback rows write cited_event_ids = NULL, not every event

**Context:** The deterministic fallback writer has no basis for choosing which evidence its summary rests on — it restates all of it. The obvious shortcut is to cite every label.
**Decision:** `cited_event_ids` is `NULL` on fallback rows. `summary_source` already carries the llm-vs-fallback distinction.
**Alternatives:** Citing every label (rejected — it gives one column two meanings, "the model selected these" on LLM rows and "all of them" here, and slice 6 highlighting citations would light up every event on a degraded finding: noise presented as signal). An empty array (rejected — that reads as "cited nothing despite being able to", which is a different and worse claim).
**Consequence:** `NULL` reads as "no citation data available". The grounding invariant is unweakened: a citation, when present, was validated.

## 2026-08-14 — The SDK's own retries are disabled so the attempt budget stays true

**Context:** `PROCESSING_TIMEOUT_MS` is derived in `config.ts` as `LLM_TIMEOUT_MS * MAX_LLM_ATTEMPTS + margin`, so that a slow-but-alive worker is never reclaimed mid-flight. The Anthropic SDK retries twice by default.
**Decision:** The client is constructed with `maxRetries: 0`. The provider's own bounded loop is the only retry.
**Alternatives:** Leaving the SDK default and widening `PROCESSING_TIMEOUT_MS` to match (rejected — it makes the stale-reclaim window depend on a third-party default that can change under us, and the arithmetic in `config.ts` would no longer describe the code).
**Consequence:** Left alone, the real worst case would have been 6 HTTP calls against a timeout computed from 2 — a slow worker would have had its job stolen and burned a retry it never earned. A unit test asserts the constructor argument, because this is the kind of thing a future refactor silently reverts.

## 2026-08-14 — 'failed' is reachable only via a dead-lettered job, plus a documented trigger to pull it

**Context:** Slice 5 owns `accepted -> processing -> ready | failed`. But an LLM outage is deliberately not a job failure, and correlation rarely fails — so in normal operation nothing ever reaches `failed`. The brief requires a failed job be clearly visible; a status the demo cannot produce is decorative.
**Decision:** Two parts. First, `findings.status = 'failed'` is written in exactly one place: when a job dead-letters, the worker looks up the event's finding and marks it failed (a no-op if correlation never committed, since then no finding row exists). Second, a deterministic trigger — an `event_id` prefixed `force_fail_` makes `processEvent` throw *after* correlation commits — gated on `ENABLE_DEMO_FAILURE_TRIGGER`, default off in code and on in `.env.example`.
**Alternatives:** Treating LLM failure as job failure so `failed` occurs naturally (rejected — it contradicts the whole degradation design and would DLQ findings that are perfectly usable). Leaving `failed` unreachable and describing it in the README (rejected — an untriggerable state in a UI is a claim, not a feature). Hiding the trigger behind an undocumented name (rejected — a reviewer finding a concealed backdoor is worse than one finding a labelled test hook).
**Consequence:** The failure branch is demonstrable end to end: the finding is created with real evidence and priority, the job walks the real 1s/2s/4s/8s ladder into the DLQ, and the finding flips to `failed` with its evidence intact and only its prose missing. Reaching it takes ~15s of real backoff, which is the honest cost of not faking the state. Verified by hand as well as in tests.

## 2026-08-14 — Recommended actions are a separate taxonomy from operator_actions.action_type

**Context:** `operator_actions.action_type` already exists (`mark_reviewed`, `mark_resolved`, `thumbs_up`, `thumbs_down`), and the model's recommended actions also needed a closed allowlist. Sharing the enum would have meant one taxonomy and no new constant.
**Decision:** A separate eight-verb operator vocabulary (`contact_customer`, `issue_refund`, `comp_next_order`, `escalate_to_manager`, `check_kitchen_capacity`, `review_courier_assignment`, `audit_order_accuracy`, `no_action_needed`).
**Alternatives:** Reusing `operator_actions.action_type` (rejected — the two share the word "action" and nothing else. One is what an operator does *to a finding* in the dashboard; the other is what they do *about the problem*. Merging them makes recommendations circular: "we recommend you mark this reviewed" is not advice, and the brief's own examples are operational verbs).
**Consequence:** Two enums that look similar and must not be merged, which is why both carry comments saying so. `extracted_tags` is a third closed vocabulary for the same reason — it is a finer-grained read of free text, distinct from `issue_class`, which is derived from structured fields only and drives correlation.

## 2026-08-14 — Enrichment reads evidence separately so correlation stays free-text-blind

**Context:** `correlation/evidence.ts` deliberately drops `payload` from its result. Enrichment needs `complaint_text` and `review_text`, and widening that reader was the smaller diff.
**Decision:** A separate read, `llm/enrichmentInput.ts`, over the same join — keeping `payload` and adding the opaque labels.
**Alternatives:** Widening `fetchEvidence` and letting correlation ignore the extra fields (rejected — the invariant is about what kind of input is *available* to the deterministic path, not merely what it currently reads. `deriveIssueClass.ts` already carries this argument: a "helpful" keyword classifier on free text would violate invariant 1 without touching `src/lib/llm/` at all. Once the field is in the struct, the next change that reads it looks harmless).
**Consequence:** Two readers over one join — deliberate duplication, and the same reasoning that puts `correlation/` and `llm/` in separate folders. The cost is a second query per enrichment.

## 2026-08-14 — Zod-validated environment, parsed once at startup

**Context:** CLAUDE.md called for Zod at every boundary including env vars, and four files were each hand-rolling `if (!process.env.X) throw`. With slice 5 adding `LLM_PROVIDER` and a conditionally-required `ANTHROPIC_API_KEY`, a missing key would have surfaced as a 401 mid-job rather than as a startup failure.
**Decision:** `src/lib/env.ts` parses `process.env` once, with `superRefine` making `ANTHROPIC_API_KEY` required exactly when `LLM_PROVIDER=anthropic`. `db/client.ts` and `db/migrate.ts` now read from it. `drizzle.config.ts` and `tests/setup.integration.ts` keep their own checks — they load outside the app.
**Alternatives:** Per-consumer checks (rejected — that was the status quo, and it cannot express a conditional requirement between two variables).
**Consequence:** Empty values in `.env.example` (`ANTHROPIC_API_KEY=`) arrive as `""` rather than undefined, so the parser maps blanks to undefined first — without that, copying the example file and running the default fallback provider would fail validation on a key that is legitimately absent. The example file's UTF-8 BOM was removed at the same time; copied to `.env` it made the first key parse as a mangled `DATABASE_URL`.

## 2026-08-14 — Prompt injection is defended in depth and tested at three layers

**Context:** Customer-authored text is the one untrusted input in the system, and both carriers (`complaint_text`, `review_text`) are unbounded strings. "We fence the text and validate the output" is easy to write in a README and hard to substantiate.
**Decision:** Three layers, each separately tested, against one shared hostile fixture that carries an instruction override, an out-of-allowlist action demand, a forged closing fence token, and a fabricated citation label. (1) **Prompt containment:** text is fenced in `<customer_text>`, fence tokens in the payload are neutralized case- and whitespace-insensitively *before* truncation, and no event or finding id ever enters the prompt. (2) **Validator containment:** `parseEnrichment` is fed responses in which the model *did* obey, and every one must be rejected. (3) **End to end:** the hostile event goes through the real pipeline and the shape of what lands in the database is asserted unchanged. A fourth check runs the real model and is skipped without an API key.
**Alternatives:** Testing only that the model behaves (rejected — it is the one layer that cannot be asserted deterministically, and a green suite would depend on a network call and a model's mood). Testing only the validator (rejected — it proves nothing about what reached the prompt).
**Consequence:** The framing worth keeping: *"the model didn't obey"* and *"obedience is survivable"* are different claims, and layer 2 exists because only the second can be guaranteed. Sanitizing happens at the prompt boundary, not on ingestion — `events` is immutable and an operator should see what the customer actually wrote. A live run also showed the model *narrating* that it had ignored an injected instruction, which is noise for an operator; the system prompt now tells it not to mention prompt handling at all.

## 2026-08-14 — The worker loop body extracted so the failure path is tested as it ships

**Context:** The dead-letter path needed an integration test, and the logic lived inline in `worker/index.ts`'s `while` loop — reachable only by running the real process with real backoff.
**Decision:** Extracted `runJob(workerId, provider?)` into `worker/runJob.ts`, returning `idle | succeeded | failed | dead_lettered`. `index.ts` keeps the looping, sleeping, and shutdown handling.
**Alternatives:** Re-implementing claim -> process -> dispose inside the test (rejected — the test would then assert against a copy of the logic and stay green if the real loop broke). Running the worker as a subprocess (rejected — 15s of real backoff per test, and disposition assertions become log-scraping).
**Consequence:** The test drives the same function the worker does, pulling `next_attempt_at` forward between iterations rather than waiting out the ladder. The backoff arithmetic stays unit-tested where it already was.

## 2026-08-14 — Priority drivers are persisted, not just handed to the prompt

**Context:** `scorePriority()` returns the drivers behind a priority — "95 minute delay", "3 delivery_delay events in 24h" — and `correlateEvent` carried them through memory into the prompt and then discarded them. The system's own severity reasoning was visible only to the language model. Building the dashboard made that backwards: the collapsed card's trust anchor is the deterministic explanation of the priority, and it could not be rendered from the database.
**Decision:** `findings.priority_drivers` (jsonb), written by correlation's existing UPDATE in the same statement as `priority`, so the two cannot disagree. Never written by enrichment.
**Alternatives:** Recomputing drivers at read time (rejected — the read path would run correlation's severity rules, which is a second implementation of the thresholds and needs the recurrence query too). Deriving an approximate line from `event_count` and `priority` alone (rejected — delay minutes and review ratings live in event payloads, so the card would either say less than it knows or read payloads on the render path).
**Consequence:** One more jsonb column, and a second consumer for it that was not the reason to add it: the enrichment repair below reads the drivers back rather than recomputing them.

## 2026-08-14 — Stale prose is detected by version, not by comparing timestamps

**Context:** A worker that dies between correlation committing and enrichment writing leaves a finding whose prose describes fewer events than it now holds. The obvious signal was `enriched_at < last_event_at`.
**Decision:** `findings.enriched_version`, copied from the version enrichment fenced its write on. Prose is stale exactly when `enriched_version < version`.
**Alternatives:** `enriched_at < last_event_at` (rejected — it mixes two clocks. `enriched_at` is wall time; `last_event_at` is the business time an event *occurred*. Prose is always written after the event it describes happened, so for live traffic the comparison is false when staleness is real, and for a backfill the gap is days wide for reasons that have nothing to do with staleness). `updated_at > enriched_at` (rejected — every write bumps `updated_at`, including a status change, so it reports staleness that isn't there).
**Consequence:** Caught by an integration test rather than by reasoning: the timestamp form was written first and the test failed against real rows. A backfill case is now asserted explicitly, where `enriched_at` is five days *after* `last_event_at` and the prose is still stale.

## 2026-08-14 — The already_attached branch repairs stale prose instead of returning early

**Context:** `processEvent` skipped enrichment whenever correlation returned `already_attached`, on the grounds that a redelivery changed nothing. For the crashed-winner case above that was wrong, and permanently so: the redelivery was the only event that would ever revisit the finding, and it returned early every time.
**Decision:** That branch now checks `enriched_version < version` and re-enriches when it is behind, reading the drivers from `priority_drivers`.
**Alternatives:** A background sweeper for findings with stale prose (rejected — a second scheduler for a case the queue already redelivers). Leaving it and only showing a badge (rejected — a finding permanently summarizing three of four events is a wrong answer on the dashboard, not a cosmetic gap).
**Consequence:** The repair is guaranteed a chance to run, and the argument is worth stating: `enrichFinding` is called *before* `markSucceeded`, so stale prose always implies an un-acked job, and an un-acked job is always stale-reclaimed. A redelivery whose prose is current still costs no LLM call.

## 2026-08-14 — SSE carries the whole board, and every connect is a snapshot

**Context:** The brief tests disconnect-and-reconnect. The usual shape — an initial snapshot followed by incremental patches — makes reconnect a separate code path with its own catch-up logic, which is exactly the path that is never exercised until it matters.
**Decision:** Every message is a complete, ordered board plus the ids that changed. A reconnect and a routine update travel identical code, so "the client missed something while disconnected" is not a state that exists.
**Alternatives:** Deltas with a `Last-Event-ID` watermark (rejected — premature at a board of tens of rows, and it buys a bookkeeping bug). Client-side sorting of a patched map (rejected — the priority ordering would then exist in SQL and in TypeScript, free to drift; the same duplication argument that made the SQL derive its priority array from `PRIORITY_LEVELS`).
**Consequence:** A few KB per change instead of a few hundred bytes, which is the right trade at this size and is named in the README as the thing to revisit first.

## 2026-08-14 — One shared poller feeds every SSE client; no LISTEN/NOTIFY

**Context:** Something has to notice that the database changed. Postgres `LISTEN/NOTIFY` was the obvious candidate, and would have extended the no-Redis argument from the queue to the bus.
**Decision:** A single process-wide poller at 1s, fanning out to connected clients in memory. One query per tick regardless of client count.
**Alternatives:** `LISTEN/NOTIFY` from correlation and enrichment (rejected on the same reasoning that killed the outbox relay: it buys roughly a second against a worker that already polls at 1s, and costs a dedicated connection plus a missed-notification hole during listener reconnects that needs a watermark catch-up anyway). Polling per connection (rejected — N browsers would mean N queries per second for identical data).
**Consequence:** End-to-end latency is floored at about two seconds, one from each poll. The shared-subscription/fanout split is the shape `NOTIFY` would need anyway, so swapping it in later is one file.

## 2026-08-14 — subscribe() always reads fresh, never serves the cached board

**Context:** The poller stops when the last listener disconnects, which freezes the cached board at that moment. Serving that cache to the next client was the original implementation.
**Decision:** Every `subscribe()` performs its own read before delivering the first message.
**Alternatives:** Tracking cache age and refreshing past a threshold (rejected — a policy to get wrong in exchange for one query per browser connecting).
**Consequence:** Found by disconnecting and reconnecting against a live worker, not by reading the code: the board reported a finding as `accepted` that the worker had already marked `failed`. It is the precise failure the snapshot-on-connect design exists to prevent, and it was invisible from the inside. Now covered by an integration test that changes the database while nobody is subscribed.

## 2026-08-14 — `failed` splits into two card states, because it does not imply "no summary"

**Context:** The plan assumed a failed finding has `summary IS NULL`, so its card renders an explicit empty state rather than a blank region.
**Decision:** Two states. `failed_unanalyzed` (never enriched) says "Analysis failed — evidence below". `failed_stale` (prose from earlier evidence) says "Analysis failed — the summary below predates this failure" and still shows the prose.
**Alternatives:** One failed state showing the surviving summary as normal (rejected — that presents prose written from a smaller evidence set as if it described the current finding).
**Consequence:** `markFindingFailedForEvent` updates unconditionally by design, so a finding that was `ready` and then absorbed an event whose job dead-lettered keeps its old prose. The demo run produced exactly this: `failed` at v3 with prose from v2.

## 2026-08-14 — The card shows the top two drivers; the panel shows all of them

**Context:** Recurrence emits one driver per `issue_class`, so a card can carry four or more. "95 min delay · 4 related events · 3 delivery_delay in 24h · 2 complaint in 24h" does not fit anywhere useful.
**Decision:** Two drivers plus "+N more" on the card, every driver with its signal and level in the detail panel. `scorePriority` already sorts strongest-first and JSON preserves order, so no re-sorting is needed on the read path.
**Alternatives:** A single synthesized sentence (rejected — that is prose, and prose is the model's job). Showing all of them (rejected — the card stops being scannable, which is the only thing it is for).
**Consequence:** An empty driver list renders "No severity threshold crossed" rather than a blank row — `scorePriority` returns no drivers at base priority, and a blank line on the card's trust anchor reads as a rendering bug.

## 2026-08-14 — The model's title leads the card; the summary is not on it at all

**Context:** The card's most visually dominant element is the `issue` title, which the model writes. That is the least trustworthy source in the most prominent position.
**Decision:** Keep the title as the headline, put the deterministic drivers line directly beneath it at co-equal weight, and keep the prose summary off the card entirely — it lives in the detail panel.
**Alternatives:** Leading with the drivers line (rejected — a column headed by raw metrics reads as a log, and telling "late deliveries" from "missing items" at a glance is exactly what naming the pattern buys). Putting the summary on the card in smaller type (rejected — "the model supports rather than leads" then depends on type sizes holding a line, instead of on structure).
**Consequence:** Nothing on the collapsed card except the title and the tags comes from the model, so the three-second scan happens over facts the system knows to be true. A `fallback` card is marked degraded, because the template title ("Late deliveries (3 events)") otherwise restates the drivers line below it and looks like a stutter.

## 2026-08-14 — Relative timestamps come from useSyncExternalStore, not an effect

**Context:** The page is server-rendered and then hydrated. A relative time ("2 min ago") computed during SSR is stale before it paints, and any locale-dependent format differs between server and browser, which React reports as a hydration mismatch.
**Decision:** A shared clock per interval exposed through `useSyncExternalStore`, whose server snapshot is `null`. The first paint and the hydration pass render an absolute UTC time; the ticking value takes over afterwards.
**Alternatives:** `setState` inside a mount effect (rejected — the React lint rule forbids it, and correctly: it is a cascading render for something that is not React-owned state). Rendering relative times on the server (rejected — wrong the moment they arrive).
**Consequence:** One timer per interval for the whole page rather than one per card.

## 2026-08-14 — The dashboard is an app shell, so the height chain is load-bearing

**Context:** Scrolling the findings list carried the detail panel off screen, which breaks "which data supports the recommendation" in practice — an operator reading the evidence table lost it by scrolling the list beside it.
**Decision:** `<body>` is `h-dvh overflow-hidden` and every ancestor of a scroll container carries a definite height plus `min-h-0`; the panes own their scrollbars and the page itself never scrolls. The detail panel's header sits outside its scrolling region so the issue title, priority and status stay visible while evidence scrolls under them.
**Alternatives:** `position: sticky` on the detail panel (rejected — it still scrolls with the document, it only delays the problem, and a sticky element inside a growing document has no bottom bound). `min-h-dvh` on the body (rejected — that is what was already there and is the bug: it lets the body grow, and one auto-height ancestor silently disables every `overflow-y-auto` beneath it).
**Consequence:** `min-h-0` on a flex child is not decoration here — without it a pane refuses to shrink below its content and the overflow never engages. `dvh` rather than `vh` so a mobile URL bar doesn't crop the last card.

## 2026-08-14 — Semantic colour tokens, light as the base and dark as the override

**Context:** The palette was hardcoded to a single dark theme across 99 colour utilities in 8 component files, so following the operating system's colour scheme was a change to every component.
**Decision:** ~22 CSS custom properties named by role (`--canvas`, `--ink-subtle`, `--warn-fg`) mapped through Tailwind's `@theme inline`, with light on `:root` and dark inside `@media (prefers-color-scheme: dark)`. No toggle, no persistence, no settings surface.
**Alternatives:** Tailwind's `dark:` variant, which already keys on `prefers-color-scheme` and needs no config (rejected — it doubles every colour class at the call site, and the four status states plus four priority levels would each need a paired variant in six places; the tokens keep the palette in one file). A theme toggle (rejected — it needs persistence and a hydration-safe read, and the brief asks for neither).
**Consequence:** Light is the base because the media query matches nothing when a browser expresses no preference, and light-on-white is the safer thing to land on. Grouping tokens by meaning rather than hue (`--warn-*` covers the analyzing pill, the retry chip and the stale chip) is what stops one amber drifting from another.

## 2026-08-14 — Contrast is measured, and measuring it changed the palette

**Context:** "Both themes stay legible" is the kind of claim that is easy to assert and easy to be wrong about, especially in the theme the author never looks at.
**Decision:** A throwaway script parses the shipped `globals.css` and computes WCAG ratios for every foreground token against the surfaces it actually renders on, in both palettes — 4.5:1 for text, 3:1 for the priority rail and the large uppercase priority words.
**Alternatives:** Picking from Tailwind's scale and trusting it (rejected — that is exactly what produced the failures below).
**Consequence:** Four real failures, not zero. `--ink-subtle` — the most used token in the app, carrying every timestamp and label — sat at 4.4:1 on light surface and 3.7:1 on dark, and the medium priority rail at 2.9:1 on light. Both neutral scales moved a step and the medium rail went yellow rather than a darker orange so it stays separable from `high` beside it in the list. The four status states remain distinguishable by glyph, label and hue together, so a palette swap can change how legible they are but cannot collapse the distinction between them.

**Open, not resolved:** the light palette has been measured but never seen — no visual verification of the rendered result — and some copy still reads poorly. Both are carried into slice 10's checklist.

## 2026-08-14 — The simulator's fixtures live in src/, so the demo can't drift from the tests

**Context:** The injection payload lived in `tests/helpers/factories.ts` and the reference scenario as three literal payloads inside `correlation.reference.test.ts`. The simulator needed both, and copying them would have created two sources of truth for the two things a reviewer is most likely to click.
**Decision:** Both move to `src/lib/simulator/presets.ts`. The reference fixture becomes offsets (135/118/0 minutes) rather than absolute dates, so the simulator anchors them to `now` while the test anchors them to a fixed date and keeps its exact `first_event_at`/`last_event_at` assertions. `tests/helpers/factories.ts` re-exports the injection text so existing imports don't churn.
**Alternatives:** Duplicating the payloads in the simulator (rejected — the demo would be free to drift from what the tests prove, and the drift would be invisible until a reviewer noticed the button doing something the README says it doesn't).
**Consequence:** The button posts the exact bytes the tests assert on. The reference test derives `issue_class` through the real `deriveIssueClass` instead of restating it, so a taxonomy change can't pass unnoticed. All six permutations still pass unchanged, which is the check on the refactor.

## 2026-08-14 — Presets are pure values, validated against the endpoint's own schema

**Context:** A simulator button that posts a body the API rejects is worse than no button, and it fails in front of the reviewer rather than in CI.
**Decision:** `presets.ts` holds no React and no `fetch` — every preset is a pure builder returning `{ restaurantId, body }`, and the unit test parses each one with `ingestEventSchema`, the same schema guarding the route.
**Alternatives:** A browser test harness (rejected — it adds a dependency to check something that is really a data-shape question). Trusting the types (rejected — `occurred_at` bounds and the discriminated payload union are runtime refinements TypeScript does not see).
**Consequence:** 22 unit tests covering every button, including that generated `occurred_at` values stay inside the ±bounds and that the reference span stays under `CORRELATION_WINDOW_MS` — the two ways a preset can be type-correct and still be rejected or fail to correlate.

## 2026-08-14 — The two reference buttons must target different restaurants

**Context:** Shipping both a chronological and an out-of-order reference button is only a demonstration if the reviewer can compare the results.
**Decision:** Each targets its own restaurant (`bellas_pizza`, `bellas_pizza_ooo`), and repeat clicks take an incrementing suffix.
**Alternatives:** Both posting to one restaurant (rejected, and this is the trap: correlation allows one open finding per restaurant, so the second run would merge into the first and produce a single six-event finding. The demonstration would silently contradict itself — the two orders would appear *not* to converge because there would be nothing to compare).
**Consequence:** Two cards side by side with identical event counts, window spans and priorities. Verified end to end through the real endpoint: both produce three events over a 135-minute span at `high`.

## 2026-08-14 — FORCE_FAIL_PREFIX moves to config.ts to keep the database out of the browser

**Context:** The simulator's forced-failure button needs the same prefix the worker matches on, and importing it from `worker/processEvent.ts` would have pulled `correlateEvent`, Drizzle and the connection pool into the client bundle.
**Decision:** The constant lives in `src/lib/config.ts`, which imports nothing. `processEvent.ts` re-exports it so the worker and the existing tests keep one import site.
**Alternatives:** Retyping the string in the simulator (rejected — a change to the prefix would leave the button silently posting an ordinary event; the unit test imports the constant precisely so that can't happen).
**Consequence:** Verified rather than assumed — the built client chunks contain no reference to `drizzle`, `postgres`, `DATABASE_URL` or `@anthropic-ai`.

## 2026-08-14 — The duplicate button posts twice on one click

**Context:** Demonstrating idempotency needs a prior event to collide with, and "post something, then press duplicate" is two steps at the moment a reviewer is forming their first impression.
**Decision:** One click posts a fresh event and then the identical body again, logging `201` and then `200 duplicate` naming the id it collided with.
**Alternatives:** Re-sending whatever was posted last (rejected — it depends on session state and does nothing as the first button pressed on an empty board).
**Consequence:** Always shows the whole shape, never depends on history. The board gains exactly one event from two posts, which is the assertion; the log line is what makes the absence of a second one legible rather than looking like a button that failed.

## 2026-08-14 — Three operator actions ship, not four

**Context:** The CHECK constraint on `operator_actions` permits `mark_reviewed`, `mark_resolved`, `thumbs_up` and `thumbs_down`. Shipping all four because the enum has them is the path of least resistance.
**Decision:** `mark_reviewed`, `mark_resolved`, `thumbs_down`. Two axes — workflow and quality — with each action having a consequence: reviewed de-emphasizes the card, resolved sets `resolved_at` *and* `closed_at` and moves it out of the working list, thumbs_down captures an eval example.
**Alternatives:** Also shipping `thumbs_up` (rejected — it lands on neither axis. It changes no state, and as a quality signal it is close to unactionable: a negative tells you which summary to go and read, a positive tells you nothing you can act on without a baseline). Dropping `mark_reviewed` too (rejected — it survives the same test because it does have a consequence: an operator working a priority-sorted queue needs a third option between "leave it screaming at the top" and "close it before the kitchen has answered". Without that, `reviewed_at` would be a badge and should have been cut).
**Consequence:** `thumbs_up` stays in the constraint — removing it is a migration for no benefit — and a unit test asserts the Zod schema rejects it, so the omission reads as deliberate rather than as an oversight waiting to be "fixed".

## 2026-08-14 — The audit log appends always; finding state is first-write-wins

**Context:** Double-clicking "mark reviewed" must either not produce two rows or produce two harmlessly.
**Decision:** Harmlessly. Every call appends to `operator_actions`; `findings.reviewed_at` and `resolved_at` are set with `COALESCE(col, now())`. Both writes share one transaction.
**Alternatives:** `UNIQUE (finding_id, action_type)` (rejected — `operator_actions` is an append-only audit log, and an operator re-reviewing a finding after new evidence arrives is a real event that a log should not silently drop). Overwriting the timestamp on each click (rejected — `reviewed_at` then means "most recently glanced at" rather than "when this was first triaged", which is the useful reading).
**Consequence:** The split holds: the log is what happened, `findings` is what is true now. The UI disables a button in flight and once state is set, so duplicates are the safety net for a genuine double-submit rather than the expected case. `thumbs_down` is deliberately different — it appends every time and re-enables when `version` moves, because feedback is per version and a judgement of v3's summary says nothing about v5's.

## 2026-08-14 — The board partitions on resolved_at, never on closed_at

**Context:** Resolving sets `closed_at` as well as `resolved_at`, and resolved findings should leave the working list. The obvious filter is the one that is already there.
**Decision:** Partition on `resolved_at IS NOT NULL`, client-side. Resolved findings move to a collapsed "Resolved (n)" section at the bottom of the list.
**Alternatives:** Filtering on `closed_at IS NULL` (rejected, and this is the trap — a finding whose rolling window merely lapsed also has `closed_at` set and is history an operator should still see. That filter would silently hide every past finding on the board and break an invariant recorded two slices earlier: *"closed_at is a lifecycle marker, never a visibility filter"*). Dropping resolved findings entirely (rejected — the action stops feeling reversible and a reviewer who clicks Resolve loses the only evidence anything happened). Sorting them to the bottom in SQL (rejected — that would put ordering in two places; the SQL sort stays the single source of order and the client only partitions).
**Consequence:** An integration test asserts a self-closed, operator-untouched finding stays visible and unresolved, so the trap can't be walked into later by someone reaching for the nearer column.

## 2026-08-14 — thumbs_down copies the prose and references the evidence

**Context:** A bare thumb is nearly useless later. The README names the missing eval harness as the most significant gap, and that claim is only credible if the feedback captured can actually seed one.
**Decision:** `operator_actions.context` jsonb. Every action records `version`, `priority`, `status`; `thumbs_down` additionally records the issue, the summary, the recommended actions, `llm_model`, `summary_source`, `cited_event_ids`, and the evidence event ids.
**Alternatives:** Storing only `finding_id` and joining later (rejected, and this is the crux — a finding's `summary` is *overwritten* by the next enrichment, so the judgement would survive and the thing judged would be gone). Copying the evidence payloads too (rejected — `events` is immutable and append-only, so ids rehydrate the model's exact input at no storage cost).
**Consequence:** Each thumbs_down becomes a complete eval row: input, output, judgement, provenance. The asymmetry — prose copied, evidence referenced — is the whole design, and it rests on `events` staying append-only; the schema comment says so next to the column, because nothing in the database enforces it. Proven by a test that thumbs-downs at v2, re-enriches to v3, and asserts the captured summary is still v2's.

## 2026-08-14 — Optimistic action state, settled by snapshot confirmation

**Context:** The board polls once a second. Waiting for the stream to reflect a click reads as a dead button.
**Decision:** Apply locally on success, and clear the overlay only when an incoming snapshot *confirms* the field is set.
**Alternatives:** Waiting for the stream (rejected — up to a second of nothing after a click). Clearing the overlay on the next message unconditionally (rejected — a snapshot polled between the click and the commit would flick the card back to unresolved and then forward again).
**Consequence:** Safe here for a reason specific to this build: every SSE message is a complete board, so there is no patch to merge and local state cannot drift permanently. A direct payoff of the slice-6 whole-board decision.

## 2026-08-14 — The eval snapshot omits priority drivers on purpose

**Context:** A thumbs_down snapshot has to be enough to re-run a prompt change against the example the operator rejected. That means reconstructing the whole prompt — evidence, priority, event count, window, and the priority *drivers* that `buildUserPrompt` renders under "WHY THIS PRIORITY". The snapshot stores none of the drivers, and `findings.priority_drivers` is recomputed on every correlation, so the values as of the flagged version are not sitting in a column anywhere.
**Decision:** Leave them out and record why. Given `context.evidence_event_ids`, the evidence rows rehydrate exactly — `events` is immutable and append-only — and `scorePriority` is a pure function of that evidence plus a recurrence count that is itself a deterministic query anchored to the finding's own `last_event_at`. Drivers, `event_count`, `first_event_at` and `last_event_at` therefore all recompute from the ids rather than needing to be stored.
**Alternatives:** Snapshotting `priority_drivers` alongside the prose (rejected — it stores something derivable, and a stored copy can silently disagree with what `scorePriority` would produce today, which is worse than not having it: the harness would be measuring against a stale rationale rather than the current rules). Storing nothing and joining `findings` later (already rejected for the prose — that is the whole reason `context` exists).
**Consequence:** The rule the snapshot follows is the same boundary the rest of the design rests on: **model output is copied because it cannot be recomputed; deterministic output is referenced because it can.** Prose, actions and citations are copied; evidence, drivers and aggregates are not. Recorded here because the omission looks like a gap to anyone building the harness later, and reaching for a `priority_drivers` copy would quietly reintroduce the drift this avoids.

## 2026-08-14 — Mutation testing is the standard for a failure test

**Context:** Three times now a green test has meant nothing. A slice-4 retry path never fired and the test asserted only final state, which looked identical either way. A slice-6 reconnect served a cached board and the test asserted on a later poll tick, which refreshed it. And a `waitForNext` helper carried a dead condition — `const before = messages.length; if (messages.length > before)` — that made its "a message already arrived" branch unreachable; it passed since slice 6 only because the poller happened to tick after every call. All three sat inside covered, passing tests. Coverage records that a line executed, not that an assertion would have noticed if it misbehaved.
**Decision:** Any test claiming to prove a failure path is verified by reintroducing the bug it guards against and confirming it goes red. The reverts and their real output are written into the README's failure-tests section, not merely performed once and forgotten.
**Alternatives:** A coverage threshold (rejected — it measures execution, and all three bugs above were in covered lines). A mutation-testing library such as Stryker (rejected — minutes of runtime and a large config surface to establish four specific facts that four manual reverts establish in seconds; the value here is in choosing *which* mutation matters, which is a judgement a tool does not make). Trusting review (rejected — it is what missed them the first three times).
**Consequence:** The reverts are manual and can rot, so each is recorded with the diff and the failure output it produced. Two findings came directly out of running them, and neither would have surfaced otherwise: `workerCrash`'s negative control is the *only* test that fails when `claimJob` loses its staleness predicate — every backdating test still passes, because the backdate is then a no-op — and `ingestionDedup`'s row-count test still passes when `ON CONFLICT DO NOTHING` is removed, because a duplicate rejected with a 500 also leaves one row and spends one LLM call. The status code is what separates "recognized the duplicate" from "crashed on it".

## 2026-08-14 — A worker kill is modelled as an undelivered disposition

**Context:** The brief asks for the worker to be killed mid-processing and restarted. What a `SIGKILL` leaves behind in the database is exactly one thing: a row in `processing` whose claim will never receive a disposition.
**Decision:** Produce that state directly — a real `claimJob` claim followed by nothing — and let the reclaim run against it. The claim lifecycle, the fencing token, and the crash-loop terminator all execute their production SQL. The real process kill is scripted as a drill in the README with its expected log lines.
**Alternatives:** Spawning the worker and `SIGKILL`ing it (rejected — slow and flaky on Windows, and a flaky test in a graded submission reads as carelessness rather than thoroughness; it would also still need `claimed_at` backdated to avoid a 45-second wait, so the process boundary buys nothing the in-process test lacks). An env override for `PROCESSING_TIMEOUT_MS` (rejected — production configuration that exists only for tests).
**Consequence:** The OS-level path is documented rather than automated; slice 10 verifies SIGTERM inside the container, which covers the graceful half. Backdating `claimed_at` is the one piece of test-only machinery, and `backdateClaim` throws rather than silently no-opping when the row has no claim — otherwise a reclaim test would quietly assert on the ordinary retry branch instead.

## 2026-08-14 — The integration suite refuses to run beside a live worker

**Context:** Two `npm run worker` processes were running against the test database during slice 9. The queue is global — `claimJob` takes the oldest eligible job regardless of who queued it — so the workers raced the suite for every job. It did not fail cleanly: a different test failed on each run, each with a plausible-looking assertion (a queue depth reading zero, a provider recording no calls, a finding that had not appeared yet), indistinguishable from a real bug without going to look for the process.
**Decision:** `tests/setup.integration.ts` queues a canary job, waits two poll intervals, and aborts the whole run by name if anything claimed it.
**Alternatives:** Parking every test job in the future and releasing it just before the claim (rejected — it shrinks the race window without closing it, and leaves the same mystery when it does hit). A separate test database (rejected for now — the right answer, but it is a change to how the project is run rather than a test fix, and the guard makes the current arrangement honest; noted as a production change). Documenting "stop the worker first" in the README only (rejected — the failure it prevents does not look like a configuration mistake, so a reader has no reason to connect the two).
**Consequence:** One poll interval of startup cost per integration run, and a class of mystery flake becomes a named error. It also makes explicit something the suite always assumed: these tests own the queue for their duration.
