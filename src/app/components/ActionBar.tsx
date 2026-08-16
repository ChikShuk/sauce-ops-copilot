"use client";

import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OperatorActionType } from "@/lib/actions/schema";
import type { FindingCard, OperatorActionRecord } from "@/lib/findings/types";
import { cn } from "@/lib/utils";
import { OperatorActionIcon } from "./icons";
import { Tip } from "./Tip";
import { ACTION_TIPS } from "./tips";

// The third client-side boundary, and validated like the other two. This one
// feeds the optimistic overlay, so an absent field here would put `undefined`
// into the board's own state — the exact shape of the resolvedAt bug, arriving
// by a different door.
export const actionResultSchema = z.object({
  reviewedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

export type ActionResult = z.infer<typeof actionResultSchema>;

/**
 * Posting an operator action, shared by the two places that offer one.
 *
 * The decisions about the *finding* (reviewed, resolved) and the judgement of
 * the *prose* (unhelpful) now live in different cards, because they are about
 * different things — but they are one endpoint and one optimistic-update
 * contract, and duplicating this would be two copies of a validated boundary.
 */
function useOperatorAction(findingId: string, onRecorded: (result: ActionResult) => void) {
  const [busy, setBusy] = useState<OperatorActionType | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(actionType: OperatorActionType, withNote?: string): Promise<boolean> {
    setBusy(actionType);
    setError(null);

    try {
      const res = await fetch(`/api/findings/${findingId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action_type: actionType,
          ...(withNote ? { note: withNote } : {}),
        }),
      });

      if (!res.ok) throw new Error(`Request failed (${res.status})`);

      const result = actionResultSchema.safeParse(await res.json());
      if (!result.success) throw new Error("malformed action response");

      onRecorded(result.data);
      return true;
    } catch (err) {
      // The optimistic update is applied by the caller only on success, so
      // there is nothing to roll back here — the card simply never moved.
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, send };
}

/**
 * The two decisions about the finding itself, on the status strip.
 *
 * They had a section card of their own, which spent a card's worth of height on
 * two buttons — so they are compact now and ride the strip that already carries
 * status, priority and version. The full-width form each one used to have (icon
 * tile, label, and a hint line beneath) is gone; the hint moved into the tip,
 * which was already saying more than the hint did.
 *
 * The summary feedback control lives in the Summary card, beside the prose it
 * judges. What is left here is coherent: both of these answer "what do I want to
 * happen to this finding".
 *
 * `thumbs_up` exists in the database constraint but is deliberately not shipped:
 * a positive signal with nowhere to go is a button that looks like feedback and
 * is not.
 */
export function ActionBar({
  card,
  onRecorded,
}: {
  card: FindingCard;
  onRecorded: (result: ActionResult) => void;
}) {
  const { busy, error, send } = useOperatorAction(card.id, onRecorded);

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
      <ActionButton
        type="mark_reviewed"
        label="Mark reviewed"
        doneLabel="Reviewed"
        busy={busy === "mark_reviewed"}
        done={card.reviewedAt !== null}
        tip={ACTION_TIPS.reviewed}
        onClick={() => void send("mark_reviewed")}
      />

      <ActionButton
        type="mark_resolved"
        label="Mark resolved"
        doneLabel="Resolved"
        busy={busy === "mark_resolved"}
        done={card.resolvedAt !== null}
        tip={ACTION_TIPS.resolved}
        onClick={() => void send("mark_resolved")}
      />

      {error && <p className="w-full text-meta text-danger-fg">Could not record that: {error}</p>}
    </div>
  );
}

/**
 * Feedback is per version: a thumbs-down on v3's summary says nothing about
 * v5's, so the control re-enables once new evidence has moved the finding on.
 */
function flaggedThisVersion(card: FindingCard, actions: OperatorActionRecord[]): boolean {
  return actions.some(
    (action) => action.actionType === "thumbs_down" && action.version === card.version,
  );
}

/**
 * "Unhelpful", as a chip beside the summary's provenance marks.
 *
 * Compact rather than a full-width button, matching the re-write control: both
 * are actions about the prose rather than about the finding, and giving them the
 * same weight is what says so.
 *
 * Split from its note panel because the two belong in different parts of the
 * card — the trigger rides the heading with the other chips, the panel opens
 * under the prose it is judging. FindingBody owns the open state, which is the
 * price of that split and cheaper than a portal.
 */
export function SummaryFeedbackChip({
  card,
  actions,
  open,
  onToggle,
}: {
  card: FindingCard;
  actions: OperatorActionRecord[];
  open: boolean;
  onToggle: () => void;
}) {
  const flagged = flaggedThisVersion(card, actions);

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={flagged ? undefined : open}
        disabled={flagged}
        onClick={onToggle}
        className={cn(
          "h-6 gap-1.5 rounded-full px-2.5 text-meta font-normal",
          flagged
            ? "border-transparent bg-ok-bg text-ok-fg disabled:opacity-100"
            : "text-ink-muted hover:text-ink",
        )}
      >
        <OperatorActionIcon type="thumbs_down" done={flagged} className="size-3" />
        {flagged ? `Flagged v${card.version}` : "Unhelpful"}
      </Button>
      <Tip label="Summary unhelpful" wide className="-ml-0.5">
        {ACTION_TIPS.thumbsDown}
      </Tip>
    </span>
  );
}

/** The note field, opened by the chip above and rendered under the prose. */
export function SummaryFeedbackPanel({
  card,
  actions,
  onRecorded,
  onSent,
}: {
  card: FindingCard;
  actions: OperatorActionRecord[];
  onRecorded: (result: ActionResult) => void;
  onSent: () => void;
}) {
  const { busy, error, send } = useOperatorAction(card.id, onRecorded);
  const [note, setNote] = useState("");

  if (flaggedThisVersion(card, actions)) return null;

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-lg bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          placeholder="What was wrong with it? (optional)"
          aria-label="Feedback note"
          className="min-w-0 flex-1 bg-card text-body"
        />
        <Button
          type="button"
          size="sm"
          onClick={async () => {
            if (await send("thumbs_down", note.trim() || undefined)) {
              setNote("");
              onSent();
            }
          }}
          disabled={busy === "thumbs_down"}
          className="text-label"
        >
          {busy === "thumbs_down" ? "Saving…" : "Send feedback"}
        </Button>
      </div>

      <p className="text-meta leading-relaxed text-ink-subtle">
        Records this exact summary, the AI model that wrote it, and the evidence it was
        given — the prose is copied because the next enrichment overwrites it.
      </p>

      {error && <p className="text-body text-danger-fg">Could not record that: {error}</p>}
    </div>
  );
}

/**
 * One compact control: a small button and its ⓘ.
 *
 * Sized to the strip it sits on — `h-7` matches the status badge beside it, and
 * the pill shape marks it as a control rather than one more piece of metadata on
 * a line that is otherwise all metadata.
 */
function ActionButton({
  type,
  label,
  doneLabel,
  busy,
  done,
  tip,
  onClick,
}: {
  type: OperatorActionType;
  label: string;
  doneLabel: string;
  busy: boolean;
  done: boolean;
  tip: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={busy || done}
        className={cn(
          "h-7 gap-1.5 rounded-full px-2.5 text-meta font-normal",
          // The done state keeps its ok tint and border: that pair is a status
          // channel, and it is the only thing on the strip saying this finding
          // has been acted on. `disabled:opacity-100` because done is a state to
          // read, not a control greyed out.
          done
            ? "border-ok-border bg-ok-bg text-ok-fg disabled:opacity-100"
            : "text-ink-muted hover:text-ink",
        )}
      >
        <OperatorActionIcon type={type} done={done} className="size-3.5" />
        {busy ? "Saving…" : done ? doneLabel : label}
      </Button>

      <Tip label={label} wide>
        {tip}
      </Tip>
    </span>
  );
}
