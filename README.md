# Sauce Ops Copilot

Real-time restaurant operations copilot: ingests operational events, correlates them
into findings, and surfaces AI-generated summaries and recommended actions on a live
dashboard. `docker compose up` runs the whole thing — app, worker and Postgres — with
no file to create and no API key.

The line the design turns on is which half decides what. Deterministic code groups the
events, scores the priority, and assembles the evidence; the model only writes prose over
facts that are already settled. Take the model away entirely — which is the default, and
what you get without a key — and findings are still correlated, still prioritized, still
evidenced, and still live on the board. Only the wording gets flatter. Almost everything
else here, especially how failures degrade, follows from that split.

## Contents

- [Quick start](#quick-start)
- [What this does](#what-this-does)
- [Architecture](#architecture) — [Components](#components) · [Data flow](#data-flow) · [Deterministic vs. LLM boundary](#deterministic-vs-llm-boundary)
- [Key design decisions](#key-design-decisions)
- [Architectural conditions](#architectural-conditions)
  - [Duplicate delivery](#duplicate-delivery)
  - [Out-of-order events](#out-of-order-events)
  - [Partial failure](#partial-failure)
  - [Traffic spike](#traffic-spike-100000-events-in-10-minutes)
  - [Concurrent processing](#concurrent-processing)
  - [Redis and temporary state](#redis-and-temporary-state)
- [Operator feedback loop](#operator-feedback-loop)
- [Failure tests](#failure-tests)
- [Known limitations](#known-limitations)
- [Product and entrepreneurial judgment](#product-and-entrepreneurial-judgment)
- [What I would do with one more day](#what-i-would-do-with-one-more-day)
- [What I would change before production](#what-i-would-change-before-production)
- [AI tool usage disclosure](#ai-tool-usage-disclosure)

---

## Quick start
<!-- OWNER: agent | slice: 10 (docker) -->

```bash
docker compose up
```

Then open http://localhost:3000. That is the whole setup: no file to create, no
migration step, no API key. Three services come up — Postgres, the Next app, and the
worker — plus a one-shot `migrate` container that runs to completion before either
process starts, so a first run cannot meet an empty schema.

**Without an API key:** the system runs end-to-end on the deterministic fallback writer.
Findings are still correlated, prioritized, evidenced and shown live; only the prose is
templated rather than model-written. Nothing is stubbed or skipped.

**With a key**, either form works and neither needs a file edit:

```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... docker compose up
# or: cp .env.example .env, add the key, then `docker compose up`
```

Compose reads `.env` from the project root for variable substitution, so a `.env`
carrying `LLM_PROVIDER=anthropic` is picked up by the containers even though the file
itself is never copied into the image (`.dockerignore` keeps it out, so no key is ever
baked into a layer). Worth knowing in both directions: on a machine that already has a
`.env`, the containers inherit that provider rather than defaulting to `fallback`.

**Switching between them without a restart:** the sidebar's **Model** control writes the
choice to Postgres, which both the web app and the worker read at the point of use, and
**Re-write summary** on an open finding regenerates its prose under the current choice —
same evidence, same priority, same drivers. Gated by `ENABLE_PROVIDER_TOGGLE` (on in
`.env.example`); `LLM_PROVIDER` remains the default when nothing has been chosen.

### Without Docker

Postgres is the only thing worth containerizing on its own; the rest runs on Node 24
(the version the lockfile is resolved against — npm 10 resolves the `esbuild` conflict
between `tsx` and `drizzle-kit` differently and `npm ci` refuses).

```bash
npm ci
cp .env.example .env          # DATABASE_URL already points at the compose db
docker compose up -d db
npm run db:migrate
npm run dev                   # http://localhost:3000
npm run worker                # in a second terminal — nothing processes without it
```

`npm run build && npm start` for the production build instead of `npm run dev`.

---

## What this does
<!-- OWNER: agent | slice: 6 (once the UI exists and the loop is visible) -->

A restaurant operator gets a stream of individual operational events — a late delivery, a
complaint, a refund, a one-star review — and no way to tell which of them are the same
problem. This system correlates them into **findings**, ranks each one by deterministic
threshold rules, attaches the evidence it was built from, and has a language model write
the summary and the recommended actions.

The dashboard is a live board of those findings, worst first. A collapsed card carries the
priority, the pattern name, and the deterministic reason for the ranking — "95 minute delay
· 2-star review · +1 more" — so the scan happens over facts the system knows to be true.
Clicking one opens the summary, the actions, and every event underneath it, with the
evidence the summary actually cites marked. Findings appear the moment they correlate and
fill in as the model catches up, so processing delay shows as a state rather than an empty
screen.

---

## Architecture

### Components
<!-- OWNER: agent | slice: 6 -->

**Ingestion API** (`POST /api/restaurants/:id/events`) validates with Zod, normalizes,
derives `issue_class` from structured fields, and writes the event and its job row in one
statement. Then it returns. No correlation, no model call, nothing on the request path that
can slow down under load — a spike shows up as queue depth, not as API latency.

**Postgres** is the durable store, the queue, and the outbox. `events` is immutable and
append-only. `event_jobs` is 1:1 with it and carries status, attempts, backoff and a claim
token. `findings` are living, versioned entities; `finding_events` is the evidence join and
the only source evidence is ever assembled from. There is no Redis and no broker, so the
"write the event, then publish it" gap does not exist to be crashed in.

**Queue** is `SELECT ... FOR UPDATE SKIP LOCKED` inside the claiming `UPDATE`, so two
workers can never hold one job. Claiming mints a fresh `claim_token` that the disposition
write replays, so a worker stale-reclaimed mid-flight updates zero rows instead of
clobbering its replacement.

There are two queues on that machinery. `event_jobs` is the product path, 1:1 with events.
`enrichment_jobs` carries operator-requested rewrites from the dashboard's **Re-write
summary** button, and exists as its own table because the two diverge on what a dead letter
*means* — see the ADR. The worker **always drains `event_jobs` first**: ingestion is the
product and a rewrite is a demo control, so a reviewer clicking the button during a burst
of traffic cannot delay the events themselves. It is the same fairness question the
traffic-spike section asks about one tenant degrading another, answered at the smallest
scale the system has.

**Worker** is a separate Node process. It claims a job, correlates the event, scores its
priority, then calls the model. Correlation and scoring are deterministic and committed
before the model is involved; an LLM outage degrades the prose and never fails the job.

**AI provider boundary** is `EnrichmentProvider` with two implementations — Anthropic and a
deterministic fallback — selected by `LLM_PROVIDER`. Every call has a timeout, a bounded
retry, schema validation, an action allowlist, and citation checking against the evidence
set. Any failure falls through to the fallback writer. Which fields the model owns and
which code owns is the table below.

**Realtime** is one server-sent-events endpoint (`GET /api/stream`) fed by a single
process-wide poller. The poller re-reads the board once a second and fans it out to every
connected browser in memory — one query per tick regardless of client count. Each message
is the whole ordered board plus the ids that changed.

**Frontend** is a Server Component that renders the current board for the first paint, and
one client component that subscribes to the stream and replaces its state on each message.
All the logic worth testing — which of the five card states a finding is in, how the
drivers line is truncated — lives in pure functions in `lib/findings/cardState.ts`, so the
components stay thin and no browser test harness is needed. A finding's detail — summary,
recommended actions, evidence, action history — is fetched on demand when its row is
expanded, and re-fetched when that finding's `version` or `status` moves.

### Data flow
<!-- OWNER: agent | slice: 6 -->

<!--
  The image is the diagram; the Mermaid source below it is the editable original.
  GitHub renders Mermaid client-side and does not always fire on first paint — the
  section can come up empty until you expand it — so the committed SVG is what
  guarantees the diagram is actually visible. Regenerate after editing the source:

    npx @mermaid-js/mermaid-cli -i <source>.mmd -o docs/architecture.svg \
      -c '{"securityLevel":"strict","htmlLabels":false,"flowchart":{"htmlLabels":false}}' \
      -b white

  htmlLabels MUST stay false: with it on, Mermaid emits <foreignObject> and an SVG
  referenced as an <img> renders the boxes with no text at all.
-->

![Data flow from event ingestion to dashboard render. An operator or simulator POSTs an event to the ingestion API, which validates, normalizes and derives issue_class, writes the event and its job row to Postgres in one statement, and returns immediately with a duplicate flag. A worker claims the job with SELECT FOR UPDATE SKIP LOCKED, runs correlation and priority rules — both deterministic, shown in green — and commits the finding with its evidence, priority and drivers before any model is involved. Enrichment then sends the evidence to Anthropic as opaque labels E1..En; the structured response is checked against the schema, the action allowlist and the citation set — shown in amber — and either writes the prose fenced on findings.version or falls through to the deterministic fallback writer, as does any timeout or outage. Exhausted retries dead-letter and mark the finding failed. A broadcaster polls Postgres once a second and pushes the whole board plus changed ids over SSE to the dashboard, where a reconnect is a fresh snapshot.](docs/architecture.svg)

<details>
<summary>Mermaid source for the diagram above</summary>

```mermaid
flowchart TD
    SIM["Operator / simulator"] -->|POST event| API["Ingestion API<br/>validate · normalize · derive issue_class"]

    API -->|"event + event_jobs, one statement"| DB[("Postgres")]
    API -->|"returns immediately, with duplicate flag"| SIM

    DB -->|"SELECT … FOR UPDATE SKIP LOCKED"| W["Worker process"]

    W --> CORR["Correlation<br/>deterministic"]
    CORR --> PRI["Priority rules<br/>deterministic"]
    PRI -->|"finding + evidence + priority<br/>+ drivers COMMITTED"| DB

    PRI --> ENR["Enrichment"]
    ENR -->|"evidence as opaque labels E1..En"| LLM["Anthropic<br/>claude-sonnet-5"]
    LLM -->|"structured output"| VAL{"Schema · allowlist ·<br/>citations valid?"}
    VAL -->|yes| WRITE["prose, actions, tags, citations<br/>fenced on findings.version"]
    VAL -->|"no — 1 regeneration, then give up"| FB["Deterministic fallback writer"]
    ENR -.->|"timeout / outage"| FB
    FB --> WRITE
    WRITE --> DB

    W -->|"retries exhausted"| DLQ["dead_letter<br/>finding marked failed"]
    DLQ --> DB

    DB -->|"1s poll, one per process"| BC["Broadcaster<br/>fingerprint diff"]
    BC -->|"SSE: whole board + changed ids"| UI["Dashboard"]
    UI -->|"reconnect = fresh snapshot"| BC

    classDef det fill:#0b3d2e,stroke:#10b981,color:#ecfdf5
    classDef model fill:#3b2f0b,stroke:#f59e0b,color:#fffbeb
    class CORR,PRI det
    class LLM,VAL model
```

</details>

Green is deterministic, amber is the model. The finding exists, is prioritized, and has its
evidence before the amber path is entered — and every route out of the amber path, success
or failure, ends at the same write.

### Deterministic vs. LLM boundary
<!-- OWNER: agent | slice: 5 (LLM integration) -->

Every field on a finding, and who writes it:

| Field | Written by | Notes |
|---|---|---|
| `restaurant_id`, `order_id` | code | `order_id` is display-only; never part of matching |
| `version` | code (correlation) | Bumped on every evidence change. Enrichment reads it as a fence and never writes it |
| `priority` | code (`correlation/priority.ts`) | Threshold table, max across signals. The model is told the priority and forbidden to restate or guess one |
| `priority_drivers` | code (`correlation/priority.ts`) | Which signals fired and why. Written in the same statement as `priority`, so the two cannot disagree. This is what the card's drivers line renders |
| `event_count`, `first_event_at`, `last_event_at` | code | Recomputed from the evidence set, never incremented |
| `finding_events` (the evidence) | code | Assembled from the database. Never from model output |
| `closed_at` | code (correlation) | Rolling-window lifecycle marker |
| `status` | code | `accepted` → `processing` → `ready` \| `failed` |
| `issue` | **model** | Short noun phrase naming the pattern |
| `summary` | **model** | Two or three sentences for an operator |
| `recommended_actions` | **model**, from a fixed allowlist | Eight operator verbs; anything else is rejected |
| `extracted_tags` | **model**, from a fixed enum | Finer-grained read of free text than `issue_class`. Drives nothing |
| `cited_event_ids` | **model's choice, code's mapping** | The model cites opaque labels `E1..En`; code validates the set and maps it back to real ids |
| `summary_source`, `llm_model`, `enriched_at` | code | Provenance for the five model-written fields above |
| `enriched_version` | code | Which `version` the prose describes. `enriched_version < version` means the summary has fallen behind the evidence |

The model never decides what is true, only how it reads. Take the model away entirely and
a finding still has its evidence, its priority, the reason for that priority, and a
usable summary — the prose just gets flatter. That is the property the whole split exists
to buy, and it is what the failure tests in `tests/integration/enrichment.test.ts`
assert — the provider being down, the model returning nonsense, and the call timing out
among them.

One consequence worth stating plainly: `issue_class` is derived from structured fields
only (`event_type`, plus an explicit `category`/`reason`), never from free text. A
keyword classifier reading `complaint_text` would violate this boundary without going
anywhere near `src/lib/llm/`. That is why enrichment does its own evidence read rather
than widening correlation's — correlation's reader cannot see customer text at all.

---

## Key design decisions
<!-- OWNER: agent | source: docs/decisions.md, condensed -->

### Postgres as queue (no Redis)
<!-- slice: 3 -->
The queue is the `event_jobs` table, claimed with `SELECT ... FOR UPDATE SKIP
LOCKED` inside a single `UPDATE` that also increments `attempts` and sets the
status — so two workers can never hold the same job, and a claim can't be lost
between selecting and marking it. The brief warns against reaching for Redis to
satisfy a checkbox, and at this scale it would buy nothing: Postgres already
gives atomic claim semantics, and keeping the queue in the same database as the
business data means a job row and its event commit or fail together. Two things
this costs, honestly: throughput ceilings well below a real broker (fine at the
brief's spike — 100,000 events in ten minutes is about 170 a second — and a real
limit some way above that), and polling latency instead of push delivery —
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
second request. Worker-side idempotency is the claim statement transitioning the row it
claims, plus correlation's own redelivery guard — a `SELECT` on `finding_events` before
any write, so a redelivered event leaves the finding byte-identical rather than bumping
its version. See "Partial failure" below.

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
faking the state. The simulator's *Force a failure* button posts one.

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
exists because of that.

**There is no fourth, automated layer, and this section used to claim there was.** Every
provider in the test suite is a stub — `@anthropic-ai/sdk` is `vi.mock`ed in the only
provider test, and nothing anywhere is gated on `ANTHROPIC_API_KEY`. The live checks
described below were run by hand, during slice 5 and again on 2026-08-16. That is worth
stating plainly rather than quietly correcting, because the gap is the point of the next
paragraph: `npm test` cannot see this class of regression by construction.

That last phrase is now literally true rather than merely descriptive: the integration
setup forces the fallback provider and deletes the API key, so no test can reach a live
model even by omission. It closes a real hole — one test *was* making live calls through a
missing stub — at the cost of making the absent automated layer permanent until someone
opts in with `ALLOW_LIVE_LLM=true`. See the testing section.

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

**And on 2026-08-16 it came back.** During an unrelated model-cost comparison, the same
payload produced: *"The embedded text attempted to override instructions and was
disregarded as it is not a legitimate operational instruction."* Sampling the real
simulator preset 18 times against `claude-sonnet-5` at `effort: "low"` put the rate at
**2 in 18**. The rule was still in the prompt, unedited since slice 5, and correctly
worded — the model simply declined to follow it on some samples. Restating the same
requirement a second time, on the `summary:` output-spec line rather than only inside the
injection bullet, measured **0 in 18**. Both statements are now in the prompt, because
both are what was measured; 0/18 against 2/18 is a weak result on a small sample and is
not claimed as more than that.

The honest conclusion is a boundary, not a fix. **Disclosure suppression is a prompt
instruction, so it is a mitigation and not a control.** Everything structural held on
every sample — the fence, the allowlist, the tag enum, the citation check, the database
shape — and those hold whatever the model decides. Non-disclosure holds because the model
usually cooperates, and "usually" is the entire difference between the two categories.
Anything that must never happen has to live in `parse.ts`, not in the prompt. A
deterministic version of this check is possible in principle (reject a summary matching a
prompt-handling vocabulary), and was deliberately not written: it is a keyword blocklist
on model prose, it would false-positive on legitimate summaries, and its failure mode —
rejecting the response and degrading to the fallback writer — costs an operator a real
narrative to suppress a leak that is embarrassing rather than dangerous.

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
**Narration does not need a frontier model** — and reaching for an Opus-tier model at two
and a half times the token cost would contradict the cost-discipline argument this README
makes about traffic spikes. That multiple is the measured one, not an estimate: see the
table below.

Output is constrained with structured outputs (`output_config.format`) rather than a tool
definition — this is not a function call — and the JSON Schema is generated from the same
Zod object that validates the response on the way back, so there is one definition rather
than two that drift.

If summary quality turns out to be the weak point, the model id is a one-line change and
the provider interface absorbs it. The claim is not that Sonnet is sufficient for
everything; it is that this task was made small enough that it doesn't need more.

*Which* provider runs is a runtime lookup rather than a startup constant: `LLM_PROVIDER` is
the default, and a row in `app_settings` written by the dashboard toggle overrides it for
both processes with no restart. That exists so the deterministic/LLM boundary can be
demonstrated rather than described — it is gated behind `ENABLE_PROVIDER_TOGGLE`, and in
production provider selection is deployment config, not something a dashboard can change.

#### What the cheaper model would actually buy
<!-- slice: 5, measured 2026-08-16 -->

The argument above says the boundary makes a cheaper model sufficient. That invites the
obvious question — *then why not the cheapest one?* — so it was measured rather than
asserted. Live calls, the real `buildPrompt` and `buildOutputJsonSchema`, one
representative finding (3 events, one fenced complaint, two priority drivers), prices as
of 2026-08-16:

| Model | in / out tokens | $/MTok | Per finding | Per 1,000 | Latency (3 runs) |
|---|---|---|---|---|---|
| Haiku 4.5 | 1,187 / 245 | $1 / $5 | **$0.0024** | $2.41 | 2.7–3.1s |
| **Sonnet 5** (current, intro price) | 1,506 / 314 | $2 / $10 | **$0.0062** | $6.15 | 4.2–5.2s |
| Sonnet 5 (list, from 2026-09-01) | 1,506 / 314 | $3 / $15 | $0.0092 | $9.23 | — |
| Opus 5 | ~1,510 / 323 | $5 / $25 | $0.0156 | $15.63 | 5.7s |

Three things the sticker prices don't show:

- **Haiku's advantage is larger than the 3× price ratio.** It uses the older tokenizer, so
  identical prompt text bills 1,187 tokens against Sonnet 5's 1,506 — about 25% fewer. The
  effective gap at list price is **3.8×**, not 3×.
- **The JSON Schema is ~39% of every input.** `count_tokens` on system + user returns 915
  (Sonnet 5) and 690 (Haiku 4.5); the live calls bill 1,506 and 1,187. The difference —
  roughly 590 and 500 tokens — is `output_config.format`. That is the price of structured
  outputs and it is worth paying, but it is the largest single line item on the input side.
- **It cannot be cached away.** The stable prefix here is the system prompt, about 380
  tokens, against a minimum cacheable prefix of 1,024 tokens on Sonnet 5 and 4,096 on
  Haiku 4.5. Prompt caching is unavailable to this workload at any breakpoint placement,
  which is what the comment in `llm/pricing.ts` already says.

One cost lever was tested and rejected: `claude-sonnet-5` runs adaptive thinking whenever
`thinking` is unset, which it is here, so forcing `thinking: {type: "disabled"}` looked
like free savings. It measured as noise (312 output tokens against 335 and 308) — at
`effort: "low"` the model is barely thinking already.

**On quality, the gap is narrow and real.** Every model returned schema-valid JSON with
correct allowlist actions, correct tags, correct citations, and no invented labels, and
both Sonnet 5 and Haiku 4.5 refused the injection preset outright. Haiku's prose trends
generic where Sonnet's is concrete, and Haiku wrote evidence labels inline into the
summary text — `"…missing items upon receipt (E1, E2)."` — which reads as noise on a card
that already renders its evidence in a table. That last one is now closed in the prompt
for every model, not just Haiku: labels belong in `cited_labels` and nowhere else. Opus 5
was indistinguishable from Sonnet 5 at two and a half times the cost, which is the
original decision to reject Opus-tier, confirmed with a number.

**The switch is worth making when volume makes it worth making.** At demo volume the
difference is 0.7¢ per finding and the prose is the graded artifact, so Sonnet 5 stays. At
10,000 findings/day it is $92/day against $24/day, and the trade inverts. Two code changes
go with it, neither optional:

1. **Remove `output_config.effort`.** Haiku 4.5 rejects it outright — `400 invalid_request_error:
   "This model does not support the effort parameter."` It is currently unconditional in
   `callModel`.
2. **Add `claude-haiku-4-5: { input: 1, output: 5 }` to `RATES` in `llm/pricing.ts`.** The
   rate table is keyed on the exact model id with no prefix fallback, by design — a missing
   entry means every finding reports tokens with a null cost rather than a wrong one.

**Caveat, stated at the same volume as the numbers:** this is one finding shape, a handful
of runs, and one injection payload. It is a directional read, not an eval. If the model
choice ends up mattering, the honest version is a fixed set of ~20 findings scored against
the `parse.ts` validator plus a human read of the summaries.

**Token counts and cost are shown on the operator's board — deliberately, and only
because this is a demo.** Every model-written finding carries a chip with its tokens and
what they cost, accumulated across each enrichment the finding has had. That is there so a
reviewer reading this repo can see the cost argument above as a real number on a real
finding rather than as a claim in a document, and multiply it by their own event volume.

It is the wrong place for it in production. A restaurant manager triaging a late delivery
has no decision that depends on the summary having cost $0.0062, and putting a per-item
cost in front of them invites the question of whether the cheaper summary was the worse
one. This is internal telemetry: it belongs on an ops or finance view, aggregated by
restaurant and by day, next to queue depth and dead-letter counts. The stored columns and
the `enrichment.completed` log line are the durable record and would stay exactly as they
are; only the chip comes off the operator's card.

### Real-time: every connect is a snapshot
<!-- slice: 6 -->

**Snapshot-on-connect makes reconnect correct by construction.** Every SSE message is a
complete, ordered board plus the ids that changed — not an initial snapshot followed by
patches. A reconnect and a routine update travel identical code, so "the client missed
something while it was disconnected" is not a state that can exist, and there is no
`Last-Event-ID` bookkeeping to get wrong. That is the whole answer to the brief's
disconnect-and-reconnect case. The `changed` ids exist only so the UI can briefly highlight
what moved; nothing about correctness depends on them.

It cost a few KB per change instead of a few hundred bytes, and it keeps the sort order
server-side — a client that re-sorted a patched map locally would be a second
implementation of the priority ranking, free to drift from the one in SQL.

The trigger is a single process-wide poller at 1s, fanning out in memory, rather than
Postgres `LISTEN/NOTIFY`. Same reasoning that killed the outbox relay: `NOTIFY` buys about
a second against a worker that already polls at 1s, and costs a dedicated connection plus a
missed-notification hole during listener reconnects that needs a watermark catch-up anyway.
The shared-subscription-and-fanout split is the shape `NOTIFY` would need regardless, so
swapping it in later is one file.

One bug this design was supposed to prevent still got in, and only a real reconnect found
it: the poller stops when the last client leaves, and `subscribe()` was serving its frozen
cache to the next client. A browser that disconnected and came back saw a finding as
`accepted` that the worker had already marked `failed`. `subscribe()` now always reads
fresh, and an integration test changes the database while nobody is subscribed.

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
step to double-process. Worker-side redelivery safety landed in slice 3 (the claim
statement transitions the row it claims, and correlation carries its own redelivery
guard).

**What the UI shows.** The simulator's *Duplicate event* button posts one body twice on a
single click and logs both outcomes — `201 Accepted`, then `200 Duplicate, recognized as a
duplicate of <id> — no second event row, no second job, no new finding`. Saying what did
*not* happen is the point: the board deliberately does not change, and without the log line
that is indistinguishable from a button that did nothing. The `id` in the second response is
the original row's, so the collision is nameable rather than merely asserted.

### Out-of-order events
<!-- OWNER: agent | slice: 4 -->
The match predicate is bidirectional, so an event that arrives late but *happened*
earlier still joins its finding and pulls `first_event_at` backwards. This is the case
a one-sided predicate (`last_event_at >= occurred_at - 3h`) silently gets wrong: that
form has no lower bound at all, so a six-day-old backfill would match the live finding
and then drag its window six days back, after which it would swallow everything at that
restaurant.

Findings are **updated, never regenerated**. New evidence attaches, the denormalized
fields are recomputed from the evidence set, and `version` increments — which is what the
dashboard's change detection keys on, and what tells a summary written for three events
from the four the finding now holds. Recomputing rather than incrementing means
the aggregates converge after a partially applied or retried run instead of drifting
permanently once wrong.

The three-hour window *is* the aggregation window; there is no separate debounce. An
event arriving hours after its siblings still joins them if it falls inside it.

Worked example, arriving in the worst order — review (20:10) first, then the delay
(17:55), then the complaint (18:12): the review creates the finding; the delay is
2h15m *earlier* but within the window, so it attaches and `first_event_at` moves back
to 17:55; the complaint lands inside the interval and attaches. One finding, three
evidence rows. Verified through the real API and worker, not just in tests.

Re-verified on the Docker image rather than only in development: both reference buttons
were clicked against `docker compose up` and converged — identical finding shape, evidence,
priority and drivers, differing only in the prose and the restaurant they were posted to.
The two buttons deliberately target different restaurants, because correlation allows one
open finding per restaurant and a shared target would merge them into a single six-event
finding, making the two orders appear *not* to converge. Both events' payloads are the
brief's own, verbatim — a 42-minute delay, a one-star review, and both pieces of customer
text — so the card can be read side by side with the assignment.

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

**Duplicate findings** aren't reachable from this path: `finding_events` carries a
`UNIQUE(event_id)` constraint, so one event can only ever evidence one finding.

**Inconsistent UI state** is handled by making every SSE message a complete board rather
than a patch, so the dashboard cannot drift from the database by accumulating updates —
and by making a reconnect identical to a first connection, so there is no catch-up path
to get wrong. The one case that needed real work is the reverse: a finding whose *prose*
falls behind its evidence, when a worker dies after correlation commits and before
enrichment writes. That is detected by `enriched_version < version`, shown on the card,
and repaired on the redelivery that the un-acked job guarantees. Retrying work that has no
finding yet — because it failed before correlation committed — is visible in the header
strip's counts rather than silently absent.

### Traffic spike (100,000 events in 10 minutes)
<!-- OWNER: design-chat -->
What absorbs the burst. Ingestion writes the event and its job row in a single statement and returns as soon as that commits — no LLM call, no correlation, nothing on the request path that can slow down under load. A spike therefore shows up as queue depth in `event_jobs`, not as API latency or dropped events. The API degrades by getting behind, not by getting slow, which is the failure mode you want.

How workers scale. The worker is a separate process from the Next.js app, so the two scale independently — a burst needs more workers, not more API capacity. Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`, so running N workers requires no code change and no coordination: each claim either wins a row or skips to the next. I verified this with two concurrent workers against twelve queued events — all twelve processed exactly once, split 7/5 across the workers, no job claimed twice. The loop also re-polls immediately after a successful claim and sleeps only when it finds an empty queue, so the poll interval is the cost of idling rather than a per-job tax; under load, throughput is bounded by processing time.

What isn't built. Three of the mechanisms this scenario really needs are absent, and I'd rather name them than imply the system handles more than it does.

There is no backpressure. Ingestion accepts events at whatever rate they arrive and the queue grows without limit. The first thing I'd add is a queue-depth ceiling per tenant — past a threshold, return `429` with `Retry-After` so producers slow down instead of the backlog silently growing into hours of lag. A second, gentler option is shedding by event type: a `negative_review` can wait; a `delivery_delay` during service can't.

There is no global spend control. `MAX_LLM_ATTEMPTS` bounds retries per job, so a single event can't loop expensively, but nothing caps aggregate cost — 100,000 events would mean as many enrichment calls as they correlate into findings, at whatever rate the workers can issue them. Production needs a concurrency semaphore around the provider (a fixed number of in-flight calls, independent of worker count) and a per-tenant daily budget that degrades to the deterministic fallback provider rather than failing when exhausted. The fallback path already exists for outages, which means the graceful-degradation behavior for a budget cap is already built — it just isn't wired to a budget.

There is no tenant isolation. Claiming is FIFO by `next_attempt_at` across all tenants, so one restaurant chain sending 100,000 events starves every other restaurant behind it in the queue. The schema is multi-tenant (tenant-scoped idempotency keys, per-restaurant correlation) but the queue is not. The fix I'd reach for first is claiming round-robin across distinct `restaurant_id` values rather than strictly oldest-first — a fairness quota rather than a separate queue per tenant, which would be a lot of machinery for the same outcome.

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

There is no Redis in this system, so the question has a short answer: nothing breaks if it's flushed, because nothing depends on it.

That was a deliberate call rather than an omission. The brief warns against adding Redis to satisfy the assignment, and every job Redis would have done here is done by Postgres. The queue is a table claimed with `SELECT ... FOR UPDATE SKIP LOCKED`. Idempotency is a unique constraint. The "one open finding per restaurant" invariant is a partial unique index. Concurrency control is row locks and constraint violations. All of it lives in the same transactional boundary as the business data it protects, which is precisely the property that makes the partial-failure story work — an event and its job row are written in one statement, so "saved but never queued" isn't recoverable, it's impossible.

The one place a cache genuinely exists is the SSE broadcaster's in-memory board snapshot, and it's worth naming because it taught me something. It's process-local, rebuilt from Postgres every second, and holds nothing that isn't derivable. Losing it costs one poll interval. But during slice 6 that cache was being served to newly-connecting clients — so a browser that disconnected and returned could see a finding as accepted that the worker had already marked failed. The bug wasn't the cache, it was trusting it at a moment when it could be stale. `subscribe()` now always reads fresh, and there's a test that mutates the database while nobody is subscribed.

If I were adding Redis later, it would be for things Postgres is genuinely worse at rather than for the ones it handles fine: per-tenant rate limiting and LLM spend counters, where the write volume is high and losing a few seconds of counter state on a flush is acceptable. Those are exactly the mechanisms listed as missing under traffic-spike handling — and notably, they're also the only ones where "permanently lost on flush" is a tolerable answer.

---

## Operator feedback loop
<!-- OWNER: design-chat -->

An operator can mark a finding reviewed, mark it resolved, or flag it as unhelpful with an optional note. All three persist to an append-only `operator_actions` log; the first two also set current-state fields on the finding, so the audit trail and the board can't disagree.

The one that matters for the product over time is the negative flag, and it captures more than a thumb. A finding's summary is overwritten by the next enrichment — feedback storing only a finding id would preserve the operator's judgment and lose the thing they judged. So each flag snapshots the artifact under judgment: the exact issue and summary text, the recommended actions, the model that wrote them, whether the model ran at all, the citations, and the finding's version, priority, and status at that moment. Evidence is stored by reference rather than copied, because `events` is append-only and ids rehydrate the model's input exactly, while findings mutate and their output has to be preserved.

That asymmetry is what turns each flag into a complete eval row: input, output, judgment, and provenance. A hundred of them are a golden set — which is precisely what this build lacks, and the first thing I'd use them for.

Three things I'd do with that data. Run prompt changes against the flagged set and measure whether they'd now produce something acceptable, so a prompt edit stops being a guess. Segment flags by `summary_source` to separate "the model wrote something wrong" from "the fallback was inadequate here" — different problems with different fixes. And check flags against priority, because a cluster on one severity level is more likely a threshold that's miscalibrated than a model that's wrong; the thresholds are deterministic constants and adjusting them is cheaper and safer than adjusting a prompt.

---

## Failure tests
<!-- OWNER: agent | slice: 9 -->

```bash
docker compose up -d db
npm test                      # 347 tests: 17 unit files, 18 integration files
npm run test:unit             # pure functions, no database
npm run test:integration      # real Postgres, real SQL, no mocked queries
```

**`npm test` is green with the full stack running beside it,** and that took a fix rather
than a convention. The integration suite runs against its own database — `sauce_ops_test`,
created on first run on the same server, from the same migrations — because the queue is
global: `claimJob` takes the oldest eligible job in `event_jobs` regardless of who queued
it. Any worker on the same database competes with the tests for every job they enqueue,
and that includes the `worker` service in `docker compose up`. Sharing one database meant
the documented way to run this project and the documented way to test it could not both be
true at once. Nothing new to configure — the name is derived from `DATABASE_URL`.

Contention doesn't fail cleanly, which is why a second guard survives the fix: it fails a
*different* assertion on each run, each one plausible enough to look like a real bug
(`queued` reads 0, a provider records no calls, a finding hasn't appeared yet).
`tests/setup.integration.ts` queues a canary job, waits two poll intervals, and aborts by
name if anything claimed it. The separate database removes the ordinary cause; the canary
still catches a worker deliberately pointed at the test database — a stale `DATABASE_URL`
in a shell, say. Both were written because this happened, not in anticipation of it.

**The suite cannot reach a live model.** Enrichment takes an optional provider and falls
back to whatever `LLM_PROVIDER` names, so a developer running with `LLM_PROVIDER=anthropic`
— the setting you need to demo the product — would have `npm test` billing a real API and
failing on network latency. The same setup file therefore forces `LLM_PROVIDER=fallback`
*and* deletes `ANTHROPIC_API_KEY`: the first covers the env default, the second covers the
runtime override, since a stored `anthropic` choice with no key degrades to the fallback
writer. `ALLOW_LIVE_LLM=true` opts a whole run out for a deliberate live check, and a
single file opts out by mocking `src/lib/env`. `tests/integration/noLiveLlm.test.ts`
asserts the property, so removing the guard turns something red instead of quietly
restoring the bill.

### What each scenario is covered by

| Scenario | Test | What it proves |
|---|---|---|
| Submit the same event five times | `integration/ingestionDedup.test.ts` | Five POSTs to the real route handler → `201 duplicate:false` once, `200 duplicate:true` four times, all returning the same id; one `events` row, one `event_jobs` row, one finding, one evidence row, **one LLM call** through `runJob`. Also: the same `event_id` at a different restaurant is a different event, since the constraint is on the pair. |
| Kill the worker mid-processing and restart | `integration/workerCrash.test.ts` | A claim that never receives a disposition — which is exactly what `SIGKILL` leaves in `event_jobs`. Covers: the job is *not* reclaimable before `PROCESSING_TIMEOUT_MS`; it is reclaimed after, with a fresh `claim_token` and an incremented attempt; the dead worker's late `markSucceeded`/`markFailed` update zero rows and log `job.disposition_superseded`; the restarted worker finishes the job; and a job that crash-loops dead-letters *at claim* with a diagnosable `last_error` rather than looping forever. |
| Malformed LLM JSON | `unit/parseEnrichment.test.ts`, `unit/anthropicProvider.test.ts`, `integration/enrichment.test.ts` | Non-JSON, schema violations, fabricated citations and out-of-allowlist action types are all rejected; the provider regenerates exactly once then gives up; the pipeline degrades to the deterministic writer and the finding still reaches `ready`. |
| LLM timeout | `unit/anthropicProvider.test.ts`, `integration/enrichment.test.ts` | A timeout is **not** regenerated (1 call) while a rejected response **is** (`MAX_LLM_ATTEMPTS` calls) — asserted in the same test so the asymmetry can't read as an accident. End to end, a timeout degrades to fallback and the job is marked **succeeded, not retried**: the degrade already produced evidence, priority and prose. |
| Concurrent related events | `integration/correlation.concurrency.test.ts` | Six concurrent events for one restaurant produce one finding holding all six, with no lost version updates; a forced `23505` proves the create-race retry actually runs, by asserting on the `correlation.insert_race_retry` log rather than on final state that would look identical either way. |
| Out-of-order delivery | `integration/correlation.reference.test.ts` | All six permutations of the brief's three-event scenario converge on the same finding, the same evidence, and the same first/last event timestamps. |
| Prompt injection in customer text | `unit/prompt.test.ts`, `unit/llmSchema.test.ts`, `integration/promptInjection.test.ts` | Hostile text is fenced as data and can't escape; fabricated citations and unknown action types are rejected; and when the model is made to *obey* the injection, every variant lands on the fallback path with priority, evidence and the stored complaint text untouched. |
| Disconnect the dashboard and reconnect | `integration/sseStream.test.ts`, `integration/broadcaster.test.ts` | A client disconnects while the model is still running and reconnects after it finished; the **first frame** of the new connection shows `ready`. Aborting the request closes the stream rather than leaking the subscription. |
| Refresh mid-processing | `integration/firstPaint.test.ts` | A cold `currentBoard()` load during processing renders as *Analyzing* with a placeholder, never a blank card — and is byte-identical to the first frame the live stream would have sent, so a refresh can't flicker between two different truths. |
| Retry schedule and permanent failure | `unit/backoff.test.ts`, `integration/deadLetterFinding.test.ts` | The 1s/2s/4s/8s ladder and its five-minute cap; a job that exhausts its budget dead-letters, its finding is marked `failed`, and its evidence and priority survive intact. |
| **Flush Redis** | — | Not applicable: there is no Redis. See [Redis and temporary state](#redis-and-temporary-state) for the answer to what that means. |

### Proving the tests fail when the bug returns

Coverage says a line executed. It does not say an assertion would have noticed. This
project has been bitten three times by the difference: a slice-4 retry path that never
fired, a slice-6 cache that served a stale board, and a `waitForNext` test helper whose
"a message already arrived" branch was dead code (`const before = messages.length;
if (messages.length > before)`) — all three sat inside passing, covered tests.

So each load-bearing test was verified by putting the bug back and confirming it goes
red. The first four reverts below were run at `8a9cd9c`, the fifth at `f9ee90a`; the
output shown is what those runs actually printed.

**1. Remove the staleness predicate from `claimJob`** — make any `processing` job
claimable by the next worker that asks:

```diff
-        OR (status = 'processing'
-            AND claimed_at < now() - make_interval(secs => ${PROCESSING_TIMEOUT_MS / 1000}))
+        OR (status = 'processing')
```
```
 ❯ tests/integration/workerCrash.test.ts (6 tests | 1 failed)
   × does not release its job before the processing timeout has passed
   AssertionError: expected { …(5) } to be null
      Tests  1 failed | 5 passed (6)
```
The other five passed. That is the point of the negative control: every test that
*backdates* a claim would still pass against a `claimJob` that had no staleness
condition at all, because the backdate would be doing nothing. Only the test asserting
a fresh claim is **un**claimable can tell the difference.

**2. Restore the slice-6 cache** — serve the frozen board to a reconnecting client:

```diff
-  const { state } = await readBoard(null);
+  const state = instance.state ?? (await readBoard(null)).state;
```
```
 ❯ tests/integration/broadcaster.test.ts (4 tests | 2 failed)
   × shows a reconnecting client what changed while nobody was listening
   × pushes an update when a finding changes, naming what moved
 ❯ tests/integration/sseStream.test.ts (4 tests | 2 failed)
   × shows a client that disconnected mid-processing the finished state when it returns
   × serves a later connection correctly after an earlier one was aborted
   AssertionError: expected [ { …(21) } ] to have a length of 2 but got 1
      Tests  4 failed | 4 passed (8)
```
These assertions are all on the **first** frame after reconnecting. Asserting on a
later frame would pass with the bug restored, because the poller refreshes the stale
board a second afterwards — the bug is only visible in the first thing a reconnecting
client is handed.

**3. Drop `ON CONFLICT DO NOTHING` from `enqueueEvent`** — let the duplicate insert
raise instead:

```diff
-      ON CONFLICT (restaurant_id, event_id) DO NOTHING
       RETURNING id
```
```
 ❯ tests/integration/ingestionDedup.test.ts (4 tests | 1 failed)
   × accepts every copy but creates the work exactly once
   AssertionError: expected 500 to be 200
      Tests  1 failed | 3 passed (4)
```
The second test — one finding, one evidence row, one LLM call — **still passed**, because
a duplicate rejected with a 500 also leaves exactly one row and spends exactly one call.
Row counts alone cannot distinguish "recognized the duplicate" from "crashed on the
duplicate". The status code is what carries that assertion, and it's also what the UI
shows the operator.

**4. Restore the dead condition in the `waitForNext` helper:**

```diff
-    if (cursor >= messages.length) {
+    const before = messages.length;
+    if (messages.length > before) return messages[messages.length - 1];
```
```
 ❯ tests/unit/collector.test.ts (4 tests | 2 failed)
   × returns a message that arrived before waitForNext was called
   × hands back messages in arrival order, not just the latest
   Error: no board message arrived
      Tests  2 failed | 2 passed (4)
```
A helper that waits for the *next* message instead of returning the one already
delivered turns a race into a five-second hang, or into a pass that asserted on the
wrong message. It had been in the suite since slice 6, passing, because the board poller
happened to tick after every call.

**5. Drop `llmUsage` from the board card** — make the server emit a finding the
dashboard's own schema refuses:

```diff
-    llmUsage: toUsage(row),
```
```
 ❯ tests/integration/sseStream.test.ts (5 tests | 3 failed)
   × shows a client that disconnected mid-processing the finished state when it returns
   × keeps polled updates readable by the dashboard, not just the connect frame
   × serves a later connection correctly after an earlier one was aborted
   Error: board frame would be refused by the dashboard: findings.0.llmUsage:
   Invalid input: expected object, received undefined
      Tests  3 failed | 2 passed (5)
```
This one is a repair, not a rehearsal — it shipped, and the four reverts above are the
reason it's worth writing down how. `boardFrom`, the helper every SSE test reads its
payload through, was `JSON.parse(frame.data) as BoardMessage`: the same cast that
*The dashboard validates what the stream sends it* (`docs/decisions.md`) removed from the
client, left standing in the tests that exist to prove the client's contract holds.
A cast makes a test agree with the server no matter what the server sends. It now parses
through `boardMessageSchema` — the browser's own schema, not a copy.

The difference is measurable, and it's the argument for fixing the helper rather than
adding one more assertion. With the schema in place, **three** tests fail, two of them
written for entirely unrelated reasons — the helper makes every SSE test a contract test,
so the next dropped field is caught by tests that never heard of it. With the cast
restored, only `keeps polled updates readable by the dashboard` fails, and that test only
exists because we already knew which field to go looking at. The second half of the same
gap: every SSE test read only the **connect** frame, so the poll path — a separate call
path, and the one that actually broke — had no frame-level assertion at all.

### The stale indicator, in practice

The bug above is also the first real use of the connection state machine, and it behaved
the way *A board that stopped updating says so* (`docs/decisions.md`) argued it would
rather than the way a feature usually behaves once the argument meets the system. The
board refused each malformed payload, held the last good one by reference so nothing
rendered half-updated, and switched to **Not updating** — immediately, since a refused
payload needs no clock. So the screen showed a board declaring itself stopped, beside a
*Related event* button that visibly did nothing. Without that state the same failure is a
dashboard that looks live, sits on a snapshot minutes old, and quietly disagrees with the
database.

That is the case for spending a state on it, and it is worth more than the argument made
in the ADR: a frozen board that claims to be live is the same class of failure as a live
finding silently filed under Resolved — the screen is confidently wrong and nothing on it
says so. The split between the two channels also held up. The badge says *the board has
stopped*, which is the part an operator needs and the part that distinguishes a broken
dashboard from a quiet one; the console line (`board.payload_rejected`, carrying the field
path and the finding id) says **which field**, which is the part that turns it into a
one-line diagnosis instead of an investigation.

### The kill-and-restart drill

The automated proof above models the kill as an undelivered disposition, which is what
the database actually sees. The real thing is a drill rather than a test — a spawned and
`SIGKILL`ed worker on Windows is slow and flaky, and a flaky test proves less than an
absent one:

```bash
docker compose up -d
# POST an event, then within PROCESSING_TIMEOUT_MS (45s):
docker compose kill -s SIGKILL worker
docker compose up -d worker
docker compose logs -f worker
```

Expected, in order:

```
{"msg":"job.claimed","event_id":"…","attempts":1,…}     # before the kill
{"msg":"job.claimed","event_id":"…","attempts":2,…}     # reclaimed ~45s later
{"msg":"job.succeeded","event_id":"…",…}
```

The finding keeps its evidence and priority throughout; only the prose waits.

### The graceful-shutdown drill

`SIGKILL` above is the ungraceful half. `SIGTERM` is the one that happens on every
deploy, scale-down and `docker compose stop`, and until slice 10 it had never actually
been exercised: Windows does not generate SIGTERM, so the handler in
`src/worker/index.ts` was written and unit-tested but never delivered a real signal.

```bash
docker compose up -d
# fill the queue so the worker is genuinely mid-drain rather than idle
docker compose stop worker
```

Four assertions, and **only the last one proves what the drill is actually about.**
Log lines and an exit code prove the *process* exited; they say nothing about whether
the job it was holding reached a disposition. A worker that dropped its in-flight job on
the floor and exited immediately would satisfy the first three and fail the fourth:

| # | Assertion | Measured |
|---|---|---|
| 1 | `worker.shutdown_requested` → `job.succeeded` → `worker.stopped`, in that order | ✓ |
| 2 | Container exit code is `0`, not `137` | `0` |
| 3 | Stop completes well inside the 10s grace period | **1619 ms** |
| 4 | **`SELECT count(*) FROM event_jobs WHERE status = 'processing'` is 0** | **0** |

A `137` or a stop that takes the full ten seconds both mean the same thing — the signal
never reached the handler and Docker eventually used `SIGKILL`. The usual cause is a
wrapper in PID 1, which is why nothing here launches through `npm run` and why the
worker runs compiled JS rather than through `tsx`: both put a process between Docker and
the handler.

The real run, with 2,950 jobs still queued behind it:

```
{"msg":"worker.shutdown_requested","signal":"SIGTERM"}
{"msg":"job.claimed","event_id":"cbd83252-…","attempts":1}
{"msg":"correlation.completed","finding_id":"bee6c8b5-…","version":45,"priority":"critical"}
{"msg":"enrichment.completed","finding_id":"bee6c8b5-…","source":"fallback"}
{"msg":"job.succeeded","event_id":"cbd83252-…"}
{"msg":"worker.stopped","worker_id":"worker-1-a97a1d65"}
```

**The 2ms gap between `worker.shutdown_requested` and `job.claimed` is the whole result,
and it happened by chance.** The signal landed while the loop had already passed its
`while (!shuttingDown)` check and entered `runJob` — so the claim, the correlation, the
enrichment *and* the disposition all completed after shutdown was requested, and only then
did the loop exit. That is the slice-3 decision to check `shuttingDown` between iterations
rather than aborting mid-job, proven from outside the process at precisely the timing that
would have exposed it if it were wrong. Two milliseconds earlier and the loop would have
exited before claiming; a hundred milliseconds later and the job would have finished before
the signal arrived, and neither run would have shown anything.

Nothing engineered that window — the burst was sized to keep the worker busy, not to hit a
2ms seam, and repeating the drill will usually land in one of the boring cases. It is worth
writing down precisely because it cannot be relied on to recur: assertion 4 is what holds
when the timing is ordinary, and this log is what the assertion is protecting. The remaining
2,949 jobs stayed `pending` and were drained by the restarted worker.

### Two things asserted here that no revert can break

`tests/unit/configInvariants.test.ts` asserts
`PROCESSING_TIMEOUT_MS > LLM_TIMEOUT_MS * MAX_LLM_ATTEMPTS`. Since the constant is
currently *derived* from that expression, the assertion passes trivially and cannot
fail today. It is a drift-catcher, not a bug-finder, and it is listed here as one: it
fires only if someone replaces the derivation with a literal or raises the LLM timeout
without looking at what depends on it. The consequence of losing that relationship is
not a compile error — it is a healthy worker having its job reclaimed mid-call.

And the SSE teardown test asserts the stream *closes* on abort, which is observable.
That the subscription was also removed from the poller is not observable from outside
the process; the test asserts the closure and a subsequent connection still being served
correctly, which is as far as a black-box assertion reaches.

---

## Known limitations
<!-- OWNER: design-chat -->

These are deliberate scope decisions, not oversights. Each one is a place where I chose the simpler option and know what it costs.

**Correlation is coarse.** A finding groups everything happening at a restaurant within a rolling 3-hour window of the last event. Two genuinely unrelated problems in the same window — a delivery delay and a food quality complaint about a different order — merge into one card. I chose this because the brief's own reference scenario is a mixed-type incident (delay + complaint + review) spanning ~2h15m, and any key that splits by issue type or uses a fixed time bucket fails to reproduce it. A finding here means "something is wrong at this restaurant right now," which is the shape an operator actually acts on. The cost is occasional over-merging.

**The window is a constant.** Three hours is hardcoded, not tuned per restaurant. A high-volume location during dinner rush and a quiet one at 3pm get the same window, which is wrong in both directions. Tuning this needs volume data I don't have.

**Correlation can't see what a complaint is about.** Grouping uses `restaurant_id` and time only. LLM-extracted tags like `missing_items` are shown on the card for context but are deliberately never read by correlation code, because model output must not silently decide which events belong together. The natural next step is a hybrid — rules first, with the model proposing merges for leftovers as a suggestion an operator confirms, never as a silent write.

**Backfilled events don't correlate with each other.** An event arriving more than 3 hours before an open finding's window gets its own finding, created already closed, so a live incident isn't hijacked by week-old data. The cost is that two backfills minutes apart become two separate findings, since the lookup only sees open ones. The brief's out-of-order case is events minutes apart, which works correctly; this only affects genuine historical replay.

**`negative_review` has no structured root cause.** `issue_class` is derived from structured fields only. Complaints and refunds can carry a `category`/`reason` that folds into a real root-cause class (a refund for lateness classes as `delivery_delay`, not `refund`), but reviews arrive with only a rating and free text, so they always class as `negative_review`. Extending this means adding a structured field to the review payload, not inferring one from the text.

**Multi-worker is safe but unproven at scale.** Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`, and I verified two concurrent workers against twelve events with no job processed twice, plus a forced insert-race on the correlation path. What I haven't done is run this under real load — and the polling interval still sets a floor on end-to-end latency that a broker with push delivery wouldn't have.

**No authentication, no tenant isolation.** Any caller can post events for any `restaurant_id`, and the dashboard shows every restaurant's findings. The brief excludes auth, so this is expected, but it means the multi-tenancy in the schema (tenant-scoped idempotency keys, per-restaurant correlation) is structural rather than enforced.

**No per-tenant rate limiting or LLM spend control.** A single restaurant flooding events would consume worker capacity and LLM budget other tenants need. The queue absorbs the burst safely — the API stays responsive and nothing is lost — but processing is FIFO across all tenants with no fairness guarantee.

**A demo affordance ships in the code.** An `event_id` prefixed `force_fail_` deliberately throws after correlation commits, so the `failed` state can be demonstrated end-to-end rather than only unit-tested. It's gated behind `ENABLE_DEMO_FAILURE_TRIGGER` and documented — but it is a hook that wouldn't exist in production.

**No eval harness.** LLM output quality is unmeasured. I have no golden set, no regression check on prompt changes, and no way to tell whether a prompt edit made summaries better or worse. For a product whose value is the quality of its recommendations, this is the most significant gap — see "What I would do with one more day."

---

## Product and entrepreneurial judgment
<!-- OWNER: design-chat -->

**Who is the primary user?**

A shift manager during service, someone who needs to act on a problem now, not analyze it later. The board is built around that: one screen, priority sorted, no filters or date ranges, nothing that assumes you have time to set something up. Right now there is no auth or tenant scoping, so it works more like a small-chain operations dashboard. I left auth out because it was outside the brief, while the database already keeps restaurants properly separated: event IDs are scoped per restaurant, and findings never mix events from different ones. What is missing is the login that decides who gets to see which.

**What decision does the dashboard help them make?**

What to deal with first. That's why priority comes before recency, and why the card leads with facts the system computed rather than the AI summary: those are the parts an operator can trust without checking. The statuses matter for the same reason. "Still being analyzed" and "nothing wrong here" must not look alike, or the board stops being believable the first time it falls behind.

**What assumptions did you make?**

The main assumption is that a finding means "something is wrong at this restaurant right now," not "something is wrong with this specific order." So when the system decides whether two events belong together, it only looks at which restaurant they came from and how close in time they are. It never looks at the order number, even though the order number is stored and shown on the card. That came from the brief's own example, where a delay, a complaint on the same order, and a review with no order at all are all evidence of one finding.

The three-hour window and the priority thresholds are reasonable starting points, but they would need real restaurant data to tune properly.

One smaller assumption worth naming: events are treated as immutable, but that is a convention rather than a constraint. The thumbs-down feedback stores evidence by reference rather than copying it, so if an update path were ever added, old feedback would quietly start pointing at different input than the operator actually judged.

**What did you intentionally leave out?**

Auth and tenant isolation, backpressure, per-tenant spend limits, an eval harness, and browser tests. I also avoided Redis, because Postgres already handles the queue, the idempotency and the concurrency control inside one transactional boundary, which is what makes "event saved but never queued" impossible rather than just recoverable. Adding a second datastore would have bought a capability I already had. I left out thumbs-up because on its own it changes nothing and tells you nothing you can act on.

Each of these is covered in more detail in the Known limitations section, including what leaving it out actually costs.

**What is the smallest version worth releasing?**

The current product running with `LLM_PROVIDER=fallback`. It still correlates events, prioritizes findings, shows evidence, and updates in real time. The only difference is that the summaries are templated instead of AI generated. That proves the core product doesn't depend on the LLM to be useful.

**What is the first product metric you would track?**

The percentage of findings operators actually act on during the shift. Number of events or findings doesn't tell me whether the product is useful. Action rate does. After that, I'd track how long it takes from the first event to the first operator action.

**What is the largest product risk?**

That the dashboard tells operators things they already know. A manager probably already knows an order is 95 minutes late. The real value has to come from finding patterns they couldn't easily see, like repeated missing-item complaints or delays connected to the same courier. If operators aren't acting on findings, that's a strong sign we're not providing enough new information.

**What would you validate with five restaurant operators?**

First, whether a finding is even the right unit. Do they think about problems as restaurant incidents or individual orders? Then I'd validate the three-hour correlation window, the priority rules, whether the recommended actions match how they actually work, and whether they prefer occasionally merging unrelated events or splitting related events into separate findings.

**What would make you stop investing in the product?**

If operators consistently see findings but don't act on them. I'd also reconsider the AI layer if operators always need to check the evidence before trusting the summary. At that point the AI is adding work instead of removing it, and the deterministic system may be more valuable on its own.

**What would you build next if adoption were strong?**

**Hybrid correlation.** Right now code decides which events belong together, using rules. Those rules miss connections a person would spot: two complaints four hours apart that both say the driver was rude are one problem, but the rules only see restaurant and time, so they become two findings. So keep the rules, and let the model suggest extra merges the rules missed. But it only suggests. An operator clicks yes before anything is grouped. The AI never silently changes what's on the board, because grouping is the foundation everything else sits on and it has to stay predictable.

**An eval system built from thumbs-down feedback.** Every time an operator flags a summary as unhelpful, the system already saves the exact prose they rejected and the events behind it. Collect a hundred of those and you have a test set: change the prompt, re-run it against them, and see whether the answers would now be acceptable. Right now I'd just be guessing.

**Notifications.** Right now someone has to be looking at the screen. Notifications push the urgent findings to them instead.

**What did you change or improve beyond the literal assignment?**

I added a runtime provider toggle and summary rewrite so the AI boundary can actually be demonstrated. I added token and cost tracking, a `stale` connection state so the UI clearly shows when live updates stop, and a measured comparison between models based on latency, tokens, and cost. I also strengthened the testing process so important failure tests are verified by intentionally reintroducing the bug and making sure the test actually fails.

---

## What I would do with one more day
<!-- OWNER: design-chat -->

**An eval harness.** The biggest gap. Summary quality is the product's value and it is currently unmeasured, so I cannot tell whether a prompt change made things better or worse. I would build a fixed set of around twenty findings, run the model against them, and score the output. The thumbs-down feedback already stores what was rejected, the evidence behind it, and which model wrote it, so it seeds this directly.

**Browser tests.** Nothing in the suite touches the UI. Three real defects were found by looking at the rendered result instead of by a test: an accordion clipping the action buttons, a styling utility silently deleting the type scale, and a missing field that crashed the whole board. A handful of browser tests would have caught all three.

**A check against the live model.** The suite deliberately cannot reach the real API, which keeps it fast and free but leaves one class of regression invisible: a model that stops following the prompt fails nothing. That needs an eval with a pass threshold rather than a unit test, since the model varies run to run.

---

## What I would change before production
<!-- OWNER: design-chat -->

**The queue.** Postgres as a queue is right at this scale and I would keep it longer than most people expect. At sustained volume I would move to a real broker or partition the job table. The polling interval also sets a floor on how fast anything starts processing.

**Fairness between tenants.** There is one queue shared by everyone, like a single line at a counter. At 9:00 one restaurant sends 100,000 events and they all join the line. At 9:01 another sends a single event, and it lands at position 100,001. The worker always serves the front of the line, so at 50 jobs a second that single event waits about 35 minutes. Nothing is broken; "oldest first" is just unfair when one customer can flood the line. I would take turns between restaurants instead, so no one gets stuck behind someone else's backlog.

**Spend control.** Nothing caps total model cost. I would add a concurrency limit on the provider and a per-restaurant daily budget that falls back to the templated writer when exhausted. That fallback already exists for outages, it just is not wired to a budget.

**Backpressure.** The API accepts events indefinitely and the queue just grows. I would add a queue depth ceiling per restaurant that returns 429 instead.

**Auth and tenant isolation.** The database already separates restaurants. What is missing is the login that decides who sees which, and the check that stops anyone posting as anyone.

**Remove the demo affordances.** The forced failure trigger, the provider toggle, and the cost figure on the card exist so a reviewer can see the system work. In production, provider choice is deployment config and cost belongs on an internal ops view.

**Observability.** Structured logs with correlation IDs exist. Metrics, tracing, and alerting do not. A queue quietly falling behind should page someone rather than be noticed by an operator.

---

## AI tool usage disclosure
<!-- OWNER: design-chat, with agent supplying the factual record -->

AI assistance is disclosed here rather than hidden, and the repository is set up so the
claim is checkable rather than asserted: `CLAUDE.md`, `.claude/commands/slice-done.md`,
`docs/decisions.md` and the commit history are the working record.

**Two Claudes, with different jobs.** A design-review chat planned and pressure-tested each
slice *before any code existed* — schema shapes, failure modes, what the alternatives cost.
Claude Code then implemented in the repository, ran the verification, and committed. The
split matters because the two failure modes differ: a planning chat argues you into a design
and cannot tell you it does not compile, while an implementing agent will happily build a
design nobody stress-tested. Keeping them separate meant each was checking the other's
characteristic weakness.

**The setup was deliberate.** `CLAUDE.md` fixes the architectural invariants the agent may
not change without asking, the build order, the coding conventions, and the git rules.
`.claude/commands/slice-done.md` defines a ritual — lint, typecheck, test, ADR entry, README
update, commit — so that finishing a slice means the same thing every time rather than
whatever seemed reasonable that hour. `docs/decisions.md` was written *while* decisions were
made, not reconstructed afterwards, which is why it records rejected alternatives and not
just outcomes. The `Co-Authored-By: Claude Opus 5` trailer marks the commits where Claude
Code authored changes in this repository; it carries no claim about the prose, some of which
was drafted in the design chat and edited by me. The `<!-- OWNER: -->` comments in this file
are what identify which is which.

**What plan review actually caught, before code existed.** These are the cases where the
design was wrong and would have been expensive to unwind later:

- **The correlation key.** The first design keyed findings on `order_id`, or on
  `restaurant + issue_class + time bucket`. Both split the assignment's *own* worked example
  — a mixed-type incident spanning 2h15m — into two or three separate findings. Reviewing the
  design against the brief's expected output, rather than against itself, is what surfaced
  it. The result is that `findings` has no `issue_class` column at all.
- **The duplicate-response upsert.** Returning the existing row's id on a duplicate was going
  to use the standard `ON CONFLICT ... DO UPDATE SET x = x RETURNING id, (xmax = 0)` trick.
  It works, and it writes a new row version on every duplicate — taking a row lock and
  creating a dead tuple in a table documented as immutable and append-only. The assignment's
  own failure test is "submit the same event five times", which would have produced five row
  versions of a row meant never to be touched again.
- **The unbounded `occurred_at`.** A client error putting a timestamp a year in the future
  would create a finding whose rolling window never lapses — so it never closes, and the
  partial unique index means it silently absorbs every subsequent event at that restaurant,
  forever. A validation bound two tables away from the constraint it protects.
- **`issue_class` as a copy of `event_type`.** The first draft derived one from the other with
  no transformation for three of four event types — two columns holding identical strings,
  which any reviewer would notice and ask about.
- **The undiagnosable dead letter.** Claim-time dead-lettering was going to leave `last_error`
  untouched, so a crash-looped job would arrive in the DLQ carrying either a stale message or
  nothing at all.

**The verification discipline came out of being wrong.** Three times a green test meant
nothing: a concurrency test whose race never fired because the transactions serialized; a
reconnect test that asserted on a later poll tick, which refreshed the stale board it was
supposed to catch; and a helper with a dead condition (`const before = messages.length; if
(messages.length > before)`) that passed since slice 6 for an unrelated reason. All three sat
inside covered, passing tests. The standard that emerged — recorded in `docs/decisions.md`
and demonstrated above with real diffs and real failure output — is that a test claiming to
prove a failure path is verified by **reintroducing the bug and confirming it goes red**.
That standard has since caught two more classes: a contract test that read its payload
through an `as` cast agreed with the server no matter what the server sent, and a Docker
verification that proved the model path while claiming to prove the no-model path, because
Compose had quietly supplied a real API key from a `.env`.

**Where AI assistance produced defects that review did not catch.** This is the honest half,
and it is the more useful one:

- A comment block written *inside* a SQL template literal, where `//` is literal text rather
  than a comment. It produced invalid SQL and broke every ingestion request until slice 3
  (`0f6a921`). Lint and typecheck were green throughout — neither reads SQL inside a string.
- `claimed_at` used as a fencing token. Postgres stores microseconds; the value round-trips
  through a JS `Date` and back out truncated to milliseconds, so the equality check *never*
  matched. Every disposition write updated zero rows and returned normally. It surfaced only
  because a verification script asserted the row's post-state rather than that the call had
  not thrown.
- An SSE cache served to reconnecting clients, showing a finding as `accepted` that the worker
  had already marked `failed` — found by disconnecting and reconnecting against a live worker,
  not by reading the code.
- A dropped `llmUsage` key crashing the entire board in the browser: a chip showing token
  spend took down the priority, evidence and status that the whole architecture argues are
  independent of the model.
- An accordion that pinned its own content height, clipping the operator action buttons
  entirely. Found by looking at a screenshot.
- `tailwind-merge` silently deleting the type scale wherever a size and a colour were
  combined. Typecheck, lint and build were all green with the bug present.
- This README claiming an automated live-model test layer that did not exist. Both live
  verifications had been manual.
- The architecture diagram rendering as raw source on GitHub for want of three `<i>` tags,
  found by looking at the rendered page rather than by anything in the repo.
- Tip copy advertising a 35-minute delay and a 2-star review that went stale *inside the same
  commit* that changed those values, because the new test pinned the payload and nothing
  pinned the prose describing it.
- A committed `package-lock.json` that `npm ci` refused: `esbuild`, which `tsx` depends on,
  was missing from it entirely. Every existing `node_modules` in this project had it, so
  nothing locally ever noticed — `npm ci` installs strictly from the lockfile and will not
  paper over the gap. That is exactly the failure mode a reviewer hits on their first
  command and the author never hits at all, and it stayed invisible until something did a
  clean install from scratch.

The pattern across all of them is the same and worth stating plainly: **AI assistance is
strong at producing something that compiles, passes its own tests, and reads well, and weak at
noticing that the thing it produced is not connected to reality.** Almost every defect above
was found by running the system, looking at the rendered result, or wiping the state and
starting clean — not by review and not by the type system. That is where the human time went,
and it is the part I would not delegate.
