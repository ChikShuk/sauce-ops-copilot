import { z } from "zod";
import { PRIORITY_LEVELS, type PriorityDriver } from "./priority";

// findings.priority_drivers is jsonb, so it is untyped on the way back out and
// gets a schema like every other boundary. Rows written before the column
// existed carry NULL, and a hand-edited row could carry anything — neither is
// worth failing a render over, so a bad value degrades to "no drivers" rather
// than throwing. The card has an explicit empty state for exactly that.
const priorityDriverSchema = z.object({
  signal: z.enum(["delay_minutes", "event_count", "review_rating", "recurrence"]),
  level: z.enum(PRIORITY_LEVELS),
  detail: z.string(),
});

const priorityDriversSchema = z.array(priorityDriverSchema);

export function parsePriorityDrivers(raw: unknown): PriorityDriver[] {
  const parsed = priorityDriversSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}
