import { Card } from "@/components/ui/card";

/**
 * Shown when the board has no active findings.
 *
 * More load-bearing than it looks: it is the first thing anyone sees after
 * `docker compose up`. A reviewer who starts the container before reading the
 * README should be able to work out what this product is from this screen
 * alone — so it leads with what the dashboard is for, then says it is live,
 * then points at the sidebar, which is permanently visible precisely so this
 * screen has somewhere to send them.
 */
export function EmptyBoard({ hasResolved }: { hasResolved: boolean }) {
  return (
    <Card className="rounded-xl border-0 p-8 shadow-rest">
      <div className="max-w-2xl">
        <h2 className="text-lead text-ink">No findings yet</h2>

        <p className="mt-3 text-body leading-relaxed text-ink-muted">
          Operational findings appear here as events correlate — grouped, prioritized, and
          summarized.
        </p>

        <p className="mt-3 text-body leading-relaxed text-ink-subtle">
          The board is connected and updating live, so anything you post shows up without a
          refresh. Delays, complaints, refunds and reviews from the same restaurant within a
          three-hour window become one finding.
        </p>

        <p className="mt-5 text-body leading-relaxed text-ink-muted">
          Use the controls in the sidebar to post some. Under{" "}
          <span className="font-medium text-ink">Reference scenario</span>,{" "}
          <span className="font-medium text-ink">In order</span> runs the assignment&apos;s own
          worked example — a delay, a complaint, and a bad review that correlate into a single
          finding. Every control has an ⓘ explaining what it posts and what to expect.
        </p>

        {hasResolved && (
          <p className="mt-3 text-body leading-relaxed text-ink-subtle">
            Everything currently on the board has been resolved — see{" "}
            <span className="font-medium text-ink">Resolved</span> in the sidebar.
          </p>
        )}

        <p className="mt-4 text-meta leading-relaxed text-ink-subtle">
          Events are accepted and queued by the API; the worker correlates and summarizes them,
          so it needs to be running (<code className="font-mono">npm run worker</code>, or the{" "}
          <code className="font-mono">worker</code> service under Docker Compose).
        </p>
      </div>
    </Card>
  );
}

/** Shown on the resolved view before anything has been resolved. */
export function EmptyResolved() {
  return (
    <Card className="rounded-xl border-0 p-8 shadow-rest">
      <h2 className="text-lead text-ink">Nothing resolved yet</h2>
      <p className="mt-3 max-w-2xl text-body leading-relaxed text-ink-subtle">
        Resolving a finding moves it here rather than deleting it, so the work stays
        inspectable. Open a finding and use{" "}
        <span className="font-medium text-ink">Mark resolved</span>.
      </p>
    </Card>
  );
}
