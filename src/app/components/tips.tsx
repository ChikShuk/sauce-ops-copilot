/**
 * Every InfoTip's content, in one file.
 *
 * Kept together rather than inlined at each call site so the explanation layer
 * can be read and edited as a single body of copy — it is a deliverable in its
 * own right, not decoration on the components. If a reviewer can understand the
 * workflow from the screen alone, it is this file that did it.
 *
 * Facts quoted here are load-bearing and must track the code:
 *   thresholds       src/lib/correlation/priority.ts
 *   retry schedule   src/lib/queue/backoff.ts
 *   card states      src/lib/findings/cardState.ts
 *   presets          src/lib/simulator/presets.ts
 */

const Term = ({ children }: { children: React.ReactNode }) => (
  <span className="font-medium text-ink">{children}</span>
);

const Heading = ({ children }: { children: React.ReactNode }) => (
  <span className="mt-1 block text-label text-ink first:mt-0">{children}</span>
);

// ---------------------------------------------------------------------------
// The deterministic / model boundary. The most important tip on the screen.
// ---------------------------------------------------------------------------

export const DRIVERS_TIP = (
  <>
    <p>
      <Term>This line is computed, not written.</Term> Deterministic rules read the
      structured fields on the events behind this finding — delay minutes, how much
      evidence has accumulated, the lowest review rating, and how often the same issue
      class has recurred at this restaurant within 24 hours — and compare each against a
      fixed threshold table. The signal reaching the highest level sets the priority;
      this line names the signals that fired.
    </p>
    <p>
      The AI model never sees those rules and cannot change the outcome. It writes the
      issue title and the summary. The priority, the evidence list and this line come from
      code.
    </p>
    <p>
      That split is the point: when the AI model is slow, wrong or entirely unavailable, the
      finding still appears, still correlated, with the same priority, the same drivers
      and the same evidence. Only the prose degrades.
    </p>
  </>
);

/**
 * The gavel in the priority panel. Replaces the words "decided it", which named
 * the fact without naming the rule behind it.
 */
export const DECIDING_SIGNAL_TIP = (
  <>
    <p>
      Every signal on this finding proposes a priority level on its own, by comparing one
      structured field against a fixed threshold table — delay minutes, evidence count,
      review rating, how often the same issue class has recurred here in 24 hours.
    </p>
    <p>
      The finding takes the <Term>highest</Term> proposal. The others are not wrong and
      not discarded; they simply did not reach as far. This mark is on the signal that set
      the level — the one whose proposal the finding is currently carrying.
    </p>
    <p>
      Where two signals tie at the top, the first is marked. The outcome is identical
      either way, and naming both would suggest a distinction the rule does not make.
    </p>
    <p>
      All of it is decided in code before any prose is written. The AI model never sees
      these rules and cannot change which signal wins.
    </p>
  </>
);

export const PRIORITY_TIP = (
  <>
    <p>
      Four levels, set by threshold rules in code. Every finding is at least{" "}
      <Term>low</Term>. The coloured rail down the left of a card carries the same value.
    </p>
    <ul className="flex flex-col gap-1">
      <li>
        <Term>Delay</Term> — 20 / 45 / 90 minutes → medium / high / critical
      </li>
      <li>
        <Term>Event count</Term> — 2 / 4 / 6 events → medium / high / critical
      </li>
      <li>
        <Term>Review rating</Term> — 3★ or below → medium; 2★ or below → high. One bad
        review is never critical on its own.
      </li>
      <li>
        <Term>Recurrence</Term> — 2 / 3 / 5 events of one issue class at this restaurant
        in 24h → medium / high / critical
      </li>
    </ul>
    <p>
      The highest level any single signal reaches wins. These thresholds are
      demo-appropriate placeholders, chosen to produce a legible spread — they are not
      tuned against real incident data.
    </p>
  </>
);

// Not exported: reached only through BOARD_LEGEND_TIP below. The per-state
// explanations components actually reach for are STATUS_TIPS.
const STATUS_LEGEND_TIP = (
  <>
    <p>
      Status describes the <Term>summary</Term>, never the finding. A finding is
      correlated, prioritized and carrying its full evidence from the moment it appears,
      whatever this says.
    </p>
    <ul className="flex flex-col gap-1">
      <li>
        <Term>Queued</Term> — saved, waiting for a worker to claim the enrichment job.
      </li>
      <li>
        <Term>Analyzing</Term> — a worker holds the job and the AI model is writing.
      </li>
      <li>
        <Term>Ready</Term> — summary written, schema-validated, citations checked against
        the evidence.
      </li>
      <li>
        <Term>Analysis failed</Term> — five attempts exhausted and the job dead-lettered.
        The evidence and priority are unaffected.
      </li>
    </ul>
    <p>
      Each state differs by colour, by the shape of its marker and by its wording
      together, so none of them depends on colour alone to be read.
    </p>
  </>
);

