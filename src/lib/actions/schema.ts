import { z } from "zod";

/**
 * The operator actions this product actually ships.
 *
 * Deliberately narrower than the CHECK constraint on `operator_actions`, which
 * also permits `thumbs_up`. That value is kept in the constraint — dropping it
 * would be a migration for no benefit — but no button produces it, because it
 * lands on neither axis this set is built around: it changes no state, and as a
 * quality signal it is close to unactionable. A negative tells you which summary
 * to go and read; a positive tells you nothing you can act on without a baseline
 * to compare it against.
 *
 * Two axes, three actions, each with a consequence:
 *   workflow  mark_reviewed -> triaged, de-emphasized, still in the working list
 *   workflow  mark_resolved -> sets resolved_at AND closed_at; leaves the list
 *   quality   thumbs_down   -> captures an eval example (see recordAction.ts)
 */
export const OPERATOR_ACTION_TYPES = [
  "mark_reviewed",
  "mark_resolved",
  "thumbs_down",
] as const;

export type OperatorActionType = (typeof OPERATOR_ACTION_TYPES)[number];

// Long enough to say what was wrong with a summary, short enough that it can't
// be used to store an essay in an audit log.
export const MAX_NOTE_CHARS = 500;

export const operatorActionSchema = z.strictObject({
  action_type: z.enum(OPERATOR_ACTION_TYPES),
  note: z.string().trim().min(1).max(MAX_NOTE_CHARS).optional(),
});

export type OperatorActionInput = z.infer<typeof operatorActionSchema>;
