import { z } from "zod";

// occurred_at drives the rolling correlation window (findings.last_event_at
// >= occurred_at - 3h). An unbounded far-future value would create a
// finding whose window never lapses, so it never closes and silently
// swallows every later event at that restaurant (see
// findings_restaurant_id_open_key in src/lib/db/schema.ts). This is a
// correctness bound, not input hygiene.
const OCCURRED_AT_MAX_FUTURE_MS = 5 * 60_000;
const OCCURRED_AT_MAX_PAST_MS = 7 * 24 * 60 * 60_000;

// Shared across complaint.category and refund.reason — one taxonomy, not
// two. 'other' means "no structured signal" and never overrides
// issue_class (see deriveIssueClass.ts).
const issueCategory = z.enum(["missing_items", "wrong_order", "late_delivery", "other"]);

const base = {
  event_id: z.string().min(1).max(255),
  // restaurant_id comes from the route path, not the body — see route.ts.
  order_id: z.string().min(1).max(255).optional(),
  occurred_at: z.iso.datetime({ offset: true }).refine(
    (value) => {
      const t = new Date(value).getTime();
      const now = Date.now();
      return t <= now + OCCURRED_AT_MAX_FUTURE_MS && t >= now - OCCURRED_AT_MAX_PAST_MS;
    },
    { message: "occurred_at must be within 5 minutes in the future or 7 days in the past" },
  ),
};

const deliveryDelayPayload = z
  .object({
    delay_minutes: z.number().int().positive(),
  })
  .strict();

const complaintPayload = z
  .object({
    complaint_text: z.string().min(1),
    category: issueCategory.optional(),
  })
  .strict();

const refundPayload = z
  .object({
    refund_amount_cents: z.number().int().positive(),
    reason: issueCategory.optional(),
  })
  .strict();

const negativeReviewPayload = z
  .object({
    rating: z.number().int().min(1).max(5),
    review_text: z.string().min(1),
  })
  .strict();

export const ingestEventSchema = z.discriminatedUnion("event_type", [
  z
    .object({ ...base, event_type: z.literal("delivery_delay"), payload: deliveryDelayPayload })
    .strict(),
  z
    .object({ ...base, event_type: z.literal("complaint"), payload: complaintPayload })
    .strict(),
  z
    .object({ ...base, event_type: z.literal("refund"), payload: refundPayload })
    .strict(),
  z
    .object({ ...base, event_type: z.literal("negative_review"), payload: negativeReviewPayload })
    .strict(),
]);

export type IngestEventInput = z.infer<typeof ingestEventSchema>;
export type IssueCategory = z.infer<typeof issueCategory>;
