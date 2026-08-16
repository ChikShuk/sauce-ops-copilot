import { describe, expect, it } from "vitest";
import { RELATIVE_LIMIT_MS, formatRelative } from "../../src/lib/format";

// A fixed "now" and offsets from it, so every case reads as an age rather than
// as a pair of timestamps to subtract by eye.
const NOW = Date.parse("2026-08-16T20:00:00.000Z");

function ago({ d = 0, h = 0, m = 0, s = 0 }): string {
  const ms = ((d * 24 + h) * 60 + m) * 60_000 + s * 1_000;
  return formatRelative(new Date(NOW - ms).toISOString(), NOW);
}

describe("formatRelative: the bands", () => {
  it("says just now below the threshold where a number would be noise", () => {
    expect(ago({ s: 0 })).toBe("just now");
    expect(ago({ s: 44 })).toBe("just now");
  });

  it("holds at one minute across the 45s-90s slice", () => {
    expect(ago({ s: 45 })).toBe("1 min ago");
    expect(ago({ s: 89 })).toBe("1 min ago");
  });

  it("counts exact minutes up to the hour", () => {
    expect(ago({ s: 90 })).toBe("1 min ago");
    expect(ago({ m: 12 })).toBe("12 min ago");
    expect(ago({ m: 59, s: 59 })).toBe("59 min ago");
  });

  // The fix. Every value in this hour used to render as "1 hour ago".
  it("keeps minutes past the hour boundary", () => {
    expect(ago({ h: 1 })).toBe("1h ago");
    expect(ago({ h: 1, m: 1 })).toBe("1h 1m ago");
    expect(ago({ h: 1, m: 35 })).toBe("1h 35m ago");
    expect(ago({ h: 1, m: 59, s: 59 })).toBe("1h 59m ago");
    expect(ago({ h: 8, m: 5 })).toBe("8h 5m ago");
  });

  it("drops a zero minute rather than printing it", () => {
    expect(ago({ h: 2 })).toBe("2h ago");
    expect(ago({ h: 23 })).toBe("23h ago");
  });

  it("stays relative right up to the day limit", () => {
    expect(ago({ h: 23, m: 59 })).toBe("23h 59m ago");
  });

  // Clock skew between the browser and the server, or an occurred_at a few
  // seconds ahead of it. A negative age must never render as one.
  it("treats a future timestamp as now", () => {
    expect(formatRelative(new Date(NOW + 30_000).toISOString(), NOW)).toBe("just now");
    expect(formatRelative(new Date(NOW + 60 * 60_000).toISOString(), NOW)).toBe("just now");
  });
});

describe("formatRelative: properties that matter more than any one string", () => {
  // The bug this replaced was Math.round, which reported 1h50m as "2h ago" and
  // 90s as "2 min ago" — an incident shown as older than it is, which on an ops
  // board reads as something that has stopped mattering.
  it("never reports an age past the time that has actually elapsed", () => {
    const cases: { label: string; ms: number; maxHours: number; maxMinutes: number }[] = [
      { label: "1h50m", ms: 110 * 60_000, maxHours: 1, maxMinutes: 50 },
      { label: "1h59m", ms: 119 * 60_000, maxHours: 1, maxMinutes: 59 },
      { label: "23h59m", ms: (23 * 60 + 59) * 60_000, maxHours: 23, maxMinutes: 59 },
    ];

    for (const { label, ms, maxHours, maxMinutes } of cases) {
      const rendered = formatRelative(new Date(NOW - ms).toISOString(), NOW);
      const match = /^(\d+)h(?: (\d+)m)? ago$/.exec(rendered);

      expect(match, `${label} rendered as "${rendered}"`).not.toBeNull();
      const hours = Number(match?.[1]);
      const minutes = Number(match?.[2] ?? 0);

      expect(hours).toBe(maxHours);
      expect(minutes).toBeLessThanOrEqual(maxMinutes);
      expect(hours * 60 + minutes).toBeLessThanOrEqual(ms / 60_000);
    }
  });

  it("never goes backwards as a finding ages", () => {
    // One sample a minute across the whole relative range, converted back to the
    // elapsed time each string claims. A band boundary that renders a smaller
    // age than the band before it is the failure this catches.
    let previous = -1;

    for (let minutes = 1; minutes <= RELATIVE_LIMIT_MS / 60_000; minutes += 1) {
      const rendered = formatRelative(new Date(NOW - minutes * 60_000).toISOString(), NOW);
      const claimed = claimedMinutes(rendered);

      expect(claimed, `at ${minutes}m the format read "${rendered}"`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = claimed;
    }
  });
});

// Reads a rendered string back into the number of minutes it claims, so the
// monotonicity check compares quantities rather than text.
function claimedMinutes(rendered: string): number {
  if (rendered === "just now") return 0;

  const hoursAndMinutes = /^(\d+)h(?: (\d+)m)? ago$/.exec(rendered);
  if (hoursAndMinutes) {
    return Number(hoursAndMinutes[1]) * 60 + Number(hoursAndMinutes[2] ?? 0);
  }

  const minutesOnly = /^(\d+) min ago$/.exec(rendered);
  if (minutesOnly) return Number(minutesOnly[1]);

  const days = /^(\d+)d ago$/.exec(rendered);
  if (days) return Number(days[1]) * 24 * 60;

  throw new Error(`unrecognised relative format: "${rendered}"`);
}
