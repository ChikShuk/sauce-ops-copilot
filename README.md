# Sauce Ops Copilot

Real-time restaurant operations copilot: ingests operational events, correlates them
into findings, and surfaces AI-generated summaries and recommended actions on a live
dashboard.

> **Note to self — delete this block before submitting.**
> Each section below is tagged `<!-- OWNER: agent | slice: N -->` or
> `<!-- OWNER: human -->`. The agent fills its sections during the slice-done ritual.
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

_TODO_ — Table of which finding fields are computed by code and which are generated
by the model. Explicitly required by the brief.

---

## Key design decisions
<!-- OWNER: agent | source: docs/decisions.md, condensed -->

_These are distilled from `docs/decisions.md`. Each should be 3–5 sentences: the
constraint, the choice, the alternative rejected, the cost._

### Postgres as queue (no Redis)
<!-- slice: 3 --> _TODO_

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
<!-- slice: 4 --> _TODO_

### LLM failure handling and degraded findings
<!-- slice: 5 --> _TODO_

### Prompt injection defense
<!-- slice: 5 --> _TODO_

### Model selection
<!-- slice: 5 --> _TODO_

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
_TODO_ — correlation strategy, update vs. regenerate, how later evidence modifies an
existing finding, aggregation/debounce window, how the dashboard reflects updates.

### Partial failure
<!-- OWNER: agent | slice: 3 -->
_TODO_ — save-then-crash, and process-then-crash-before-ack. How lost events,
duplicate processing, duplicate findings, and inconsistent UI state are avoided.

### Traffic spike (100,000 events in 10 minutes)
<!-- OWNER: human -->
_TODO_ — queue absorption, worker scaling independent of API, backpressure, LLM
concurrency and spend control, tenant isolation, UI responsiveness under lag.
Mostly a reasoning answer, not implemented — say so plainly.

### Concurrent processing
<!-- OWNER: agent | slice: 4 -->
_TODO_ — how conflicting updates to the same finding are prevented.

### Redis and temporary state
<!-- OWNER: human -->
_TODO_ — we don't use Redis. State the question they asked and answer it: nothing
breaks, nothing is lost, because no permanent business data lives outside Postgres.

---

## Operator feedback loop
<!-- OWNER: human -->

_TODO_ — what the persisted operator action is, and how this feedback improves the
product/model over time (eval set from thumbs-down, prompt iteration, threshold
tuning, precision measurement). Explicitly requested by the brief.

---

## Failure tests
<!-- OWNER: agent | slice: 9 -->

_TODO_ — list each test, what it proves, and how to run it.

---

## Known limitations
<!-- OWNER: human -->

_TODO_ — honest list. Correlation is rule-based and misses fuzzy links; single-node
worker; no auth; no tenant isolation; polling interval; no eval harness; etc.

---

## Product and entrepreneurial judgment
<!-- OWNER: human -->

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
<!-- OWNER: human -->

_TODO_ — specific and prioritized, not a wish list. Eval harness on a golden set of
event bundles is the strongest candidate.

---

## What I would change before production
<!-- OWNER: human -->

_TODO_ — real broker or partitioned queue, per-tenant rate limits and spend caps,
auth and tenant isolation, observability, LLM cost controls, reconciliation job.

---

## AI tool usage disclosure
<!-- OWNER: human, with agent supplying the factual record -->

_TODO_ — which tools, what they did, what I decided, how I verified their output.
Reference `CLAUDE.md` and `.claude/commands/` as evidence of deliberate setup, and
the git history for the working record.
