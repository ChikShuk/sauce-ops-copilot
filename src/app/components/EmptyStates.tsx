// The two screens that are almost entirely background. Both are more load-
// bearing than they look: one is the first thing anyone sees after `docker
// compose up`, and the other is half the viewport until a card is clicked.
// A blank region in either reads as a broken build rather than as an empty one.

/**
 * Shown when the board has no findings at all.
 *
 * A reviewer who starts the container before reading the README should be able
 * to work out what this product is from this screen alone — so it leads with
 * what the dashboard is for, then says it is live, then points at the simulator
 * panel above, which opens by default precisely because of this screen.
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

        <p className="mt-5 text-sm leading-relaxed text-ink-muted">
          Use <span className="font-medium text-ink">Simulate events</span> above to post
          some. <span className="font-medium text-ink">Reference scenario</span> runs the
          assignment&apos;s own worked example — a delay, a complaint, and a bad review that
          correlate into a single finding.
        </p>

        <p className="mt-2 text-xs text-ink-subtle">
          Events are accepted and queued by the API; the worker correlates and summarizes
          them, so it needs to be running (<code className="font-mono">npm run worker</code>,
          or the <code className="font-mono">worker</code> service under Docker Compose).
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
