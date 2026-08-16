# CLAUDE.md — Sauce Ops Copilot

## What this is

A take-home assignment for a Staff AI Engineer role at Sauce (restaurant delivery
platform). It will be read by senior engineers who are evaluating **judgment**, not
volume of code. A small, thoughtful system beats a large one.

**The product:** restaurant operators receive a continuous stream of operational
events (delivery delays, complaints, refunds, negative reviews). The system
correlates related events into *findings*, enriches them with an LLM-written summary
and recommended actions, and surfaces them on a live dashboard where the operator can
act on them.

**What the reviewers are actually grading:**
1. The deterministic / LLM boundary — is the model used where it adds value, or is it
   doing work that code should do?
2. Correctness under failure — duplicates, out-of-order arrival, crashes, LLM outages.
3. Product judgment in the UI — can an operator tell what's happening, why it matters,
   what to do, and what evidence supports it?
4. The written deliverables (README, architecture doc, design decisions).

Assume every architectural shortcut will be noticed. Where we take one deliberately,
it goes in `docs/decisions.md` with the reasoning.

---

## Core architectural invariants

These are settled. Do not change them without flagging it to me first.

### 1. Deterministic code decides what is true. The model decides how it's described.

**Deterministic (`src/lib/`):**
- Validation, normalization, idempotency
- **Correlation** — which events belong to the same finding
- **Priority/severity** — threshold rules on delay minutes, event count, rating, recurrence
- **Evidence** — the event ID list, assembled from the DB, never from model output
- Status machine, retries, DLQ, versioning, concurrency control

**Model (`src/lib/llm/`):**
- The human-readable summary narrative
- Naming the pattern ("repeated missing items during evening shift")
- Recommended actions, phrased for an operator
- Extracting structure from free customer text (e.g. "fries were missing" → `missing_items`)

The LLM **enriches a finding that already exists**. It is never on the critical path to
producing one. If the LLM fails, the finding is still created, still correlated, still
prioritized, still has evidence — only the prose degrades.

### 2. No Redis.

Postgres does queue duty via `SELECT ... FOR UPDATE SKIP LOCKED`. The assignment
explicitly warns against adding Redis to satisfy a checkbox. One fewer moving part in
Docker Compose, and no permanent business data living outside the durable store.

### 3. The job row is written in the same transaction as the event.

One table, `event_jobs`, carrying status, attempts, next_attempt_at, claimed_at.
Written atomically with the event row. The worker claims from it directly using
`SELECT ... FOR UPDATE SKIP LOCKED`.

No separate outbox table and no relay. The outbox pattern exists to bridge a database
and a *separate* broker, where the write and the publish cannot share a transaction.
Here the queue is Postgres itself, so relaying rows between two tables in the same
database would add a moving part and a failure mode without adding any guarantee.

Consequence: "event saved but crashed before queuing" is impossible by construction,
not merely recoverable. If we later moved to a real broker, `event_jobs` becomes the
outbox and a relay is added at that seam — document this in the README.

### 4. Idempotency at two layers.

- **Ingestion:** unique constraint on `event_id`. Duplicate returns `{status: "accepted"}`
  without creating new work. The UI must visibly show it was recognized as a duplicate.
- **Worker:** the consumer checks processing state before doing work, so redelivery of
  the same message is safe.

### 5. Findings are living entities, not per-event artifacts.

A finding is keyed on a correlation key (order_id when present; otherwise
restaurant + issue class + time window). New evidence **updates** the existing finding
and bumps its version. This is what makes out-of-order arrival and real-time updates
fall out naturally instead of being bolted on.

### 6. Untrusted input stays untrusted.

Customer-authored text (complaints, reviews) is fenced in prompts as data, never as
instruction. Model output is validated against a Zod schema on the way back, and
recommended actions are constrained to a known allowlist of action types. Any claim in
a summary must map to an event already in the evidence set — unsupported conclusions
are dropped or regenerated.

---

## Stack

