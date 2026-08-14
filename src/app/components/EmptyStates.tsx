// The two screens that are almost entirely background. Both are more load-
// bearing than they look: one is the first thing anyone sees after `docker
// compose up`, and the other is half the viewport until a card is clicked.
// A blank region in either reads as a broken build rather than as an empty one.

const SAMPLE_CURL = `curl -X POST http://localhost:3000/api/restaurants/bellas_pizza/events \\
  -H 'Content-Type: application/json' \\
  -d '{
    "event_id": "evt_1",
    "event_type": "delivery_delay",
    "order_id": "1042",
    "occurred_at": "<an ISO timestamp within the last 7 days>",
    "payload": { "delay_minutes": 95 }
  }'`;

/**
 * Shown when the board has no findings at all.
 *
 * A reviewer who starts the container before reading the README should be able
 * to work out what this product is from this screen alone — so it leads with
 * what the dashboard is for, then says it is live, then gives them a way to put
 * something on it.
 *
 * Slice 7 replaces the curl block with the event simulator's buttons. When that
 * lands, this text is the thing to update rather than leave as a stale
 * instruction next to a working button.
 */
export function EmptyBoard() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-2xl">
        <h2 className="text-base font-medium text-ink">No findings yet</h2>

        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Operational findings appear here as events correlate — grouped, prioritized, and
          summarized.
        </p>

        <p className="mt-2 text-sm leading-relaxed text-ink-subtle">
          The board is connected and updating live, so anything you post shows up without a
          refresh. Delays, complaints, refunds and reviews from the same restaurant within a
          three-hour window become one finding.
        </p>

        <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
          Post an event
        </p>
        <pre className="mt-2 overflow-x-auto rounded border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-ink-muted">
          {SAMPLE_CURL}
        </pre>

        <p className="mt-2 text-xs text-ink-subtle">
          Needs the worker running (<code className="font-mono">npm run worker</code>) — the
          API accepts and queues the event, the worker correlates it.
        </p>
      </div>
    </div>
  );
}

/** Shown in the detail pane while no card is selected. */
export function NoSelection() {
  return (
    <div className="flex h-full items-center justify-center border-l border-line p-6">
      <div className="max-w-sm text-center">
        <p className="text-sm text-ink-muted">Select a finding</p>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-subtle">
          Its summary, the recommended actions, and every event behind it — with the evidence
          the summary cites marked.
        </p>
      </div>
    </div>
  );
}
