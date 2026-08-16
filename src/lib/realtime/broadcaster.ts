import { BOARD_POLL_INTERVAL_MS } from "../config";
import { listFindings, queueCounts } from "../findings/queries";
import type { BoardMessage, FindingCard, QueueCounts } from "../findings/types";
import { logJson } from "../log";

/**
 * Every message is a complete, ordered board plus the ids that changed since
 * the last one.
 *
 * Sending the whole board rather than incremental patches is a deliberate
 * choice at this scale. It means a reconnect and an update travel the identical
 * code path, so "the client might have missed something while disconnected" is
 * not a state that exists — which is the whole answer to the brief's
 * disconnect-and-reconnect case. It also keeps the sort order server-side: the
 * board is ordered by the priority ranking in findings/queries.ts, and a client
 * that re-sorted locally would be a second implementation of that ordering,
 * free to drift.
 *
 * `changed` exists only so the UI can briefly highlight what moved. Nothing
 * about correctness depends on it.
 *
 * The shape itself now lives in `findings/types.ts` as a Zod schema, because
 * the client validates what arrives here rather than asserting it — and the
 * client cannot import this module, which reaches the database. This file
 * produces the message; that one defines it. Re-exported so existing importers
 * of the type are unaffected.
 */
export type { BoardMessage } from "../findings/types";

type Listener = (message: BoardMessage) => void;

type BoardState = {
  findings: FindingCard[];
  queue: QueueCounts;
  fingerprints: Map<string, string>;
};

// Everything a change can consist of, in one string. `version` covers
// correlation's writes (priority, drivers, counts, timestamps); `status` and
// `enriched_at` cover enrichment's, which deliberately never bump version; the
// retry fields come from the job rows behind the evidence and move
// independently of the finding itself.
function fingerprint(finding: FindingCard): string {
  return [
    finding.version,
    finding.status,
    finding.enrichedAt ?? "-",
    finding.enrichedVersion ?? "-",
    finding.hasSummary ? "s" : "-",
    finding.summarySource ?? "-",
    // Operator actions change no other field, so without these an action would
    // never reach a second browser watching the same board.
    finding.reviewedAt ?? "-",
    finding.resolvedAt ?? "-",
    finding.retry?.attempts ?? "-",
    finding.retry?.nextAttemptAt ?? "-",
  ].join("|");
}

function sameQueue(a: QueueCounts, b: QueueCounts): boolean {
  return (
    a.queued === b.queued &&
    a.analyzing === b.analyzing &&
    a.retrying === b.retrying &&
    a.failed === b.failed
  );
}

type Broadcaster = {
  listeners: Set<Listener>;
  state: BoardState | null;
  timer: ReturnType<typeof setInterval> | null;
  polling: boolean;
};

// Next's dev server re-evaluates modules on hot reload, which would otherwise
// leave a previous module instance's interval running against a Set nobody
// reads. One instance per process, parked somewhere HMR does not reach.
const globalKey = Symbol.for("sauce-ops-copilot.broadcaster");
const globalStore = globalThis as unknown as Record<symbol, Broadcaster | undefined>;

function broadcaster(): Broadcaster {
  const existing = globalStore[globalKey];
  if (existing) return existing;

  const created: Broadcaster = {
    listeners: new Set(),
    state: null,
    timer: null,
    polling: false,
  };
  globalStore[globalKey] = created;
  return created;
}

async function readBoard(previous: BoardState | null): Promise<{
  state: BoardState;
  changed: string[];
}> {
  const [findings, queue] = await Promise.all([listFindings(), queueCounts()]);

  const fingerprints = new Map<string, string>();
  const changed: string[] = [];

  for (const finding of findings) {
    const next = fingerprint(finding);
    fingerprints.set(finding.id, next);
    if (previous && previous.fingerprints.get(finding.id) !== next) {
      changed.push(finding.id);
    }
  }

  return { state: { findings, queue, fingerprints }, changed };
}