/**
 * The one affordance a reviewer opening the board cold should find first.
 *
 * Composed from the three tips above rather than duplicating them, so the
 * legend cannot drift from the per-element explanations it summarises.
 */
export const BOARD_LEGEND_TIP = (
  <>
    <Heading>Status</Heading>
    {STATUS_LEGEND_TIP}
    <Heading>Priority</Heading>
    {PRIORITY_TIP}
    <Heading>The drivers line</Heading>
    {DRIVERS_TIP}
  </>
);

// ---------------------------------------------------------------------------
// Per-state, shown on the detail panel's pill for the state it is actually in.
// ---------------------------------------------------------------------------

export const STATUS_TIPS = {
  queued: (
    <>
      <p>
        The event is saved and this finding already exists with its evidence and priority
        final. It is waiting for a worker to claim the enrichment job.
      </p>
      <p>Nothing is missing except the prose.</p>
    </>
  ),
  analyzing: (
    <p>
      A worker has claimed the job and the AI model is writing the summary and recommended
      actions. Usually a second or two.
    </p>
  ),
  ready: (
    <p>
      The summary has been written, validated against a schema, and its citations checked
      against the evidence set — a claim pointing at an event that is not below would be
      rejected rather than shown.
    </p>
  ),
  failed_unanalyzed: (
    <>
      <p>
        Enrichment failed five times and the job was dead-lettered. No summary was ever
        written, so the evidence below is shown on its own.
      </p>
      <p>
        The finding itself is intact: correlated, prioritized and complete. Only the
        narrative is missing.
      </p>
    </>
  ),
  failed_stale: (
    <>
      <p>
        Enrichment failed five times and the job was dead-lettered. A summary written
        earlier is kept and shown, but it predates this failure and the evidence that
        triggered it.
      </p>
      <p>
        Kept rather than hidden, because an out-of-date narrative next to current
        evidence is more useful than a blank panel — as long as it is labelled.
      </p>
    </>
  ),
} as const;

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export const RETRY_TIP = (
  <>
    <p>
      The enrichment job failed and is waiting to be retried. Five attempts, with the wait
      doubling each time — 1s, 2s, 4s, then 8s, about 15 seconds of backoff in total.
    </p>
    <p>
      Retry is job state, not finding state, which is why it is a separate chip rather
      than a status: a finding can be <Term>Ready</Term> from earlier evidence while a
      newer event behind it is still being retried.
    </p>
  </>
);

export const STALE_TIP = (
  <p>
    New evidence arrived after this summary was written, so the prose describes less than
    the evidence list does. It will be rewritten on the next successful enrichment. The
    priority and evidence are already up to date.
  </p>
);

export const STALE_STREAM_TIP = (
  <>
    <p>
      <Term>The connection is fine; the data is not.</Term> The stream is open and the
      server is answering, but nothing usable has arrived recently — either the payloads
      being sent are ones this page cannot read, or the server has stopped sending
      altogether. What is on screen is real, and it is no longer current.
    </p>
    <p>
      Different from <Term>Reconnecting</Term>, which means the connection itself dropped
      and the browser is retrying. That one resolves on its own; this one usually does not.
      Check the browser console for <Term>board.payload_rejected</Term> — it names the
      field and the finding that failed — and check that the app server is still running
      the same version as this page.
    </p>
    <p>
      A refused payload is refused whole, so the board never shows half an update. Nothing
      here is wrong; it is just older than it looks.
    </p>
  </>
);

export const BOT_TIP = (
  <>
    <p>
      The prose on this finding — the title, the summary and the recommended actions — was
      written by the AI model. The counterpart chip is{" "}
      <Term>No AI model — template</Term>; a finding with neither has not been enriched
      yet.
    </p>
    <p>
      The figures are what that cost: total tokens across every enrichment this finding has
      had, priced at Anthropic&apos;s published rate for the model that ran. Rejected
      responses are counted too — a schema failure is billed like any other call.
    </p>
    {/* Product documentation, not a note to a reviewer. It says where this
        belongs and why it is here anyway; the conclusion about cost discipline
        is left to be drawn rather than asserted. */}
    <p>
      In production this belongs in logs and a metrics dashboard, aggregated by restaurant
      and by day — a manager triaging a late delivery has no decision that turns on this
      summary costing $0.0054. It is surfaced per finding here so the cost of each
      enrichment is visible rather than assumed.
    </p>
  </>
);

