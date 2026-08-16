import { describe, expect, it } from "vitest";
import { applyBoardMessage, parseBoardMessage } from "../../src/lib/findings/boardPayload";
import type { Board, BoardMessage, FindingCard } from "../../src/lib/findings/types";

/**
 * The client's side of the SSE contract.
 *
 * These exist because the payload used to be `JSON.parse(...) as BoardMessage`
 * — an assertion the compiler believes and the runtime never checks — and a
 * card that reached the browser without one field crashed the whole board on a
 * decoration. Every case below is a field going missing, because that is the
 * failure that actually happened rather than one imagined for a test.
 */

const CARD: FindingCard = {
  id: "8f2c9d14-1f6a-4c0b-9a3e-2b7d5e6f0a11",
  restaurantId: "bellas_pizza",
  orderId: "order_5001",
  version: 2,
  status: "ready",
  priority: "critical",
  drivers: [{ signal: "delay_minutes", level: "critical", detail: "95 minute delay" }],
  issue: "Severe delivery delay",
  hasSummary: true,
  summarySource: "llm",
  llmUsage: { inputTokens: 1_473, outputTokens: 315, costMicrosUsd: 6_096 },
  extractedTags: ["late_delivery"],
  eventCount: 1,
  firstEventAt: "2026-08-16T04:10:00.000Z",
  lastEventAt: "2026-08-16T04:10:00.000Z",
  enrichedAt: "2026-08-16T04:10:46.000Z",
  enrichedVersion: 2,
  updatedAt: "2026-08-16T04:10:46.000Z",
  closedAt: null,
  reviewedAt: null,
  resolvedAt: null,
  retry: null,
};

const MESSAGE: BoardMessage = {
  type: "board",
  findings: [CARD],
  queue: { queued: 0, analyzing: 0, retrying: 0, failed: 0 },
  changed: [],
};

/** A payload with one field deleted from the first finding. */
function withoutCardField(field: keyof FindingCard): string {
  const card: Record<string, unknown> = { ...CARD };
  delete card[field];
  return JSON.stringify({ ...MESSAGE, findings: [card] });
}

function board(): Board {
  return { findings: [CARD], queue: MESSAGE.queue };
}

describe("parseBoardMessage: what a well-formed board looks like", () => {
  it("accepts a complete payload", () => {
    const parsed = parseBoardMessage(JSON.stringify(MESSAGE));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message).toEqual(MESSAGE);
  });

  it("ignores fields it does not know about", () => {
    // Forward compatibility, and the deliberate asymmetry: a newer server that
    // adds a field must not freeze an older tab, while a server that drops one
    // must be caught. Unknown keys are stripped rather than rejected.
    const parsed = parseBoardMessage(
      JSON.stringify({ ...MESSAGE, findings: [{ ...CARD, futureField: "hello" }] }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message.findings[0]).not.toHaveProperty("futureField");
  });
});

describe("parseBoardMessage: a missing field is a rejected board", () => {
  // The one that fails silently, and the reason this validation exists at all.
  // The board partitions on `resolvedAt === null`; an absent key is `undefined`,
  // which is not null, so an unresolved finding would drop out of the working
  // list and reappear under Resolved. No crash, no error — a live critical
  // finding an operator simply never sees.
  it("rejects a finding whose resolvedAt is absent rather than null", () => {
    const parsed = parseBoardMessage(withoutCardField("resolvedAt"));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems).toHaveLength(1);
      expect(parsed.problems[0]).toContain("findings[0].resolvedAt");
      // The finding id, dug out of the raw payload, is what makes the log line
      // actionable rather than merely alarming.
      expect(parsed.problems[0]).toContain(CARD.id);
    }
  });

  it("rejects a finding with no llmUsage key — the bug this was built for", () => {
    const parsed = parseBoardMessage(withoutCardField("llmUsage"));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]).toContain("findings[0].llmUsage");
  });

  it.each(["drivers", "extractedTags", "retry", "status", "priority"] as const)(
    "rejects a finding with no %s",
    (field) => {
      expect(parseBoardMessage(withoutCardField(field)).ok).toBe(false);
    },
  );

  it("rejects a payload whose findings are not a list", () => {
    const parsed = parseBoardMessage(JSON.stringify({ ...MESSAGE, findings: "none" }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]).toContain("findings");
  });

  it("reports malformed JSON instead of throwing", () => {
    // This runs inside an EventSource listener, where a thrown error is an
    // unhandled rejection and the board stops updating with nothing said.
    const parsed = parseBoardMessage("{not json");

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems).toEqual(["payload is not valid JSON"]);
  });

  it("caps how many problems it reports but not the count it admits to", () => {
    const findings = Array.from({ length: 9 }, (_, index) => {
      const card: Record<string, unknown> = { ...CARD, id: `finding-${index}` };
      delete card.resolvedAt;
      return card;
    });

    const parsed = parseBoardMessage(JSON.stringify({ ...MESSAGE, findings }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems).toHaveLength(6);
      expect(parsed.problems.at(-1)).toBe("(+4 more)");
    }
  });
});

describe("applyBoardMessage: the board holds", () => {
  it("replaces the board when the payload is good", () => {
    const current = board();
    const incoming: BoardMessage = {
      ...MESSAGE,
      findings: [{ ...CARD, version: 3 }],
      changed: [CARD.id],
    };

    const update = applyBoardMessage(current, JSON.stringify(incoming));

    expect(update.problems).toEqual([]);
    expect(update.changed).toEqual([CARD.id]);
    expect(update.board.findings[0].version).toBe(3);
  });

  it("keeps the previous board, by identity, when a field is missing", () => {
    const current = board();

    const update = applyBoardMessage(current, withoutCardField("resolvedAt"));

    // Reference equality, not deep equality. This is the guarantee: the caller's
    // state object is handed back untouched, so React bails out on identity and
    // there is no code path that can render half of a bad board.
    expect(update.board).toBe(current);
    expect(update.changed).toEqual([]);
    expect(update.problems[0]).toContain("resolvedAt");
  });

  it("keeps the previous board when the payload is not JSON at all", () => {
    const current = board();

    expect(applyBoardMessage(current, "").board).toBe(current);
  });

  it("does not partially apply a board where only one finding is malformed", () => {
    // The whole message is refused, not the offending row. A board missing one
    // finding is a board an operator would read as "that problem went away".
    const current = board();
    const good = { ...CARD, id: "good-finding" };
    const bad: Record<string, unknown> = { ...CARD, id: "bad-finding" };
    delete bad.resolvedAt;

    const update = applyBoardMessage(
      current,
      JSON.stringify({ ...MESSAGE, findings: [good, bad] }),
    );

    expect(update.board).toBe(current);
    expect(update.board.findings).toHaveLength(1);
    expect(update.board.findings[0].id).toBe(CARD.id);
  });
});
