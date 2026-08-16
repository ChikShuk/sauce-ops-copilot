import { describe, expect, it } from "vitest";
import type { BoardMessage } from "../../src/lib/realtime/broadcaster";
import { collector } from "../helpers/sse";

/**
 * A test for a test helper, which is normally a smell — except this one has
 * already been wrong once. The original waitForNext compared messages.length to
 * a copy of itself, so its "a message is already waiting" branch could never be
 * taken. Every SSE assertion in slice 9 is built on this helper, and a helper
 * that silently waits for the *next* message instead of returning the one that
 * already arrived turns a race into a hang, or worse, into a pass that asserted
 * on the wrong message.
 */
function board(changed: string[]): BoardMessage {
  return {
    type: "board",
    findings: [],
    queue: { queued: 0, analyzing: 0, retrying: 0, failed: 0 },
    changed,
  };
}

describe("collector", () => {
  it("returns a message that arrived before waitForNext was called", async () => {
    const sink = collector();
    sink.listener(board(["already-here"]));

    // Deliberately short: against the old helper this waited for a message that
    // was never coming and failed on the timeout instead of the assertion.
    const message = await sink.waitForNext(250);
    expect(message.changed).toEqual(["already-here"]);
  });

  it("hands back messages in arrival order, not just the latest", async () => {
    const sink = collector();
    sink.listener(board(["first"]));
    sink.listener(board(["second"]));

    expect((await sink.waitForNext(250)).changed).toEqual(["first"]);
    expect((await sink.waitForNext(250)).changed).toEqual(["second"]);
  });

  it("waits when nothing has arrived yet", async () => {
    const sink = collector();
    const pending = sink.waitForNext(1_000);

    setTimeout(() => sink.listener(board(["late"])), 10);

    expect((await pending).changed).toEqual(["late"]);
  });

  it("rejects rather than hanging when no message ever arrives", async () => {
    const sink = collector();
    await expect(sink.waitForNext(50)).rejects.toThrow(/no board message arrived/);
  });
});