- **Next.js 16 (App Router) + TypeScript** — one language across API, worker, and UI
- **Postgres + Drizzle** — durable store, queue, and outbox
- **Zod** — one schema definition shared by API validation, worker, and LLM output parsing
- **SSE** for real-time (one-way server→client; simpler than WebSockets and easier to explain)
- **Worker** is a separate Node process in the same repo
- **Docker Compose** — db + app + worker, runs with one command
- **Tailwind + shadcn/ui** for styling. shadcn is copy-paste: the component code
  lands in `src/components/ui/` and we own and edit it, so it is a starting point
  rather than a dependency to work around. Do not hand-roll anything it provides —
  Accordion, Popover, Sheet, Table, Badge, Button, Input, Card, Separator, Skeleton.
  It does pull real Radix packages for behaviour; that is the trade and it is worth
  it for focus management and collision positioning.
  The design system is `docs/design-principles.md`, and tokens live in one place
  (`src/app/globals.css`). **One light palette, no dark theme** — see the ADR.
  (This reverses the original "no component library, no design system" rule, which
  held while the UI was a thin surface over the pipeline.)

## Layout

```
src/
  app/                  dashboard UI + API routes
  lib/
    db/                 schema, client, migrations
    events/             zod schemas, normalization
    correlation/        grouping rules — deterministic, heavily tested
    llm/                provider interface + anthropic impl + fallback impl
    queue/              outbox, job claim/ack, retry, DLQ
  worker/               separate process entry point
tests/
docs/
  decisions.md          ADR-lite log
```

`correlation/` and `llm/` are separate folders on purpose — the deterministic/model
boundary made physical.

---

## Build order (vertical slices)

Build in this order. Each slice must work end-to-end before starting the next, so that
if time runs out there is always a demoable product.

1. **Data model + migrations** — events, event_jobs, findings, finding_events, operator_actions
2. **Ingestion** — POST endpoint, validation, dedup, outbox write, returns immediately
3. **Worker loop** — claim from event_jobs with SKIP LOCKED, status transitions, retry, DLQ
4. **Correlation** — grouping rules + priority rules, unit tested
5. **LLM integration** — provider interface, fallback impl first, then Anthropic impl
6. **SSE + dashboard** — live findings list, detail panel, evidence, status badges.
   Also verify the two forward-looking claims in the README's "Known limitations" —
   that `extracted_tags` are shown on the finding card, and that the dashboard shows
   every restaurant's findings. Both were written true-of-slice-6 and marked inline
   with `<!-- slice 6: verify true once dashboard exists -->`; check them rather than
   assume them.
7. **Event simulator** — buttons for delay / complaint / duplicate / related-to-existing
8. **Operator action** — mark reviewed/resolved + thumbs down, persisted
9. **Failure tests** — duplicates, malformed LLM JSON, timeout, out-of-order, concurrent
10. **Docker Compose** — one-command run. Also verify SIGTERM delivery and graceful
    worker shutdown *inside the Linux container* — Windows never generates SIGTERM,
    so that path is unverified as of slice 3 and can only be exercised here.
    Also: final visual pass on both palettes, verify text legibility. The light
    palette shipped contrast-measured but never seen, and some copy still reads
    poorly — both are open as of the slice-6 layout pass.
11. **README + architecture doc**

---

## Coding conventions

- Strict TypeScript. No `any`, no non-null assertions to silence the compiler.
- Zod at every boundary: HTTP in, LLM out, env vars at startup.
- Server Components by default; `"use client"` only where interactivity requires it.
- Errors are values in worker paths — don't let a single bad event kill the loop.
- Every LLM call: timeout, bounded retry, schema validation, fallback on failure.
- Log structured JSON with `event_id` / `finding_id` correlation IDs.
- Comments explain **why**, not what. Especially around concurrency and idempotency.
- No premature abstraction. Two implementations before extracting an interface —
  except `llm/`, where the interface is required by the fallback design.
- Never edit code after the verification pass without re-running verification.
  Lint and typecheck do not validate SQL inside template literals.
- Never print .env contents. To confirm a key exists, use `grep -c '^KEY_NAME=' .env`
  — never cat, tail, or head the file.

