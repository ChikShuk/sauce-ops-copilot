import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { POST } from "../../src/app/api/restaurants/[restaurantId]/events/route";
import { db } from "../../src/lib/db/client";

// Every test gets its own restaurant. restaurant_id is the schema's own
// isolation boundary — the partial unique index, the open-finding lookup and
// the recurrence count are all scoped by it — so two tests using different
// restaurants cannot interact by construction. It also makes "exactly one
// finding" a precise assertion rather than one that depends on an empty table.
export function newRestaurantId(): string {
  return `rest_${randomUUID()}`;
}

// The hostile complaint now lives in src/lib/simulator/presets.ts, because the
// simulator button posts it too and the demo must not be able to drift from the
// string the tests assert on. Re-exported here so the existing test imports
// stay put.
export { INJECTION_COMPLAINT_TEXT } from "../../src/lib/simulator/presets";
import { INJECTION_COMPLAINT_TEXT } from "../../src/lib/simulator/presets";

export function injectionComplaintPayload(): Record<string, unknown> {
  return { complaint_text: INJECTION_COMPLAINT_TEXT, category: "missing_items" };
}

export type IngestResponse = {
  status: number;
  body: { status?: string; duplicate?: boolean; event_id?: string; id?: string; error?: string };
};

/**
 * Posts an event through the real route handler.
 *
 * App Router handlers are plain (Request, context) => Response functions, so
 * this needs no server — and going through the handler rather than calling
 * enqueueEvent directly is the point: the duplicate response an operator's
 * browser actually sees is the status code and the `duplicate` flag, and
 * neither is produced anywhere else.
 */
export async function postEvent(
  restaurantId: string,
  body: unknown,
): Promise<IngestResponse> {
  const res = await POST(
    new Request(`http://test.local/api/restaurants/${restaurantId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ restaurantId }) },
  );

  return { status: res.status, body: await res.json() };
}

export type SeedEvent = {
  restaurantId: string;
  occurredAt: Date;
  eventType?: string;
  issueClass?: string;
  orderId?: string | null;
  payload?: Record<string, unknown>;
  eventId?: string;
};

export type SeededEvent = {
  id: string;
  eventId: string;
  restaurantId: string;
  orderId: string | null;
  eventType: string;
  issueClass: string;
  occurredAt: Date;
  payload: unknown;
};

// Inserts an events row directly, bypassing the ingestion endpoint — these
// tests exercise correlation, not HTTP validation.
export async function seedEvent(spec: SeedEvent): Promise<SeededEvent> {
  const eventId = spec.eventId ?? `evt_${randomUUID()}`;
  const eventType = spec.eventType ?? "delivery_delay";
  const issueClass = spec.issueClass ?? eventType;
  const orderId = spec.orderId ?? null;
  const payload = spec.payload ?? { delay_minutes: 10 };

  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO events (event_id, restaurant_id, order_id, event_type, issue_class, occurred_at, payload)
    VALUES (${eventId}, ${spec.restaurantId}, ${orderId}, ${eventType},
            ${issueClass}, ${spec.occurredAt.toISOString()}, ${JSON.stringify(payload)}::jsonb)
    RETURNING id;
  `);

  return {
    id: rows[0].id,
    eventId,
    restaurantId: spec.restaurantId,
    orderId,
    eventType,
    issueClass,
    occurredAt: spec.occurredAt,
    payload,
  };
}
