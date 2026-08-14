const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

// Exponential, no jitter — a single worker process has no thundering herd
// to spread out, and jitter would only add non-determinism to verification.
// These are demo-appropriate placeholders, not tuned production values:
// with the default max_attempts of 5, the schedule actually exercised is
// 1s, 2s, 4s, 8s before the fifth failure dead-letters, so the 5m cap is
// never reached in practice.
export function computeNextAttemptAt(attempts: number, now = new Date()): Date {
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
  return new Date(now.getTime() + delay);
}