export const DEGRADED_TIP = (
  <>
    <p>
      This summary was assembled from a template by deterministic code, not written by the
      AI model — either no API key is configured or every attempt failed.
    </p>
    <p>
      Shown rather than hidden so the degradation is visible. Evidence, priority and
      correlation are unaffected.
    </p>
  </>
);

export const CITED_TIP = (
  <>
    <p>
      The summary rests on this event. Evidence is handed to the AI model under the same{" "}
      <Term>E1…En</Term> labels shown here, so a citation lines up against the exact row
      it points at and can be checked by eye.
    </p>
    <p>
      Uncited rows are still part of the finding. Fallback summaries carry no citations at
      all, rather than claiming all of them.
    </p>
  </>
);

// ---------------------------------------------------------------------------
// Queue health
// ---------------------------------------------------------------------------

export const QUEUE_TIPS = {
  queued: (
    <p>
      Jobs written but not yet claimed by a worker. The queue is Postgres itself — workers
      claim rows with <Term>SELECT … FOR UPDATE SKIP LOCKED</Term>, so several can run
      without handing the same job to two of them.
    </p>
  ),
  analyzing: (
    <p>
      Jobs a worker currently holds. These counts exist for work the board cannot show: an
      event still being processed before correlation commits has no card to badge yet.
    </p>
  ),
  retrying: (
    <p>
      Jobs that failed and are waiting on backoff — 1s, 2s, 4s, 8s across five attempts.
      Non-zero here means the system is working through a problem rather than sitting
      still.
    </p>
  ),
  failed: (
    <p>
      Jobs that exhausted all five attempts and were dead-lettered. They stop consuming
      worker time and stay on the board as failed rather than disappearing. Their findings
      keep full evidence and priority.
    </p>
  ),
} as const;

// ---------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------

