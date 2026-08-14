# Sauce Ops Copilot

Real-time restaurant operations copilot: ingests operational events, correlates them
into findings, and surfaces AI-generated summaries and recommended actions on a live
dashboard.

> **Note to self — delete this block before submitting.**
> Each section below is tagged `<!-- OWNER: agent | slice: N -->` or
> `<!-- OWNER: design-chat -->`. The agent fills its sections during the slice-done ritual.
> Human-owned sections are judgment calls and must be written by me, in my own voice.
> A section still containing `_TODO_` at submission time is a bug.

---

## Quick start
<!-- OWNER: agent | slice: 10 (docker) -->

_TODO_

```bash
# target: one command, no manual configuration
docker compose up
```

Then open http://localhost:3000

**Without an API key:** the system runs end-to-end using the deterministic fallback
LLM provider. **With a key:** set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic`
in `.env` for real model-generated summaries.

---

## What this does
<!-- OWNER: agent | slice: 6 (once the UI exists and the loop is visible) -->

_TODO_ — 2–3 sentences. What an operator sees and what problem it solves.

---

## Architecture

### Components
<!-- OWNER: agent | slice: 6 -->

_TODO_ — API responsibilities, database responsibilities, queue responsibilities,
worker responsibilities, frontend architecture, AI-provider boundary, realtime
mechanism.

### Data flow
<!-- OWNER: agent | slice: 6 -->

_TODO_ — Mermaid diagram: UI submission → ingestion API → outbox → queue → worker →
correlation → LLM → persisted finding → SSE → dashboard.

### Deterministic vs. LLM boundary
<!-- OWNER: agent | slice: 5 (LLM integration) -->

Every field on a finding, and who writes it:

| Field | Written by | Notes |
|---|---|---|
| `restaurant_id`, `order_id` | code | `order_id` is display-only; never part of matching |
| `version` | code (correlation) | Bumped on every evidence change. Enrichment reads it as a fence and never writes it |
| `priority` | code (`correlation/priority.ts`) | Threshold table, max across signals. The model is told the priority and forbidden to restate or guess one |
| `event_count`, `first_event_at`, `last_event_at` | code | Recomputed from the evidence set, never incremented |
| `finding_events` (the evidence) | code | Assembled from the database. Never from model output |
| `closed_at` | code (correlation) | Rolling-window lifecycle marker |
| `status` | code | `accepted` → `processing` → `ready` \| `failed` |
| `issue` | **model** | Short noun phrase naming the pattern |
| `summary` | **model** | Two or three sentences for an operator |
| `recommended_actions` | **model**, from a fixed allowlist | Eight operator verbs; anything else is rejected |
| `extracted_tags` | **model**, from a fixed enum | Finer-grained read of free text than `issue_class`. Drives nothing |
| `cited_event_ids` | **model's choice, code's mapping** | The model cites opaque labels `E1..En`; code validates the set and maps it back to real ids |
| `summary_source`, `llm_model`, `enriched_at` | code | Provenance for the four fields above |

The model never decides what is true, only how it reads. Take the model away entirely and
a finding still has its evidence, its priority, the reason for that priority, and a
usable summary — the prose just gets flatter. That is the property the whole split exists
to buy, and it is what the two failure tests in `tests/integration/enrichment.test.ts`
assert.

One consequence worth stating plainly: `issue_class` is derived from structured fields
only (`event_type`, plus an explicit `category`/`reason`), never from free text. A
keyword classifier reading `complaint_text` would violate this boundary without going
anywhere near `src/lib/llm/`. That is why enrichment does its own evidence read rather
than widening correlation's — correlation's reader cannot see customer text at all.

---

## Key design decisions
<!-- OWNER: agent | source: docs/decisions.md, condensed -->

_These are distilled from `docs/decisions.md`. Each should be 3–5 sentences: the
constraint, the choice, the alternative rejected, the cost._

### Postgres as queue (no Redis)
<!-- slice: 3 -->
The queue is the `event_jobs` table, claimed with `SELECT ... FOR UPDATE SKIP
LOCKED` inside a single `UPDATE` that also increments `attempts` and sets the
status — so two workers can never hold the same job, and a claim can't be lost
between selecting and marking it. The brief warns against reaching for Redis to
satisfy a checkbox, and at this scale it would buy nothing: Postgres already
gives atomic claim semantics, and keeping the queue in the same database as the
business data means a job row and its event commit or fail together. Two things
this costs, honestly: throughput ceilings well below a real broker (fine here,
irrelevant at 100k events/sec), and polling latency instead of push delivery —
the loop sleeps 1s only when it finds nothing, so an idle queue costs one query
per second and a busy one costs nothing extra. If this ever outgrew Postgres,
`event_jobs` becomes the outbox and a relay ships rows to the real broker.

### Transactional outbox
<!-- slice: 2 -->
The `event_jobs` row is written in the same SQL statement as its `events` row — a
`WITH ... INSERT ... SELECT` CTE, not a separate outbox table with a relay. The
outbox pattern earns its keep bridging a database and a *separate* broker, where the
write and the publish can't share a transaction; here the queue is Postgres itself,
so they always can. This was originally scoped as outbox-plus-relay
(`docs/decisions.md`, 2026-08-13) and revised once `event_jobs` replaced it
(2026-08-14) — a relay between two tables in the same database would add a moving
part and a failure mode without adding any guarantee. The cost: this doesn't
directly generalize if a second, non-Postgres consumer of the same events shows up
later — if that happens, `event_jobs` becomes the actual outbox and a relay is added
at that seam.

### Idempotency and duplicate handling
<!-- slice: 2 -->
Ingestion idempotency is one constraint: `UNIQUE(restaurant_id, event_id)` on
`events`, scoped per restaurant rather than global, so two tenants can't collide on
the same client-supplied `event_id`. A duplicate `POST` resolves in a single
statement — `ON CONFLICT (restaurant_id, event_id) DO NOTHING` for the insert, with
a `UNION ALL` fallback that looks up the existing row's `id` with no write and no
lock when the insert didn't happen — so resubmitting the same event five times
produces exactly one `events` row, one `event_jobs` row, and zero additional writes
to either (verified directly against the running database, not just asserted). The
response is `{status: "accepted", duplicate: boolean, id}` in both the new and
duplicate cases, so a caller can tell "created" from "already existed" without a
second request. Worker-side idempotency — checking `event_jobs.status` before
processing a claimed row — is slice 3's job and isn't built yet.

### Correlation and finding lifecycle
<!-- slice: 4 -->
There is no correlation *key*. A finding is a live incident at a restaurant, and an
event joins it when it falls within three hours of the nearest edge of that finding's
existing evidence:

```sql
occurred_at BETWEEN first_event_at - INTERVAL '3 hours'
                AND last_event_at  + INTERVAL '3 hours'
