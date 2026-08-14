export const PRIORITY_LEVELS = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITY_LEVELS)[number];

// Every finding that exists is at least this.
export const BASE_PRIORITY: Priority = "low";

// Recurrence is counted over this window, anchored to the finding's own
// last_event_at rather than now() — otherwise reprocessing the same evidence
// tomorrow yields a different priority, which is both nondeterministic and
// makes the integration tests time-dependent.
export const RECURRENCE_WINDOW_MS = 24 * 60 * 60_000;

// The entire severity policy, in one table. Nothing else in the correlation
// path holds a threshold. Slice 9 tests these directly and the README quotes
// them verbatim, so they are deliberately data rather than conditionals.
//
// These are demo-appropriate placeholders — chosen to make the reference
// scenario and the simulator produce a legible spread of priorities, not tuned
// against any real distribution of restaurant incidents.
export const PRIORITY_THRESHOLDS = {
  // delivery_delay payloads, max across the evidence set. Ascending.
  delayMinutes: { medium: 20, high: 45, critical: 90 },
  // How much evidence the finding has accumulated. Ascending.
  eventCount: { medium: 2, high: 4, critical: 6 },
  // negative_review payloads, min across the evidence set. DESCENDING: a rating
  // at or below the value takes that level. No critical — one bad review is
  // never critical on its own; recurrence is what escalates it.
  reviewRating: { medium: 3, high: 2 },
  // Events at this restaurant sharing one issue_class within
  // RECURRENCE_WINDOW_MS. This is the "pattern" signal. Ascending.
  recurrence: { medium: 2, high: 3, critical: 5 },
} as const;

export type PriorityEvidence = {
  eventType: string;
  issueClass: string;
  occurredAt: Date;
  delayMinutes: number | null;
  rating: number | null;
};

export type PriorityInput = {
  // Assembled from finding_events. Never model output.
  evidence: readonly PriorityEvidence[];
  // issue_class -> count at this restaurant within RECURRENCE_WINDOW_MS of the
  // finding's last_event_at. Passed in rather than queried so this function
  // stays pure and unit-testable with no database.
  recurrenceByIssueClass: Readonly<Record<string, number>>;
};

export type PriorityDriver = {
  signal: "delay_minutes" | "event_count" | "review_rating" | "recurrence";
  level: Priority;
  detail: string;
};

export type PriorityScore = {
  priority: Priority;
  // Which signals fired, strongest first. This is the deterministic answer to
  // "why is this priority" — slice 5 hands it to the model as a given so the
  // summary narrates a fact instead of inventing a rationale.
  drivers: PriorityDriver[];
};

export function maxPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_LEVELS.indexOf(a) >= PRIORITY_LEVELS.indexOf(b) ? a : b;
}

function ascendingLevel(
  value: number,
  thresholds: { medium: number; high: number; critical?: number },
): Priority | null {
  if (thresholds.critical !== undefined && value >= thresholds.critical) return "critical";
  if (value >= thresholds.high) return "high";
  if (value >= thresholds.medium) return "medium";
  return null;
}

function descendingLevel(
  value: number,
  thresholds: { medium: number; high: number },
): Priority | null {
  if (value <= thresholds.high) return "high";
  if (value <= thresholds.medium) return "medium";
  return null;
}

// Priority is the MAX across signals, never a sum. That is what lets recurrence
// and event_count overlap without compounding: 3 events of one issue class (a
// pattern) outranks 3 of mixed classes (a busy hour), which is exactly what the
// issue_class taxonomy was set up to buy.
export function scorePriority(input: PriorityInput): PriorityScore {
  const drivers: PriorityDriver[] = [];

  const delays = input.evidence
    .map((e) => e.delayMinutes)
    .filter((v): v is number => v !== null);
  if (delays.length > 0) {
    const worst = Math.max(...delays);
    const level = ascendingLevel(worst, PRIORITY_THRESHOLDS.delayMinutes);
    if (level) {
      drivers.push({ signal: "delay_minutes", level, detail: `${worst} minute delay` });
    }
  }

  const countLevel = ascendingLevel(input.evidence.length, PRIORITY_THRESHOLDS.eventCount);
  if (countLevel) {
    drivers.push({
      signal: "event_count",
      level: countLevel,
      detail: `${input.evidence.length} related events`,
    });
  }

  const ratings = input.evidence.map((e) => e.rating).filter((v): v is number => v !== null);
  if (ratings.length > 0) {
    const worst = Math.min(...ratings);
    const level = descendingLevel(worst, PRIORITY_THRESHOLDS.reviewRating);
    if (level) {
      drivers.push({ signal: "review_rating", level, detail: `${worst}-star review` });
    }
  }

  for (const [issueClass, count] of Object.entries(input.recurrenceByIssueClass)) {
    const level = ascendingLevel(count, PRIORITY_THRESHOLDS.recurrence);
    if (level) {
      drivers.push({
        signal: "recurrence",
        level,
        detail: `${count} ${issueClass} events in 24h`,
      });
    }
  }

  drivers.sort((a, b) => PRIORITY_LEVELS.indexOf(b.level) - PRIORITY_LEVELS.indexOf(a.level));

  const priority = drivers.reduce<Priority>(
    (acc, driver) => maxPriority(acc, driver.level),
    BASE_PRIORITY,
  );

  return { priority, drivers };
}