function emit(instance: Broadcaster, changed: string[]): void {
  if (!instance.state) return;

  const message: BoardMessage = {
    type: "board",
    findings: instance.state.findings,
    queue: instance.state.queue,
    changed,
  };

  for (const listener of instance.listeners) {
    listener(message);
  }
}

async function tick(instance: Broadcaster): Promise<void> {
  // A slow query must not stack ticks on top of each other. Skipping is safe
  // because each read is a full board, not a step in a sequence.
  if (instance.polling) return;
  instance.polling = true;

  try {
    const previous = instance.state;
    const { state, changed } = await readBoard(previous);
    instance.state = state;

    const removed = previous
      ? [...previous.fingerprints.keys()].some((id) => !state.fingerprints.has(id))
      : false;
    const queueMoved = previous ? !sameQueue(previous.queue, state.queue) : true;

    if (changed.length > 0 || removed || queueMoved) {
      emit(instance, changed);
    }
  } catch (err) {
    // Errors are values on polling paths, same as in the worker loop: one bad
    // read must not kill the stream for every connected browser.
    logJson({
      msg: "broadcast.poll_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    instance.polling = false;
  }
}

/**
 * Dev only, and only reachable through hot reload — but it produced a real,
 * silent failure, so it is guarded rather than commented about.
 *
 * The instance above deliberately survives a module reload because it is parked
 * on globalThis. A running interval does not survive it cleanly: the callback
 * closes over the *previous* module instance's `tick`, and therefore that
 * instance's `listFindings` and `toCard`. Because `instance.timer` is then
 * non-null, no later `subscribe` ever reinstalls it — so every polled board for
 * the rest of the process's life is produced by whatever the code looked like
 * when the timer was first armed.
 *
 * What that looks like from a browser: the connect message is built by the
 * current module and is correct, and every update after it is built by stale
 * code. When the stale code predates a field the client schema requires, the
 * client refuses all of them and the board freezes on the connect snapshot while
 * the operator keeps clicking things that visibly do nothing.
 *
 * Re-arming rather than clearing to null, because a reload with browsers still
 * attached would otherwise stop the board outright until each of them happened
 * to reconnect.
 */
function rearmPollerAfterModuleReload(): void {
  const instance = globalStore[globalKey];
  if (!instance?.timer) return;

  clearInterval(instance.timer);
  instance.timer =
    instance.listeners.size > 0
      ? setInterval(() => {
          void tick(instance);
        }, BOARD_POLL_INTERVAL_MS)
      : null;
}

rearmPollerAfterModuleReload();

/**
 * Attach a listener. Immediately delivers the current board, then keeps
 * delivering it whenever it changes. The poller runs only while at least one
 * listener is attached.
 */
export async function subscribe(listener: Listener): Promise<() => void> {
  const instance = broadcaster();

  // Always a fresh read, never the cached board.
  //
  // The poller stops when the last listener leaves, which freezes `state` at
  // whatever it held then. Serving that cache to the next client would hand a
  // reconnecting browser a snapshot from the moment it disconnected — the exact
  // failure the snapshot-on-connect design exists to prevent, and invisible
  // unless you actually disconnect and come back. One extra query per browser
  // connecting is not a cost worth reasoning about cache age for.
  const { state } = await readBoard(null);
  instance.state = state;

  instance.listeners.add(listener);

  // Nothing is highlighted on connect: for this client every card is new, and
  // flashing the entire board would train the operator to ignore the highlight.
  listener({
    type: "board",
    findings: state.findings,
    queue: state.queue,
    changed: [],
  });

  if (!instance.timer) {
    instance.timer = setInterval(() => {
      void tick(instance);
    }, BOARD_POLL_INTERVAL_MS);
  }

  return () => {
    instance.listeners.delete(listener);
    if (instance.listeners.size === 0 && instance.timer) {
      clearInterval(instance.timer);
      instance.timer = null;
    }
  };
}

/** The board as of right now. Used for the server-rendered first paint. */
export async function currentBoard(): Promise<{
  findings: FindingCard[];
  queue: QueueCounts;
}> {
  const { findings, queue } = (await readBoard(null)).state;
  return { findings, queue };
}
