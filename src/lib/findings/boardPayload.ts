import type { z } from "zod";
import { boardMessageSchema } from "./types";
import type { Board, BoardMessage } from "./types";

/**
 * The client's side of the SSE contract: parse a board message, or refuse it.
 *
 * A pure function rather than logic inside the stream handler, for the reason
 * every other decision in this UI is pure — the components stay thin enough not
 * to need a browser test harness, and the interesting behaviour (what happens
 * to a malformed payload) is asserted directly.
 *
 * **Refusing costs almost nothing here, and that is not an accident.** Every
 * SSE message is a complete, ordered board rather than a patch — the slice-6
 * call — so dropping one loses at most a second of freshness and can never
 * leave the board half-updated. There is no partial state to reconcile, because
 * there is no partial state. Under a patch protocol this strategy would be
 * unavailable: a dropped patch is a permanently diverged client.
 */

export type BoardParse =
  | { ok: true; message: BoardMessage }
  | { ok: false; problems: string[] };

// One bad board can carry a problem per finding, and a console with 200 lines
// in it is a console nobody reads. The count is reported either way, so the
// cap hides volume, never the fact that there was volume.
const MAX_REPORTED_PROBLEMS = 5;

/**
 * "findings[3].resolvedAt (finding 8f2c…): invalid_type, expected string".
 *
 * The finding id is dug out of the raw payload rather than the parsed one,
 * because there is no parsed one — validation is what just failed. It is the
 * difference between a report you can act on and one that says a field
 * somewhere was wrong.
 */
function describeIssue(issue: z.core.$ZodIssue, raw: unknown): string {
  const path = issue.path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`))
    .join("")
    .replace(/^\./, "");

  return `${path || "(root)"}${findingIdAt(issue.path, raw)}: ${issue.code} — ${issue.message}`;
}

function findingIdAt(path: readonly PropertyKey[], raw: unknown): string {
  if (path[0] !== "findings" || typeof path[1] !== "number") return "";

  const findings = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(findings)) return "";

  const id = (findings[path[1]] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? ` (finding ${id})` : "";
}

function describeIssues(issues: readonly z.core.$ZodIssue[], raw: unknown): string[] {
  const shown = issues.slice(0, MAX_REPORTED_PROBLEMS).map((issue) => describeIssue(issue, raw));
  const hidden = issues.length - shown.length;
  return hidden > 0 ? [...shown, `(+${hidden} more)`] : shown;
}

export function parseBoardMessage(raw: string): BoardParse {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    // Never rethrow: this runs inside an EventSource listener, where an
    // exception is an unhandled rejection in the browser and the board stops
    // updating with nothing said about why.
    return { ok: false, problems: ["payload is not valid JSON"] };
  }

  const parsed = boardMessageSchema.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data };

  return { ok: false, problems: describeIssues(parsed.error.issues, json) };
}

export type BoardUpdate = {
  // On a rejected payload this is the *same object* that was passed in, not a
  // copy. Reference identity is the guarantee: there is no code path that can
  // render half of a bad board, because the caller's state never moves.
  board: Board;
  changed: string[];
  problems: string[];
};

export function applyBoardMessage(current: Board, raw: string): BoardUpdate {
  const parsed = parseBoardMessage(raw);

  if (!parsed.ok) return { board: current, changed: [], problems: parsed.problems };

  return {
    board: { findings: parsed.message.findings, queue: parsed.message.queue },
    changed: parsed.message.changed,
    problems: [],
  };
}
