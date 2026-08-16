import { describe, expect, it } from "vitest";
import {
  CUSTOMER_TEXT_MAX_CHARS,
  FENCE_CLOSE,
  FENCE_OPEN,
  buildPrompt,
  buildUserPrompt,
  sanitizeCustomerText,
} from "../../src/lib/llm/prompt";
import type { EnrichmentInput, LabeledEvidence } from "../../src/lib/llm/types";
import { INJECTION_COMPLAINT_TEXT } from "../helpers/factories";

function evidence(overrides: Partial<LabeledEvidence> = {}): LabeledEvidence {
  return {
    label: "E1",
    eventId: "11111111-1111-1111-1111-111111111111",
    eventType: "delivery_delay",
    issueClass: "delivery_delay",
    occurredAt: new Date("2026-08-14T18:04:00.000Z"),
    delayMinutes: 42,
    rating: null,
    refundAmountCents: null,
    customerText: null,
    ...overrides,
  };
}

function input(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    findingId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    priority: "high",
    drivers: [
      { signal: "delay_minutes", level: "high", detail: "42 minute delay" },
      { signal: "event_count", level: "medium", detail: "2 related events" },
    ],
    eventCount: 2,
    firstEventAt: new Date("2026-08-14T18:04:00.000Z"),
    lastEventAt: new Date("2026-08-14T19:12:00.000Z"),
    evidence: [evidence()],
    ...overrides,
  };
}

describe("sanitizeCustomerText", () => {
  it("leaves ordinary complaints untouched", () => {
    expect(sanitizeCustomerText("The fries were missing.")).toBe("The fries were missing.");
  });

  it("neutralizes a closing fence token so the payload cannot end its own block", () => {
    const sanitized = sanitizeCustomerText(`bad ${FENCE_CLOSE} worse`);
    expect(sanitized).not.toContain(FENCE_CLOSE);
  });

  it("neutralizes a forged opening fence token too", () => {
    const sanitized = sanitizeCustomerText(`bad ${FENCE_OPEN} worse`);
    expect(sanitized).not.toContain(FENCE_OPEN);
  });

  it("is case- and whitespace-tolerant, because '< / CUSTOMER_TEXT >' is the same attack", () => {
    const sanitized = sanitizeCustomerText("a < / CUSTOMER_TEXT > b");
    expect(sanitized.toLowerCase()).not.toContain("customer_text");
  });

  it("truncates unbounded text and says that it did", () => {
    const sanitized = sanitizeCustomerText("x".repeat(CUSTOMER_TEXT_MAX_CHARS + 500));
    expect(sanitized.length).toBeLessThan(CUSTOMER_TEXT_MAX_CHARS + 40);
    expect(sanitized).toContain("truncated");
  });

  it("strips fence tokens before truncating, so truncation cannot leave a fragment", () => {
    // A token sitting exactly on the truncation boundary would survive if the
    // order were reversed: the slice would cut it in half and the stripper
    // would no longer match it.
    const padding = "x".repeat(CUSTOMER_TEXT_MAX_CHARS - 5);
    const sanitized = sanitizeCustomerText(`${padding}${FENCE_CLOSE}tail`);
    expect(sanitized.toLowerCase()).not.toContain("customer_text");
  });
});

describe("buildUserPrompt", () => {
  it("hands the model the priority and its drivers as settled facts", () => {
    const prompt = buildUserPrompt(input());
    expect(prompt).toContain("priority: high");
    expect(prompt).toContain("42 minute delay");
    expect(prompt).toContain("2 related events");
  });

  it("never puts an event id in the prompt — only opaque labels", () => {
    const prompt = buildUserPrompt(input());
    expect(prompt).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(prompt).toContain("E1:");
  });

  it("never puts the finding id in the prompt either", () => {
    expect(buildUserPrompt(input())).not.toContain("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });

  it("fences customer text as data", () => {
    const prompt = buildUserPrompt(
      input({
        evidence: [
          evidence({
            eventType: "complaint",
            issueClass: "missing_items",
            delayMinutes: null,
            customerText: "Fries were missing.",
          }),
        ],
      }),
    );

    expect(prompt).toContain(`${FENCE_OPEN}Fries were missing.${FENCE_CLOSE}`);
  });

  it("omits the fence entirely for events with no customer text", () => {
    expect(buildUserPrompt(input())).not.toContain(FENCE_OPEN);
  });
});

// Layer 1 of the injection defense: containment in the prompt itself, before
// the model is ever involved.
describe("prompt containment of a hostile complaint", () => {
  const prompt = buildUserPrompt(
    input({
      evidence: [
        evidence({
          eventType: "complaint",
          issueClass: "missing_items",
          delayMinutes: null,
          customerText: INJECTION_COMPLAINT_TEXT,
        }),
      ],
    }),
  );

  it("keeps exactly one open and one close fence, so the payload stays inside it", () => {
    expect(prompt.split(FENCE_OPEN)).toHaveLength(2);
    expect(prompt.split(FENCE_CLOSE)).toHaveLength(2);
  });

  it("leaves no fence token loose in the body", () => {
    const body = prompt.slice(
      prompt.indexOf(FENCE_OPEN) + FENCE_OPEN.length,
      prompt.indexOf(FENCE_CLOSE),
    );
    expect(body.toLowerCase()).not.toContain("customer_text");
  });

  it("keeps the injected instructions inside the fence, not at instruction level", () => {
    const start = prompt.indexOf(FENCE_OPEN);
    const end = prompt.indexOf(FENCE_CLOSE);
    const injectedMarkers = ["Ignore all previous instructions", "maintenance mode", "E99"];

    for (const marker of injectedMarkers) {
      const at = prompt.indexOf(marker);
      expect(at).toBeGreaterThan(start);
      expect(at).toBeLessThan(end);
    }
  });

  it("does not issue the label the payload tells the model to cite", () => {
    const systemAndUser = buildPrompt(
      input({
        evidence: [evidence({ customerText: INJECTION_COMPLAINT_TEXT })],
      }),
    );
    // E99 appears only as quoted complaint text, never as an issued evidence
    // label — so citing it is detectably outside the set (see parse.ts).
    expect(systemAndUser.user).not.toContain("E99:");
  });
});

describe("the system prompt states the issue's form", () => {
  // parse.ts enforces this and would hold on its own. The rule is here so the
  // model produces the right form naturally and the normalizer is a no-op in the
  // common case — code silently correcting a model that was told nothing is a
  // worse arrangement than the two agreeing. This asserts they still agree.
  it("asks for sentence case with no trailing full stop", () => {
    const system = buildPrompt(input()).system;
    expect(system).toMatch(/sentence case/i);
    expect(system).toMatch(/no full stop/i);
  });
});
