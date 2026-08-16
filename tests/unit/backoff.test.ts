import { describe, expect, it } from "vitest";
import { computeNextAttemptAt } from "../../src/lib/queue/backoff";

const NOW = new Date("2026-08-14T20:00:00.000Z");

function delayMsFor(attempts: number): number {
  return computeNextAttemptAt(attempts, NOW).getTime() - NOW.getTime();
}

describe("computeNextAttemptAt", () => {
  // The schedule a job with the default max_attempts of 5 actually walks:
  // four waits between five attempts.
  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [4, 8_000],
  ])("attempt %i waits %i ms", (attempts, expected) => {
    expect(delayMsFor(attempts)).toBe(expected);
  });

  it("caps at five minutes rather than doubling without bound", () => {
    // 2 ** 19 seconds is about six days. Uncapped, a dead-lettered-by-timeout
    // job would be scheduled past any plausible retention window.
    expect(delayMsFor(20)).toBe(5 * 60_000);
    expect(delayMsFor(50)).toBe(5 * 60_000);
  });

  it("reaches the cap exactly where doubling would first exceed it", () => {
    expect(delayMsFor(9)).toBe(256_000);
    expect(delayMsFor(10)).toBe(300_000);
  });

  it("never goes backwards as attempts climb", () => {
    const delays = Array.from({ length: 15 }, (_, i) => delayMsFor(i + 1));
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });

  it("schedules forward from the clock it is given", () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(computeNextAttemptAt(1, later).getTime()).toBe(later.getTime() + 1_000);
  });
});
