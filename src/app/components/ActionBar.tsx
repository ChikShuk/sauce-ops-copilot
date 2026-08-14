"use client";

import { useState } from "react";
import type { OperatorActionType } from "@/lib/actions/schema";
import type { FindingCard, OperatorActionRecord } from "@/lib/findings/types";

export type ActionResult = {
  reviewedAt: string | null;
  resolvedAt: string | null;
};

/**
 * Lives in the detail panel, not on the card.
 *
 * Resolving a finding you haven't read is not a workflow worth supporting, and
 * the card's job is a three-second scan — three buttons on every row would cost
 * that for an action taken rarely. The card shows the *result* instead: a
 * Reviewed pill, dimming, or moving into the resolved section.
 */
export function ActionBar({
  card,
  actions,
  onRecorded,
}: {
  card: FindingCard;
  actions: OperatorActionRecord[];
  onRecorded: (result: ActionResult) => void;
}) {
  const [busy, setBusy] = useState<OperatorActionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  // Feedback is per version: a thumbs-down on v3's summary says nothing about
  // v5's, so the button re-enables once new evidence has moved the finding on.
  const alreadyFlagged = actions.some(
    (action) => action.actionType === "thumbs_down" && action.version === card.version,
  );

  async function send(actionType: OperatorActionType, withNote?: string) {
    setBusy(actionType);
    setError(null);

    try {
      const res = await fetch(`/api/findings/${card.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action_type: actionType,
          ...(withNote ? { note: withNote } : {}),
        }),
      });

      if (!res.ok) throw new Error(`Request failed (${res.status})`);

      const result = (await res.json()) as ActionResult;
      onRecorded(result);
      setNoteOpen(false);
      setNote("");
    } catch (err) {
      // The optimistic update is applied by the caller only on success, so
      // there is nothing to roll back here — the card simply never moved.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          busy={busy === "mark_reviewed"}
          done={card.reviewedAt !== null}
          doneLabel="Reviewed"
          onClick={() => send("mark_reviewed")}
        >
          Mark reviewed
        </Button>

        <Button
          busy={busy === "mark_resolved"}
          done={card.resolvedAt !== null}
          doneLabel="Resolved"
          onClick={() => send("mark_resolved")}
        >
          Mark resolved
        </Button>

        <Button
          busy={busy === "thumbs_down"}
          done={alreadyFlagged}
          doneLabel={`Flagged (v${card.version})`}
          onClick={() => setNoteOpen((open) => !open)}
        >
          Flag summary as unhelpful
        </Button>
      </div>

      {noteOpen && !alreadyFlagged && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            placeholder="What was wrong with it? (optional)"
            className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 text-xs text-ink"
          />
          <Button
            busy={busy === "thumbs_down"}
            onClick={() => send("thumbs_down", note.trim() || undefined)}
          >
            Send feedback
          </Button>
        </div>
      )}

      {noteOpen && !alreadyFlagged && (
        <p className="text-xs text-ink-subtle">
          Records this exact summary, the model that wrote it, and the evidence it was
          given — the prose is copied because the next enrichment overwrites it.
        </p>
      )}

      {error && <p className="text-xs text-danger-fg">Could not record that: {error}</p>}
    </div>
  );
}

function Button({
  busy,
  done,
  doneLabel,
  onClick,
  children,
}: {
  busy?: boolean;
  done?: boolean;
  doneLabel?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || done}
      className="rounded border border-line px-2.5 py-1.5 text-xs text-ink hover:bg-surface-hover disabled:cursor-default disabled:text-ink-subtle disabled:hover:bg-transparent"
    >
      {busy ? "Saving…" : done ? `✓ ${doneLabel}` : children}
    </button>
  );
}
