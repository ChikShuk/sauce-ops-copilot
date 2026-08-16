/**
 * What an enrichment cost, in money.
 *
 * Priced here — at the moment of the call — rather than derived in the UI from
 * a stored token count. A finding's cost is an accounting fact about a call
 * that already happened, so it must be fixed at the rate that was in force
 * then. Deriving it later would silently restate history every time Anthropic
 * changes a price, which is the same class of bug as recomputing an invoice
 * from today's tax rate.
 *
 * Costs are stored as integer micro-dollars (1e-6 USD). A single enrichment is
 * worth a few tenths of a cent, so cents are too coarse and floats accumulate
 * error the moment anything sums them.
 */

// Tokens as the provider reports them. Kept separate from the SDK's own usage
// type so the pricing rules are testable without constructing an SDK message,
// and so a second provider could feed the same function.
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

/** Attempt-level usage adds up: a rejected response still burned its tokens. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** Every input token the call was billed for, cached or not. */
export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
}

// Cache writes cost 1.25x base input (5-minute TTL — we never ask for the 1h
// one), reads cost 0.1x. Neither applies today: the prompt is per-finding and
// well under the 1024-token minimum cacheable prefix, so both counts come back
// zero. They are priced anyway because the alternative is a cost figure that
// silently goes wrong the day prompt caching becomes worth turning on.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

type ModelRate = {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  // Introductory pricing and the instant it lapses. Modelled rather than
  // hardcoded-as-current because the promo expires mid-project; without the
  // date the app would keep quoting the launch price forever.
  promo?: { inputUsdPerMTok: number; outputUsdPerMTok: number; endsAt: string };
};

// Anthropic list prices, USD per million tokens. Keyed on the exact id the API
// echoes back in `message.model`, never on a prefix — a near-miss should read
// as "unknown model, no price" rather than confidently bill Sonnet rates for
// an Opus call.
const RATES: Record<string, ModelRate> = {
  "claude-sonnet-5": {
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    promo: { inputUsdPerMTok: 2, outputUsdPerMTok: 10, endsAt: "2026-09-01T00:00:00Z" },
  },
};

function rateFor(model: string, at: Date): ModelRate | null {
  const rate = RATES[model];
  if (!rate) return null;
  if (rate.promo && at.getTime() < Date.parse(rate.promo.endsAt)) {
    return { inputUsdPerMTok: rate.promo.inputUsdPerMTok, outputUsdPerMTok: rate.promo.outputUsdPerMTok };
  }
  return rate;
}

/**
 * Cost in integer micro-dollars, or null for a model with no published rate
 * here. Null means "we don't know", which the UI shows as tokens without a
 * price — deliberately not 0, which would read as "this call was free".
 *
 * The arithmetic is exact by construction: USD/MTok x tokens lands directly in
 * micro-dollars, so an integer rate over an integer token count needs no
 * scaling factor and rounds only where a cache multiplier makes it fractional.
 */
export function priceUsage(
  model: string | null,
  usage: TokenUsage,
  at: Date = new Date(),
): number | null {
  if (model === null) return null;
  const rate = rateFor(model, at);
  if (!rate) return null;

  const inputMicros =
    (usage.inputTokens +
      usage.cacheWriteTokens * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * CACHE_READ_MULTIPLIER) *
    rate.inputUsdPerMTok;

  return Math.round(inputMicros + usage.outputTokens * rate.outputUsdPerMTok);
}
