import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_CHARS,
  OPERATOR_ACTION_TYPES,
  operatorActionSchema,
} from "../../src/lib/actions/schema";

describe("operator action schema", () => {
  it.each(OPERATOR_ACTION_TYPES)("accepts %s", (actionType) => {
    expect(operatorActionSchema.safeParse({ action_type: actionType }).success).toBe(true);
  });

  // thumbs_up is permitted by the CHECK constraint and deliberately not shipped:
  // it changes no state, and a positive signal is close to unactionable without
  // a baseline. This asserts the omission is intentional rather than an oversight
  // waiting to be "fixed".
  it("rejects thumbs_up, which the database allows but no button produces", () => {
    expect(operatorActionSchema.safeParse({ action_type: "thumbs_up" }).success).toBe(false);
  });

  it("rejects an action type outside the enum entirely", () => {
    expect(operatorActionSchema.safeParse({ action_type: "delete_finding" }).success).toBe(
      false,
    );
  });

  // strictObject: an extra key is a validation failure, not silently dropped.
  it("rejects unknown keys", () => {
    const result = operatorActionSchema.safeParse({
      action_type: "mark_reviewed",
      actor: "admin",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an optional trimmed note and rejects an empty one", () => {
    expect(
      operatorActionSchema.safeParse({ action_type: "thumbs_down", note: "  too vague  " }),
    ).toMatchObject({ success: true, data: { note: "too vague" } });

    expect(
      operatorActionSchema.safeParse({ action_type: "thumbs_down", note: "   " }).success,
    ).toBe(false);
  });

  it("bounds the note so an audit log can't be used as a text store", () => {
    expect(
      operatorActionSchema.safeParse({
        action_type: "thumbs_down",
        note: "x".repeat(MAX_NOTE_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  // The shipped set is narrower than the CHECK constraint on purpose, so every
  // value it does permit must be one the database will accept.
  it("only permits values the database CHECK constraint allows", () => {
    const allowedByDb = ["mark_reviewed", "mark_resolved", "thumbs_down", "thumbs_up"];
    for (const actionType of OPERATOR_ACTION_TYPES) {
      expect(allowedByDb).toContain(actionType);
    }
  });
});
