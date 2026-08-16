import { STREAM_STALE_AFTER_MS } from "../config";

/**
 * What the dashboard's connection indicator says, decided in one pure function.
 *
 * **This module is client-safe and must stay that way.** It sits beside
 * broadcaster.ts, which reaches the database — importing anything from there
 * would pull Drizzle and the connection pool into the browser bundle. It
 * imports config.ts, which imports nothing.
 *
 * Four states, and the distinction between the last two is the whole point:
 *
 *   - `connecting`    — no stream yet.
 *   - `live`          — the stream is open and what it sends is usable.
 *   - `reconnecting`  — the transport is down. EventSource is retrying on its
 *                       own; nothing is arriving because there is no pipe.
 *   - `stale`         — the transport is fine and the data is not. Messages are
 *                       arriving and being refused, or nothing has arrived at
 *                       all for long enough that the server has plainly stopped
 *                       talking. The board on screen is real but frozen.
 *
 * They are different problems with different fixes — one is a network to wait
 * out, the other is a server sending something this client cannot read — and
 * collapsing them into "not live" would tell an operator to wait when they
 * should be escalating.
 *
 * A frozen board that looks live is the same class of silent failure as a
 * finding quietly filed under Resolved: the screen is confidently wrong and
 * nothing on it says so. That is why this exists at all.
 */
export type ConnectionState = "connecting" | "live" | "reconnecting" | "stale";

export type StreamHealth = {
  // What EventSource itself reports about the pipe.
  transport: "connecting" | "live" | "reconnecting";
  // When a board last parsed successfully, epoch ms. Null until one has.
  lastGoodBoardAt: number | null;
  // When the stream last showed any sign of life — a board or a heartbeat.
  // Distinct from the above because a healthy board that simply has no news
  // sends no boards: the broadcaster only emits when something changed, so
  // silence is normal and only *total* silence is a fault.
  lastSignalAt: number | null;
  // Whether the most recent board payload was refused by the schema.
  lastPayloadRejected: boolean;
};

export const INITIAL_STREAM_HEALTH: StreamHealth = {
  transport: "connecting",
  lastGoodBoardAt: null,
  lastSignalAt: null,
  lastPayloadRejected: false,
};

/**
 * `now` is null during server rendering, where there is no clock to compare
 * against — and a state that depended on wall time would differ between the
 * server's render and the browser's hydration pass anyway. Without a clock the
 * answer is whatever the transport says, never `stale`.
 */
export function deriveConnectionState(health: StreamHealth, now: number | null): ConnectionState {
  // Transport first: a dropped connection is the more fundamental fault, and
  // reporting it as staleness would point at the wrong thing to fix.
  if (health.transport !== "live") return health.transport;

  // Arriving and unreadable. This needs no clock — one refused payload with no
  // good one after it means the board on screen is already behind.
  if (health.lastPayloadRejected) return "stale";

  if (now === null || health.lastSignalAt === null) return "live";

  return now - health.lastSignalAt > STREAM_STALE_AFTER_MS ? "stale" : "live";
}
