/**
 * Model spend, formatted for an operator rather than for an accountant.
 *
 * Both functions are deliberately lossy in the collapsed row and exact in the
 * expanded one: the row answers "is this a lot?", the panel answers "how much
 * exactly?". Rounding a token count in the row is fine; rounding the cost to
 * cents is not, because every enrichment here is worth well under one.
 */

/** `1450` -> `1.4k`. Exact below a thousand, one decimal above. */
export function formatTokensCompact(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const thousands = tokens / 1_000;
  // 9,950 must not render as "10.0k" while 10,000 renders as "10k" — round
  // first, then decide how many digits that rounded value deserves.
  const rounded = Math.round(thousands * 10) / 10;
  return rounded >= 100 ? `${Math.round(rounded)}k` : `${rounded}k`;
}

/** `1450` -> `1,450`. */
export function formatTokensExact(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

/**
 * Micro-dollars to a dollar string, with enough digits to stay honest.
 *
 * A single enrichment costs a few tenths of a cent, so `$0.00` would be the
 * answer for essentially every finding on the board — a number that is
 * technically rounded and practically a lie. Four decimals below a dollar keeps
 * the figure real; above a dollar the cents are what matter.
 */
export function formatUsdMicros(micros: number): string {
  const usd = micros / 1_000_000;
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