export const ACTION_TIPS = {
  reviewed: (
    <p>
      Records that someone has triaged this. The card stays in the working list and keeps
      its position, just dimmed — reviewed means seen, not finished.
    </p>
  ),
  resolved: (
    <p>
      Moves the finding out of the working list into the collapsed <Term>Resolved</Term>{" "}
      section. Nothing is deleted, and it stays open there for inspection.
    </p>
  ),
  thumbsDown: (
    <>
      <p>
        Records that this summary was unhelpful, against the exact version it was written
        for, with an optional note.
      </p>
      <p>
        Only thumbs-down ships. A thumbs-up with nowhere to go would be a button that
        looks like feedback and is not — this one is stored in an append-only audit log
        and re-enables when new evidence rewrites the summary.
      </p>
    </>
  ),
} as const;

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export const SIMULATOR_TIPS = {
  referenceChronological: (
    <>
      <p>
        Posts the assignment&apos;s three events in time order: a 42-minute delay, a
        complaint about the same order 17 minutes later, and a 1★ review 2h15m after
        that. The payloads are the assignment&apos;s own, verbatim.
      </p>
      <p>
        Expect a single card with three events spanning 135 minutes at <Term>high</Term>{" "}
        priority.
      </p>
      <p>
        Posts to its own restaurant rather than to Target, so this run and the shuffled
        one stay separate.
      </p>
    </>
  ),
  referenceOutOfOrder: (
    <>
      <p>
        The same three events, emitted in the wrong order — the review first, then the
        delay, then the complaint.
      </p>
      <p>
        Expect a finding <Term>identical</Term> to the chronological one: same three
        events, same 135-minute window, same priority. Arrival order changes nothing,
        because correlation keys on the restaurant and the time window rather than on
        sequence — <Term>order_id</Term> is display-only and never part of matching.
      </p>
      <p>
        Posts to its own restaurant rather than to Target, so the two cards sit side by
        side for comparison instead of merging into one.
      </p>
    </>
  ),
  delay: (
    <p>
      Posts one <Term>delivery_delay</Term> at 95 minutes, just past the 90-minute
      critical threshold. Expect a new <Term>critical</Term> card at the top of the board
      within a second or two.
    </p>
  ),
  complaint: (
    <>
      <p>
        Posts one complaint carrying <Term>category: missing_items</Term>.
      </p>
      <p>
        Note the issue class on the card is <Term>missing items</Term>, not
        &ldquo;complaint&rdquo; — the class is derived from structured fields, so the
        taxonomy splits without the AI model being involved.
      </p>
    </>
  ),
  duplicate: (
    <>
      <p>
        One click, the same event body posted <Term>twice</Term>, sequentially.
      </p>
      <p>
        Expect two log lines: <Term>201</Term> then <Term>200</Term>. The second is
        recognised by a unique constraint on the event id — no second event row, no second
        job, no second finding. The board gains exactly one event.
      </p>
    </>
  ),
  related: (
    <>
      <p>
        Posts a 2★ review with no order id to the restaurant of the finding you have
        selected, or the top card if none is.
      </p>
      <p>
        Expect the existing card to update in place rather than a new one appearing — its
        event count and version bump, priority is rescored, and the summary is rewritten.
        The card flashes to show which row moved.
      </p>
    </>
  ),
  injection: (
    <>
      <p>
        Posts a complaint whose customer text carries four attacks at once: an instruction
        override, a demand for an action outside the allowlist, a forged closing fence, and
        a citation to an evidence id that does not exist.
      </p>
      <p>
        Expect none of it to land. The summary should describe missing items normally, the
        recommended actions should stay inside the allowlist, and no fabricated citation
        should appear. Customer text is fenced as data in the prompt, and the AI model&apos;s
        output is schema-validated and citation-checked on the way back.
      </p>
    </>
  ),
  forceFail: (
    <>
      <p>
        Posts an event whose id carries a prefix the worker throws on — after correlation
        has already committed, so the finding exists with real evidence and a real
        priority first.
      </p>
      <p>
        <Term>This takes about 15 seconds of real backoff.</Term> Five attempts with the
        wait doubling each time — 1s, 2s, 4s, 8s. Watch the retry chip count down through{" "}
        <Term>1/5</Term> to <Term>4/5</Term> and the retrying count in the header go
        non-zero, then the card settles on <Term>Analysis failed</Term> with its evidence
        intact.
      </p>
    </>
  ),
  customJson: (
    <>
      <p>
        Sent to the same ingestion endpoint with no client-side checking, so whatever comes
        back is the API&apos;s own schema talking.
      </p>
      <p>
        Break the body deliberately — drop a required field, use an unknown event type,
        put the timestamp a year in the future — and the validation errors appear in the
        activity log as the endpoint reported them.
      </p>
    </>
  ),
  restaurant: (
    <p>
      Any value works — there is no tenant registry. A new value produces a separate
      finding, because correlation is scoped per restaurant. At most one finding stays
      open per restaurant at a time.
    </p>
  ),
  provider: (
    <>
      <p>
        Switches which writer produces the prose, for events posted from now on. Open a
        finding and use <Term>Re-write summary</Term> to see the same one described both
        ways.
      </p>
      <p>
        What changes is the wording and nothing else. The finding, its evidence, its
        priority, the drivers behind that priority and the status it is in were all
        decided by code before either writer ran, and are identical either way. That is
        the boundary this whole system is built on, and this is the fastest way to watch
        it hold.
      </p>
      <p>
        The switch writes a row in Postgres rather than an environment variable, because
        the process that acts on it is the worker — a separate process that would
        otherwise need a restart. It takes effect on the worker&apos;s next enrichment.
      </p>
      <p>
        A demo affordance, gated by <Term>ENABLE_PROVIDER_TOGGLE</Term>. In production,
        provider selection is deployment config, not something a dashboard can change.
      </p>
    </>
  ),
  rewrite: (
    <>
      <p>
        Queues this finding&apos;s prose to be written again by whichever model the
        sidebar currently names. Same evidence, same priority, same drivers — only the
        summary, the pattern name and the recommended actions are regenerated.
      </p>
      <p>
        The request is <Term>queued</Term>, not run here: the endpoint writes a job row
        and returns 202, and the worker claims it exactly as it claims an event, with the
        same retry ladder and dead-letter behaviour. Event jobs are always drained first,
        so this can never delay real ingestion.
      </p>
      <p>
        If new evidence arrives while the rewrite is in flight, the rewrite loses — its
        write is fenced on the version it was scoped to, and the enrichment describing the
        larger evidence set wins.
      </p>
    </>
  ),
} as const;
