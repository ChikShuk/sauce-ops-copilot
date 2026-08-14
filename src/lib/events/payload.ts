import { z } from "zod";

// events.payload is untyped jsonb whose shape varies by event_type, so every
// read of it is lenient: a malformed field yields null rather than throwing. A
// bad payload must not cost a finding its summary, and must not blank a
// dashboard row either.
//
// Extracted here once enrichment and the dashboard both needed it — two
// implementations, so the shared one is now warranted rather than premature.
// Deliberately NOT used by correlation: correlation/evidence.ts drops payload
// entirely so nothing in that path can start branching on free text.
const delayPayload = z.object({ delay_minutes: z.number() });
const ratingPayload = z.object({ rating: z.number() });
const refundPayload = z.object({ refund_amount_cents: z.number() });
const complaintPayload = z.object({ complaint_text: z.string() });
const reviewPayload = z.object({ review_text: z.string() });

export function readDelayMinutes(payload: unknown): number | null {
  const parsed = delayPayload.safeParse(payload);
  return parsed.success ? parsed.data.delay_minutes : null;
}

export function readRating(payload: unknown): number | null {
  const parsed = ratingPayload.safeParse(payload);
  return parsed.success ? parsed.data.rating : null;
}

export function readRefundAmountCents(payload: unknown): number | null {
  const parsed = refundPayload.safeParse(payload);
  return parsed.success ? parsed.data.refund_amount_cents : null;
}

// Customer-authored text. Every consumer treats this as untrusted: the prompt
// builder fences it, the dashboard renders it as text and never as markup.
export function readCustomerText(eventType: string, payload: unknown): string | null {
  if (eventType === "complaint") {
    const parsed = complaintPayload.safeParse(payload);
    return parsed.success ? parsed.data.complaint_text : null;
  }

  if (eventType === "negative_review") {
    const parsed = reviewPayload.safeParse(payload);
    return parsed.success ? parsed.data.review_text : null;
  }

  return null;
}
