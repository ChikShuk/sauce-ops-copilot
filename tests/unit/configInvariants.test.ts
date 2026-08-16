import { describe, expect, it } from "vitest";
import {
  LLM_TIMEOUT_MS,
  MAX_LLM_ATTEMPTS,
  PROCESSING_TIMEOUT_MS,
} from "../../src/lib/config";

/**
 * A drift-catcher, not a bug-finder — and worth being explicit about that,
 * because a test that cannot currently fail is exactly the kind of thing that
 * pads a suite while proving nothing.
 *
 * PROCESSING_TIMEOUT_MS is today *derived* from the two constants below, so
 * this assertion passes trivially. It earns its place by failing the moment
 * someone replaces the derivation with a literal, or raises LLM_TIMEOUT_MS
 * without looking at what depends on it. The relationship was worked out
 * deliberately in slice 3, and the consequence of losing it is not a compile
 * error: it is a slow-but-healthy worker having its job reclaimed mid-LLM-call
 * by claimJob's stale branch, burning a retry it never earned and enriching the
 * same finding twice concurrently.
 */
describe("processing timeout vs the LLM budget", () => {
  it("leaves room for every LLM attempt before a claim goes stale", () => {
    expect(PROCESSING_TIMEOUT_MS).toBeGreaterThanOrEqual(LLM_TIMEOUT_MS * MAX_LLM_ATTEMPTS);
  });

  it("leaves margin beyond the LLM budget for the surrounding work", () => {
    // Correlation SQL, the event fetch and the disposition write all happen
    // inside the same claim. Equality would mean a job that used its full LLM
    // budget goes stale before it can write its own result.
    expect(PROCESSING_TIMEOUT_MS).toBeGreaterThan(LLM_TIMEOUT_MS * MAX_LLM_ATTEMPTS);
  });

  it("keeps the retry budget bounded", () => {
    expect(MAX_LLM_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MAX_LLM_ATTEMPTS).toBeLessThanOrEqual(3);
  });
});
