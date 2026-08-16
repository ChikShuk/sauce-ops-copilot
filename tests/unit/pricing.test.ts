import { describe, expect, it } from "vitest";
import { addUsage, priceUsage, totalInputTokens, ZERO_USAGE } from "../../src/lib/llm/pricing";
import type { TokenUsage } from "../../src/lib/llm/pricing";

// Every date is explicit. The rate table carries an introductory price that
// lapses on 2026-09-01, so a test that priced "now" would pass before that date
// and fail after it for reasons having nothing to do with the code.
const DURING_PROMO = new Date("2026-08-16T00:00:00.000Z");
const AFTER_PROMO = new Date("2026-09-01T00:00:00.000Z");

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { ...ZERO_USAGE, ...overrides };
}

describe("priceUsage", () => {
  it("prices a plain call at the rate in force on the day", () => {
    const call = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });

    // A million each: $2 + $10 introductory, $3 + $15 at list.
    expect(priceUsage("claude-sonnet-5", call, DURING_PROMO)).toBe(12_000_000);
    expect(priceUsage("claude-sonnet-5", call, AFTER_PROMO)).toBe(18_000_000);
  });

  it("lands whole micro-dollars for a typical enrichment", () => {
    // 1,200 in and 300 out at $2/$10: 2,400 + 3,000 micro-dollars. Exact,
    // because USD-per-million x tokens is already micro-dollars — no scaling
    // factor and nothing to round.
    expect(
      priceUsage("claude-sonnet-5", usage({ inputTokens: 1_200, outputTokens: 300 }), DURING_PROMO),
    ).toBe(5_400);
  });

  it("charges cache writes at 1.25x and reads at 0.1x input", () => {
    const call = usage({ inputTokens: 200, cacheWriteTokens: 1_000, cacheReadTokens: 4_000 });

    // (200 + 1,250 + 400) x $2 per million.
    expect(priceUsage("claude-sonnet-5", call, DURING_PROMO)).toBe(3_700);
  });

  it("returns null for a model it holds no rate for", () => {
    // Not 0. A finding priced at zero reads as a call that was free; null is
    // what makes the UI show tokens without a price.
    expect(priceUsage("claude-opus-5", usage({ inputTokens: 1_000 }), DURING_PROMO)).toBeNull();
    expect(priceUsage(null, usage({ inputTokens: 1_000 }), DURING_PROMO)).toBeNull();
  });

  it("does not match a model by prefix", () => {
    // A near-miss must read as "unknown model" rather than confidently billing
    // one model's tokens at another's rate.
    expect(priceUsage("claude-sonnet-5-20260101", usage({ inputTokens: 1_000 }), DURING_PROMO)).toBeNull();
  });
});

describe("usage arithmetic", () => {
  it("adds attempt totals", () => {
    const first = usage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 });
    const second = usage({ inputTokens: 200, outputTokens: 20, cacheWriteTokens: 7 });

    expect(addUsage(first, second)).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cacheWriteTokens: 7,
      cacheReadTokens: 5,
    });
  });

  it("counts every billed input token, cached or not", () => {
    expect(
      totalInputTokens(usage({ inputTokens: 200, cacheWriteTokens: 1_000, cacheReadTokens: 4_000 })),
    ).toBe(5_200);
  });
});