---

## Git workflow

**You handle git. I'll tell you when a slice is done.**

Commit directly to main. No feature branches or PRs — this is a solo,
time-boxed project and the PR ceremony adds no review value.

### Trigger phrase: "slice done"

When I say **"slice done"**, run this ritual without further prompting:
1. `npm run lint`, `npm run typecheck`, and `npm test`; fix what breaks before
   proceeding
2. Append an entry to `docs/decisions.md` if this slice involved an architectural
   choice (see format below)
3. **Update the README.** Open `README.md`, find every section tagged with the slice
   number just completed, and replace `_TODO_` with real content. Sections tagged
   `<!-- OWNER: design-chat -->` are mine — never write those, but if one is still `_TODO_`
   and its slice has passed, tell me it's outstanding.
4. Commit with a Conventional Commits message (format below)
5. Push

For remaining slices, run these verification steps yourself as part of
`slice done` and report the actual output — don't report a step as verified
without showing the command output that proves it.

### Commit messages

Conventional Commits: `feat:` `fix:` `chore:` `docs:` `test:` `refactor:`

Subject line under 72 chars, imperative mood. For any commit involving a design
decision, write a body explaining **the decision and the alternative rejected** — not
a description of the diff. Example:

```
feat: add transactional outbox for event publishing

Events and their outbox row are written in one transaction, so a crash
between "event saved" and "queued" cannot lose the event — the relay
picks up unpublished rows on restart.

Chose this over publishing directly from the API route because the
assignment explicitly asks about the save-then-crash case.
```

### Rules

- **Never commit or push without an explicit instruction from me in that message.
  "Slice done" is that instruction; a plan approval is not.**
- Keep the `Co-Authored-By: Claude` trailer. AI usage is disclosed in this project,
  not hidden.
- Commit at **vertical slice** boundaries, not per file or per task.
- Never force-push. Never rewrite history. A `fix:` correcting an earlier choice is a
  positive signal, not something to hide.
- **Never run `git stash`, `reset`, `checkout`, or any command that modifies my working
  tree without asking first. Read-only git commands are fine.**
- Never commit `.env`. `.env.example` is committed and must stay current.
- No feature branches, no PRs. Commit and push directly to `main`.

---

## docs/decisions.md

Append an entry whenever an architectural choice is made — while it's fresh, not
reconstructed later. Four lines:

```
## <date> — <decision title>
**Context:** what forced a choice
**Decision:** what we chose
**Alternatives:** what we rejected and why
**Consequence:** what this costs us / what it buys
```

This file is the raw material for the architecture document. Keep it honest — including
the shortcuts.

---

## Deliverables checklist

Keep these in view; they are explicitly required:

- [ ] Web dashboard with findings, priority, status, summary, actions, evidence, timestamps
- [ ] Event simulator in UI: delay, complaint, **duplicate**, event related to existing finding
- [ ] Ingestion endpoint returning before AI processing
- [ ] Durable store, queue, background worker
- [ ] Meaningful LLM integration with structured output
- [ ] Real-time updates without page refresh; visible `accepted → processing → ready | failed`
- [ ] Evidence attached to every finding
- [ ] Idempotent duplicate handling
- [ ] Retry + permanent failure behavior
- [ ] One persisted operator action
- [ ] At least two failure tests
- [ ] Architecture doc with Mermaid diagram
- [ ] Product judgment section (11 questions from the brief)
- [ ] "What I would do with one more day"
- [ ] "What I would change before production"
- [ ] Disclosure of AI coding tool usage
- [ ] Working Docker container, no manual configuration
- [ ] No `_TODO_` markers remain in README.md

---

## How to work with me

- Ask before changing anything under "Core architectural invariants".
- When a requirement is ambiguous, choose the simpler option, implement it, and note
  the assumption in `docs/decisions.md`. Don't stall on clarification.
- Prefer deleting code over adding configuration.
- If you find yourself building something the brief didn't ask for, stop and check.
  Scope discipline is part of what's being graded.
