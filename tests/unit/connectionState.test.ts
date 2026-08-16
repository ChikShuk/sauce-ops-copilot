import { describe, expect, it } from "vitest";
import { STREAM_STALE_AFTER_MS } from "../../src/lib/config";
import {
  INITIAL_STREAM_HEALTH,
  deriveConnectionState,
  type StreamHealth,
} from "../../src/lib/realtime/connection";

const NOW = Date.parse("2026-08-16T05:00:00.000Z");

function health(overrides: Partial<StreamHealth> = {}): StreamHealth {
  return {
    transport: "live",
    lastGoodBoardAt: NOW - 1_000,
    lastSignalAt: NOW - 1_000,
    lastPayloadRejected: false,
    ...overrides,
  };
}

describe("deriveConnectionState", () => {
  it("is live while boards keep arriving and parsing", () => {
    expect(deriveConnectionState(health(), NOW)).toBe("live");
  });

  it("stays live through a quiet stretch, as long as heartbeats land", () => {
    // The broadcaster only emits when the board changes, so silence is the
    // normal state of a healthy system with no news. A heartbeat seconds ago
    // and no board for an hour is a working dashboard, not a broken one.
    const quiet = health({ lastGoodBoardAt: NOW - 60 * 60_000, lastSignalAt: NOW - 2_000 });

    expect(deriveConnectionState(quiet, NOW)).toBe("live");
  });

  it("goes stale when nothing at all has arrived for long enough", () => {
    const silent = health({ lastSignalAt: NOW - (STREAM_STALE_AFTER_MS + 1) });

    expect(deriveConnectionState(silent, NOW)).toBe("stale");
  });

  it("does not go stale one beat early", () => {
    // A single dropped heartbeat must not raise an alarm — an indicator that
    // cries wolf is one an operator stops reading.
    const nearly = health({ lastSignalAt: NOW - (STREAM_STALE_AFTER_MS - 1) });

    expect(deriveConnectionState(nearly, NOW)).toBe("live");
  });

  it("goes stale the moment a payload is refused, without waiting for a clock", () => {
    // The failure this whole state exists for: messages arriving on a healthy
    // connection that the board cannot read. One refusal already means what is
    // on screen is behind.
    const refused = health({ lastPayloadRejected: true, lastSignalAt: NOW });

    expect(deriveConnectionState(refused, NOW)).toBe("stale");
  });

  it("recovers as soon as a good board lands", () => {
    const recovered = health({ lastPayloadRejected: false, lastSignalAt: NOW });

    expect(deriveConnectionState(recovered, NOW)).toBe("live");
  });

  it("reports a dropped transport as reconnecting, not stale", () => {
    // Different problems, different fixes: reconnecting is a network to wait
    // out, stale is a server saying something this page cannot use. Reporting
    // one as the other tells an operator to wait when they should escalate.
    const dropped = health({
      transport: "reconnecting",
      lastPayloadRejected: true,
      lastSignalAt: NOW - 10 * STREAM_STALE_AFTER_MS,
    });

    expect(deriveConnectionState(dropped, NOW)).toBe("reconnecting");
  });

  it("is connecting before the stream opens, however long that takes", () => {
    expect(deriveConnectionState(INITIAL_STREAM_HEALTH, NOW)).toBe("connecting");
  });

  it("never claims staleness without a clock", () => {
    // `now` is null during server rendering. A time-dependent answer there
    // would differ between the server's render and the browser's hydration.
    const silent = health({ lastSignalAt: NOW - 10 * STREAM_STALE_AFTER_MS });

    expect(deriveConnectionState(silent, null)).toBe("live");
  });

  it("still reports a refused payload without a clock", () => {
    // This one needs no wall time to be true, so SSR can say it safely.
    expect(deriveConnectionState(health({ lastPayloadRejected: true }), null)).toBe("stale");
  });
});