```

Attaching extends the window in whichever direction is needed (`LEAST`/`GREATEST`),
which buys a property worth stating: consecutive evidence within one finding is never
more than three hours apart, since an attach either lands inside the existing interval
or extends one edge by at most the window. A static key — `order_id`, or
restaurant + issue class + time bucket — fails the brief's own worked example, which
is a *mixed-type* incident spanning 2h15m; both `issue_class` in the key and any fixed
bucket boundary split it. That's why `findings` has no `issue_class` column at all.

An out-of-window event is two different situations, not one. If it's **after** the
window, time genuinely moved on: close the stale finding, open a replacement, both in
one transaction. If it's **before** the window it's a backfill, and closing is driven
by elapsed time since a finding's own last event — never by an unrelated old event
arriving — so the live finding is left untouched and the backfill gets its own finding,
created already closed. Without that split, a week-old replayed webhook would close the
current incident and strand later evidence that should have joined it.

`closed_at` (correlation-owned, set when a window lapses) is deliberately separate from
`resolved_at` (operator-owned). It is a **lifecycle marker, not a visibility filter**:
closed findings are still enriched and still appear on the dashboard as historical.
A backfilled incident is a real problem someone should see.

Priority is deterministic and lives in one table, `src/lib/correlation/priority.ts`:

| signal | medium | high | critical |
|---|---|---|---|
| `delay_minutes` (max across evidence) | 20 | 45 | 90 |
| event count | 2 | 4 | 6 |
| review `rating` (min across evidence) | ≤3 | ≤2 | — |
| recurrence, same `issue_class` in 24h | 2 | 3 | 5 |

The result is the **max** across signals, never a sum — which is what lets recurrence
and event count overlap without compounding: three events of one issue class is a
pattern and outranks three of mixed classes. Scoring also returns *drivers* (which
signals fired, and why), so "why is this high" is answered by code; slice 5 hands that
to the model as a given rather than letting it invent a rationale. The thresholds are
demo-appropriate placeholders, not tuned against real incident data.

Verified end to end against the brief's scenario — `delivery_delay` 17:55,
`complaint` 18:12, `negative_review` 20:10 — posted out of order through the real API
and drained by the real worker: one finding, three evidence rows, `first_event_at`
17:55, `last_event_at` 20:10, priority `high`. All six arrival permutations converge on
the same result.

### LLM failure handling and degraded findings
<!-- slice: 5 -->

**An LLM failure is never a job failure.** Timeouts, refusals, 5xx, malformed JSON, and
schema violations are all caught inside the enrichment step, which then falls through to
a deterministic writer. The finding still reaches `ready`; `summary_source` says
`fallback` and the summary says so in words, so a thin summary reads as "the model was
unavailable" rather than "there was little to say."

Each call is bounded by `LLM_TIMEOUT_MS` (15s) and `MAX_LLM_ATTEMPTS` (2). Only a
*rejected response* is worth regenerating — a transport error or a refusal would return
the same answer, so those are not retried. The regeneration carries the rejection reason
back to the model.

The SDK client is constructed with **`maxRetries: 0`**, which is load-bearing rather than
a preference. The SDK retries twice by default, so leaving it alone would make the real
worst case six HTTP calls against a `PROCESSING_TIMEOUT_MS` derived in `config.ts` from
two — and a slow-but-alive worker would have its job reclaimed mid-flight and burn a
retry it never earned. A unit test asserts the constructor argument, because that is the
kind of thing a refactor silently reverts.

Enrichment runs outside correlation's transaction and holds no lock, so a slow model call
can be overtaken by new evidence. Both of its writes are fenced on `findings.version`
(`WHERE id = $1 AND version = $2`); the loser logs `enrichment.superseded` and discards
rather than overwriting fresher prose with a summary of a smaller evidence set.
Enrichment never bumps `version` itself — that is what makes it usable as a fence.

**Reaching `failed`.** Because outages degrade instead of failing, a job essentially
never fails in normal operation, which would leave the failure branch of the status
machine unreachable by anyone demoing the product. `findings.status = 'failed'` is
written in exactly one place — when a job dead-letters after its correlation committed —
and there is a documented trigger to reach it: with `ENABLE_DEMO_FAILURE_TRIGGER=true`
(set in `.env.example`), an event whose `event_id` starts with `force_fail_` throws
*after* correlation commits. The finding is real, the job walks the real 1s/2s/4s/8s
ladder into the DLQ, and the finding flips to `failed` with its evidence and priority
intact and only its prose missing. It takes ~15s of real backoff — the honest cost of not
faking the state. Slice 7 puts a button on it.

### Prompt injection defense
<!-- slice: 5 -->

Customer-authored text (`complaint_text`, `review_text`) is the only untrusted input in
the system, and both are unbounded strings. The defense is in three layers, each tested
separately against one shared hostile fixture that carries an instruction override, a
demand for an out-of-allowlist action, a forged closing fence token, and a fabricated
citation label:

1. **Prompt containment.** The text is fenced in `<customer_text>` and labelled as data
   describing a complaint, never instructions. Fence tokens inside the payload are
   neutralized case- and whitespace-insensitively (`< / CUSTOMER_TEXT >` is the same
   attack) and *before* truncation, so a token straddling the cut cannot survive as an
   unmatched fragment. No event id or finding id ever enters the prompt — only opaque
   labels.
2. **Validator containment.** Everything coming back is validated against a Zod schema
   with `additionalProperties: false`, a closed action allowlist, a closed tag enum, and a
   citation check. This layer is tested by feeding it responses in which the model *did*
   obey — every one must be rejected.
3. **End to end.** The hostile event goes through the real pipeline and the shape of what
   lands in the database is asserted unchanged: priority still equals what `scorePriority`
   computed, actions still inside the allowlist, citations still a subset of the finding's
   own evidence, no extra findings or operator actions created.

The framing that matters: **"the model didn't obey" and "obedience is survivable" are
different claims,** and only the second can be guaranteed deterministically. Layer 2
exists because of that. A fourth check runs the real model against the same payload and
is skipped without an API key — evidence about the model's behavior, not a guarantee.

**What the live layer actually caught.** On the first real run against
`claude-sonnet-5`, the model refused the injected instruction correctly — and then wrote
this into the operator-facing summary:

> "Any embedded instructions in the customer's text were disregarded as they are not
> legitimate commands."

The defense worked. **Disclosing it was the bug.** It leaks an implementation detail into
what is supposed to be a customer-service artifact, and it tells an attacker their probe
was seen and classified — useful reconnaissance for anyone iterating on payloads. The fix
was a system-prompt rule not to mention prompt handling at all, re-verified against the
live model.

This is the case for the live layer existing. Layers 1–3 all passed on this response, and
correctly so: the injected text stayed fenced, the output validated cleanly, and the
database shape was unchanged. A correctly-refused injection that is then *narrated*
violates none of those invariants — there is no deterministic assertion that would have
caught it, because nothing about it is malformed. The general lesson is worth stating
plainly: **a correct security decision can still be a disclosure bug**, and that class of
failure only surfaces when a real model actually writes the words.

Two smaller decisions. A citation outside the issued set is a rejection of the whole
response, not a field to drop: stripping the bad label would leave the sentence it
supported standing with nothing underneath, which is the unsupported conclusion the rule
exists to prevent. And sanitizing happens at the prompt boundary, not on ingestion —
`events` is immutable and an operator should see exactly what the customer wrote.

### Model selection
<!-- slice: 5 -->

**`claude-sonnet-5`**, at `effort: "low"`.

The choice follows from the boundary rather than from benchmarks. By the time the model
runs, code has already decided which events belong together, how severe the finding is,
why it is severe, and what evidence backs it. What is left is two or three sentences of
narration and a pick from an eight-item allowlist, using facts handed over as givens.
**Narration does not need a frontier model** — and reaching for an Opus-tier model at
roughly 5× the token cost would contradict the cost-discipline argument this README makes
about traffic spikes.

Output is constrained with structured outputs (`output_config.format`) rather than a tool
definition — this is not a function call — and the JSON Schema is generated from the same
Zod object that validates the response on the way back, so there is one definition rather
than two that drift.

If summary quality turns out to be the weak point, the model id is a one-line change and
the provider interface absorbs it. The claim is not that Sonnet is sufficient for
everything; it is that this task was made small enough that it doesn't need more.

---

## Architectural conditions

_Answers to the five scenarios in the brief, in the brief's own order._

### Duplicate delivery
<!-- OWNER: agent | slice: 2 -->
Duplicates are detected at ingestion by a single unique constraint
(`UNIQUE(restaurant_id, event_id)` on `events`) — a resubmitted event never creates
a second `events` or `event_jobs` row. Verified directly: five resubmissions of the
same event produce one row of each, and the API returns `{status: "accepted",
duplicate: true, id: <the original row's id>}` on every resubmission after the
first. Duplicate findings can't arise from this path either, since a duplicate event
never reaches `event_jobs` at all — there's nothing left for a worker or correlation
step to double-process. Two parts of this answer aren't built yet, and are out of
scope until their slices land: worker-side redelivery safety (checking
`event_jobs.status` before processing a claimed row — slice 3) and what the UI shows
(slice 6/7) — though the `duplicate` boolean and `id` are already in the response,
ready for the UI to consume once it exists.

### Out-of-order events
<!-- OWNER: agent | slice: 4 -->
The match predicate is bidirectional, so an event that arrives late but *happened*
earlier still joins its finding and pulls `first_event_at` backwards. This is the case
a one-sided predicate (`last_event_at >= occurred_at - 3h`) silently gets wrong: that
form has no lower bound at all, so a six-day-old backfill would match the live finding
and then drag its window six days back, after which it would swallow everything at that
restaurant.

Findings are **updated, never regenerated**. New evidence attaches, the denormalized
fields are recomputed from the evidence set, and `version` increments — which is what
slice 6's SSE will key on to push an update. Recomputing rather than incrementing means
the aggregates converge after a partially applied or retried run instead of drifting
permanently once wrong.

The three-hour window *is* the aggregation window; there is no separate debounce. An
event arriving hours after its siblings still joins them if it falls inside it.

Worked example, arriving in the worst order — review (20:10) first, then the delay
(17:55), then the complaint (18:12): the review creates the finding; the delay is
2h15m *earlier* but within the window, so it attaches and `first_event_at` moves back
to 17:55; the complaint lands inside the interval and attaches. One finding, three
evidence rows. Verified through the real API and worker, not just in tests.

Honest limitation: two backfills minutes apart, arriving while a live finding is open,
each get their own closed finding rather than correlating with each other. The brief's
out-of-order case is events minutes apart, not week-old replays, so this is documented
rather than fixed.

### Partial failure
<!-- OWNER: agent | slice: 3 -->
**Save-then-crash** can't happen: the event row and its `event_jobs` row are
written by one SQL statement (see "Transactional outbox" above), so there is no
instant where an event exists without queued work waiting on it.

**Process-then-crash-before-ack** is the real case. A worker claims a job,
commits that claim immediately, and then does its work — it deliberately does
*not* hold the row lock while processing, because slice 5's LLM call must not
pin a database connection for its duration. So a worker that dies mid-job leaves
the row in `processing` with nothing holding it. The claim query's second
eligibility branch handles this: a job whose `claimed_at` is older than
`PROCESSING_TIMEOUT_MS` (45s, derived from the LLM timeout budget so a slow-but-
alive call can't be stolen) is reclaimable by any worker. Every claim increments
`attempts`, including reclaims, so a job that crash-loops burns its retry budget
rather than being retried forever; once the budget is spent, the claim statement
itself routes it to `dead_letter` — with an explicit `last_error` recording why,
since a crash-looped job never reaches the normal failure handler that would
otherwise write one.

**Duplicate processing** is prevented on both sides of that window. `SKIP LOCKED`
means two workers can never claim the same row concurrently. And a worker that
was stale-reclaimed while still running can't clobber the new claimant: each
claim mints a fresh `claim_token`, and the disposition write only applies if the
token still matches, so a superseded worker updates zero rows and logs
`job.disposition_superseded`. Verified with two workers against twelve events —
all twelve finished with `attempts = 1`, meaning no job was ever claimed twice.

**Duplicate findings** aren't reachable from this path yet: correlation lands in
slice 4, and `finding_events` already carries a `UNIQUE(event_id)` constraint so
one event can only ever evidence one finding. **Inconsistent UI state** is out of
scope until slice 6 — nothing reads job status from the UI yet, so the worker's
only observable effect today is the row transition and its log lines.

### Traffic spike (100,000 events in 10 minutes)
What absorbs the burst. Ingestion writes the event and its job row in a single statement and returns as soon as that commits — no LLM call, no correlation, nothing on the request path that can slow down under load. A spike therefore shows up as queue depth in event_jobs, not as API latency or dropped events. The API degrades by getting behind, not by getting slow, which is the failure mode you want.

How workers scale. The worker is a separate process from the Next.js app, so the two scale independently — a burst needs more workers, not more API capacity. Claiming uses SELECT ... FOR UPDATE SKIP LOCKED, so running N workers requires no code change and no coordination: each claim either wins a row or skips to the next. I verified this with two concurrent workers against twelve queued events — all twelve processed exactly once, split 7/5 across the workers, no job claimed twice. The loop also re-polls immediately after a successful claim and sleeps only when it finds an empty queue, so the poll interval is the cost of idling rather than a per-job tax; under load, throughput is bounded by processing time.

What isn't built. Three of the mechanisms this scenario really needs are absent, and I'd rather name them than imply the system handles more than it does.

There is no backpressure. Ingestion accepts events at whatever rate they arrive and the queue grows without limit. The first thing I'd add is a queue-depth ceiling per tenant — past a threshold, return 429 with Retry-After so producers slow down instead of the backlog silently growing into hours of lag. A second, gentler option is shedding by event type: a negative_review can wait; a delivery_delay during service can't.

There is no global spend control. MAX_LLM_ATTEMPTS bounds retries per job, so a single event can't loop expensively, but nothing caps aggregate cost — 100,000 events would mean as many enrichment calls as they correlate into findings, at whatever rate the workers can issue them. Production needs a concurrency semaphore around the provider (a fixed number of in-flight calls, independent of worker count) and a per-tenant daily budget that degrades to the deterministic fallback provider rather than failing when exhausted. The fallback path already exists for outages, which means the graceful-degradation behavior for a budget cap is already built — it just isn't wired to a budget.

There is no tenant isolation. Claiming is FIFO by next_attempt_at across all tenants, so one restaurant chain sending 100,000 events starves every other restaurant behind it in the queue. The schema is multi-tenant (tenant-scoped idempotency keys, per-restaurant correlation) but the queue is not. The fix I'd reach for first is claiming round-robin across distinct restaurant_id values rather than strictly oldest-first — a fairness quota rather than a separate queue per tenant, which would be a lot of machinery for the same outcome.

What the operator sees while behind. Findings are created deterministically at correlation time and enriched afterward, so a finding appears on the dashboard — correctly prioritized, with its evidence attached — before the model has written anything about it. Under lag the operator sees a real, growing list of processing findings rather than an empty screen, and the summaries fill in as the workers catch up. Processing delay is visible as a state, not as an absence.

### Concurrent processing
<!-- OWNER: agent | slice: 4 -->
Two workers correlating events for the same restaurant collide in two structurally
different ways, and one mechanism doesn't cover both.

**Updating an existing finding** is serialized by `SELECT ... FOR UPDATE` on the open
finding row. The second worker blocks until the first commits, then proceeds against
fresh state — so no `version` bump or `event_count` update is lost.

**Creating a finding** can't be serialized that way: when there is no open finding the
`FOR UPDATE` locks nothing, both workers take the create path, and
`UNIQUE (restaurant_id) WHERE closed_at IS NULL` arbitrates. Exactly one insert
survives. The loser catches the violation by **SQLSTATE `23505` plus the constraint
name** — never by matching the error message, which is a driver formatting detail that
would silently start passing or failing on a version bump — and retries **exactly
once**, in a fresh transaction. A `23505` aborts the current transaction, so the retry
can't be a continuation; and a second failure means an assumption is wrong rather than
that the database is busy, so it goes to the DLQ instead of spinning.

The error shape was verified against a real violation before the matching code was
written: `DrizzleQueryError` wrapping `PostgresError` one level down, carrying
`code: "23505"` and `constraint_name` (snake_case), identical inside and outside a
transaction, with a foreign-key violation correctly distinguishable as `23503`.

An advisory lock would have removed the create race in one line, and was rejected:
advisory locks are advisory, so any future insert path that forgot to take one would
silently break the one-open-finding invariant. The index cannot be bypassed.

Lock ordering is uniform across workers — findings row, then `finding_events` insert,
then findings update — so there is no deadlock cycle.

Worth noting how this was tested, because the first version of the concurrency tests
passed without ever exercising the race: the transactions simply serialized. The test
that covers it now forces the collision deterministically, by holding a competing
transaction open across the correlation attempt, and asserts that the retry path
actually ran rather than only checking the final state — which would look identical
either way.

### Redis and temporary state
<!-- OWNER: design-chat -->
_TODO_ — we don't use Redis. State the question they asked and answer it: nothing
breaks, nothing is lost, because no permanent business data lives outside Postgres.

---

## Operator feedback loop
<!-- OWNER: design-chat -->

_TODO_ — what the persisted operator action is, and how this feedback improves the
product/model over time (eval set from thumbs-down, prompt iteration, threshold
tuning, precision measurement). Explicitly requested by the brief.

---

## Failure tests
<!-- OWNER: agent | slice: 9 -->

_TODO_ — list each test, what it proves, and how to run it.

---

## Known limitations
<!-- OWNER: design-chat -->

These are deliberate scope decisions, not oversights. Each one is a place where I chose the simpler option and know what it costs.

**Correlation is coarse.** A finding groups everything happening at a restaurant within a rolling 3-hour window of the last event. Two genuinely unrelated problems in the same window — a delivery delay and a food quality complaint about a different order — merge into one card. I chose this because the brief's own reference scenario is a mixed-type incident (delay + complaint + review) spanning ~2h15m, and any key that splits by issue type or uses a fixed time bucket fails to reproduce it. A finding here means "something is wrong at this restaurant right now," which is the shape an operator actually acts on. The cost is occasional over-merging.

**The window is a constant.** Three hours is hardcoded, not tuned per restaurant. A high-volume location during dinner rush and a quiet one at 3pm get the same window, which is wrong in both directions. Tuning this needs volume data I don't have.

**Correlation can't see what a complaint is about.** Grouping uses `restaurant_id` and time only. LLM-extracted tags like `missing_items` are shown on the card for context but are deliberately never read by correlation code, because model output must not silently decide which events belong together. The natural next step is a hybrid — rules first, with the model proposing merges for leftovers as a suggestion an operator confirms, never as a silent write.
<!-- slice 6: verify true once dashboard exists -->

**Backfilled events don't correlate with each other.** An event arriving more than 3 hours before an open finding's window gets its own finding, created already closed, so a live incident isn't hijacked by week-old data. The cost is that two backfills minutes apart become two separate findings, since the lookup only sees open ones. The brief's out-of-order case is events minutes apart, which works correctly; this only affects genuine historical replay.

**`negative_review` has no structured root cause.** `issue_class` is derived from structured fields only. Complaints and refunds can carry a `category`/`reason` that folds into a real root-cause class (a refund for lateness classes as `delivery_delay`, not `refund`), but reviews arrive with only a rating and free text, so they always class as `negative_review`. Extending this means adding a structured field to the review payload, not inferring one from the text.

**Multi-worker is safe but unproven at scale.** Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`, and I verified two concurrent workers against twelve events with no job processed twice, plus a forced insert-race on the correlation path. What I haven't done is run this under real load — and the polling interval still sets a floor on end-to-end latency that a broker with push delivery wouldn't have.

**No authentication, no tenant isolation.** Any caller can post events for any `restaurant_id`, and the dashboard shows every restaurant's findings. The brief excludes auth, so this is expected, but it means the multi-tenancy in the schema (tenant-scoped idempotency keys, per-restaurant correlation) is structural rather than enforced.
<!-- slice 6: verify true once dashboard exists -->

**No per-tenant rate limiting or LLM spend control.** A single restaurant flooding events would consume worker capacity and LLM budget other tenants need. The queue absorbs the burst safely — the API stays responsive and nothing is lost — but processing is FIFO across all tenants with no fairness guarantee.

**A demo affordance ships in the code.** An `event_id` prefixed `force_fail_` deliberately throws after correlation commits, so the `failed` state can be demonstrated end-to-end rather than only unit-tested. It's gated behind `ENABLE_DEMO_FAILURE_TRIGGER` and documented — but it is a hook that wouldn't exist in production.

**No eval harness.** LLM output quality is unmeasured. I have no golden set, no regression check on prompt changes, and no way to tell whether a prompt edit made summaries better or worse. For a product whose value is the quality of its recommendations, this is the most significant gap — see "What I would do with one more day."

---

## Product and entrepreneurial judgment
<!-- OWNER: design-chat -->

_The eleven questions from the brief. Answer each in 2–4 sentences._

- **Who is the primary user?** _TODO_
- **What decision does the dashboard help them make?** _TODO_
- **What assumptions did you make?** _TODO_
- **What did you intentionally leave out?** _TODO_
- **What is the smallest version worth releasing?** _TODO_
- **What is the first product metric you would track?** _TODO_
- **What is the largest product risk?** _TODO_
- **What would you validate with five restaurant operators?** _TODO_
- **What would make you stop investing in the product?** _TODO_
- **What would you build next if adoption were strong?** _TODO_
- **What did you change or improve beyond the literal assignment?** _TODO_

---

## What I would do with one more day
<!-- OWNER: design-chat -->

_TODO_ — specific and prioritized, not a wish list. Eval harness on a golden set of
event bundles is the strongest candidate.

---

## What I would change before production
<!-- OWNER: design-chat -->

_TODO_ — real broker or partitioned queue, per-tenant rate limits and spend caps,
auth and tenant isolation, observability, LLM cost controls, reconciliation job.

---

## AI tool usage disclosure
<!-- OWNER: design-chat, with agent supplying the factual record -->

_TODO_ — which tools, what they did, what I decided, how I verified their output.
Reference `CLAUDE.md` and `.claude/commands/` as evidence of deliberate setup, and
the git history for the working record.
