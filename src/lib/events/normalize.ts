import { deriveIssueClass } from "./deriveIssueClass";
import type { IngestEventInput } from "./schema";

export type NewEventRow = {
  eventId: string;
  restaurantId: string;
  orderId: string | null;
  eventType: string;
  issueClass: string;
  occurredAt: Date;
  payload: unknown;
};

export function normalizeEvent(restaurantId: string, input: IngestEventInput): NewEventRow {
  return {
    eventId: input.event_id,
    restaurantId,
    orderId: input.order_id ?? null,
    eventType: input.event_type,
    issueClass: deriveIssueClass(input),
    occurredAt: new Date(input.occurred_at),
    payload: input.payload,
  };
}
