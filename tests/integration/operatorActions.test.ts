import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { recordAction } from "../../src/lib/actions/recordAction";
import { correlateEvent } from "../../src/lib/correlation/correlateEvent";
import { db } from "../../src/lib/db/client";
import { findingDetail, listFindings } from "../../src/lib/findings/queries";
import { processEvent } from "../../src/worker/processEvent";
import { eventRowById as eventRow, findingsFor } from "../helpers/db";
import { newRestaurantId, seedEvent } from "../helpers/factories";
import { stubProvider } from "../helpers/providers";

const AT = new Date("2026-08-14T20:10:00Z");

async function auditRows(findingId: string) {
  return db.execute<{
    action_type: string;
    note: string | null;
    actor: string;
    context: { version?: number; summary?: string; evidence_event_ids?: string[] } | null;
  }>(sql`
    SELECT action_type, note, actor, context
    FROM operator_actions
    WHERE finding_id = ${findingId}
    ORDER BY created_at ASC, id ASC;
  `);
}

async function seedFinding(restaurantId: string, occurredAt = AT) {
  const event = await seedEvent({ restaurantId, occurredAt, payload: { delay_minutes: 95 } });
  await processEvent(await eventRow(event.id), stubProvider());
  return (await findingsFor(restaurantId))[0];
}

describe("operator actions: resolving closes the finding for correlation", () => {
  // The behaviour docs/decisions.md records at slice 1 — tested rather than
  // reasoned about, because it is the partial unique index that enforces it.
  it("sets resolved_at and closed_at together", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);

    await recordAction(finding.id, { action_type: "mark_resolved" });

    const after = (await findingsFor(restaurantId))[0];
    expect(after.resolved_at).not.toBeNull();
    expect(after.closed_at).not.toBeNull();
  });

  it("makes the next event start a fresh finding instead of reopening this one", async () => {
    const restaurantId = newRestaurantId();
    const first = await seedFinding(restaurantId);
    await recordAction(first.id, { action_type: "mark_resolved" });

    // Well inside the 3-hour window, so without the close this would attach.
    const next = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    await processEvent(await eventRow(next.id), stubProvider());

    const findings = await findingsFor(restaurantId);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.event_count)).toEqual([1, 1]);
  });

  it("does not raise a unique violation — resolving removes a row from the partial index", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);

    await expect(
      recordAction(finding.id, { action_type: "mark_resolved" }),
    ).resolves.not.toBeNull();
  });

  it("returns null for a finding that does not exist", async () => {
    expect(
      await recordAction("00000000-0000-0000-0000-000000000000", {
        action_type: "mark_reviewed",
      }),
    ).toBeNull();
  });
});

describe("operator actions: the board partitions on resolved_at, never closed_at", () => {
  // The trap. Resolving sets both, but a finding whose rolling window merely
  // lapsed also has closed_at set — filtering on it would silently hide every
  // historical finding on the board.
  it("keeps a self-closed, operator-untouched finding visible and unresolved", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);

    // What correlation does when the window lapses: closed, never resolved.
    await db.execute(sql`UPDATE findings SET closed_at = now() WHERE id = ${finding.id};`);

    const card = (await listFindings()).find((item) => item.id === finding.id);
    expect(card?.closedAt).not.toBeNull();
    expect(card?.resolvedAt).toBeNull();
  });

  it("marks an operator-resolved finding as resolved on the card", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);
    await recordAction(finding.id, { action_type: "mark_resolved" });

    const card = (await listFindings()).find((item) => item.id === finding.id);
    expect(card?.resolvedAt).not.toBeNull();
  });
});

describe("operator actions: append-only log, first-write-wins state", () => {
  it("records both clicks but does not move reviewed_at", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);

    const first = await recordAction(finding.id, { action_type: "mark_reviewed" });
    const second = await recordAction(finding.id, { action_type: "mark_reviewed" });

    // The audit log keeps both — an operator re-reviewing after new evidence is
    // a real event, and a log that drops it is not a log.
    expect(await auditRows(finding.id)).toHaveLength(2);
    // The state records when it was FIRST triaged.
    expect(second?.reviewedAt).toBe(first?.reviewedAt);
  });

  it("does not move resolved_at on a second resolve", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);

    const first = await recordAction(finding.id, { action_type: "mark_resolved" });
    const second = await recordAction(finding.id, { action_type: "mark_resolved" });

    expect(second?.resolvedAt).toBe(first?.resolvedAt);
    expect(await auditRows(finding.id)).toHaveLength(2);
  });

  it("leaves finding state untouched for feedback", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);

    const result = await recordAction(finding.id, { action_type: "thumbs_down" });

    expect(result?.reviewedAt).toBeNull();
    expect(result?.resolvedAt).toBeNull();
    const after = (await findingsFor(restaurantId))[0];
    expect(after.status).toBe("ready");
  });
});

describe("operator actions: thumbs_down captures a usable eval example", () => {
  /**
   * The test that decides whether the feedback loop is worth anything.
   *
   * A finding's summary is overwritten by the next enrichment, so feedback
   * storing only finding_id points at prose that no longer exists. The snapshot
   * has to survive the rewrite.
   */
  it("keeps the judged summary after re-enrichment replaces it", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });
    await processEvent(await eventRow(event.id), stubProvider({ summary: "The old summary." }));

    const finding = (await findingsFor(restaurantId))[0];
    await recordAction(finding.id, {
      action_type: "thumbs_down",
      note: "said the delay was resolved, it wasn't",
    });

    // New evidence arrives and the model rewrites the prose.
    const second = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    await processEvent(
      await eventRow(second.id),
      stubProvider({ summary: "A completely different summary." }),
    );

    expect((await findingsFor(restaurantId))[0].summary).toBe(
      "A completely different summary.",
    );

    const [row] = await auditRows(finding.id);
    expect(row.context?.summary).toBe("The old summary.");
    expect(row.note).toBe("said the delay was resolved, it wasn't");
  });

  it("references evidence by id rather than copying it, in issue order", async () => {
    const restaurantId = newRestaurantId();
    const first = await seedEvent({ restaurantId, occurredAt: AT });
    await processEvent(await eventRow(first.id), stubProvider());
    const second = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    await processEvent(await eventRow(second.id), stubProvider());

    const finding = (await findingsFor(restaurantId))[0];
    await recordAction(finding.id, { action_type: "thumbs_down" });

    const [row] = await auditRows(finding.id);
    // Same order fetchEnrichmentSnapshot issues them in, so E1..En can be
    // reconstructed exactly. Events are immutable, so ids are enough.
    expect(row.context?.evidence_event_ids).toEqual([first.id, second.id]);
  });

  it("records the model and source so a bad summary can be attributed", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);
    await recordAction(finding.id, { action_type: "thumbs_down" });

    const [row] = await auditRows(finding.id);
    expect(row.context).toMatchObject({
      llm_model: "stub-model-1",
      summary_source: "llm",
      version: finding.version,
    });
  });

  it("keeps state actions cheap — no prose snapshot", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);
    await recordAction(finding.id, { action_type: "mark_reviewed" });

    const [row] = await auditRows(finding.id);
    expect(row.context).toMatchObject({ version: finding.version });
    expect(row.context?.summary).toBeUndefined();
  });
});

describe("operator actions: the detail panel can show what happened", () => {
  it("returns the history newest first, with the version each action saw", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);

    await recordAction(finding.id, { action_type: "mark_reviewed" });
    await recordAction(finding.id, { action_type: "thumbs_down", note: "too vague" });

    const detail = await findingDetail(finding.id);

    expect(detail?.actions).toHaveLength(2);
    expect(detail?.actions[0].actionType).toBe("thumbs_down");
    expect(detail?.actions[0].note).toBe("too vague");
    expect(detail?.actions[0].actor).toBe("operator");
    expect(detail?.actions[0].version).toBe(finding.version);
  });

  it("returns an empty history for an untouched finding", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);
    expect((await findingDetail(finding.id))?.actions).toEqual([]);
  });
});

describe("operator actions: correlation is unaffected by feedback", () => {
  it("still attaches new evidence to a merely reviewed finding", async () => {
    const restaurantId = newRestaurantId();
    const finding = await seedFinding(restaurantId);
    await recordAction(finding.id, { action_type: "mark_reviewed" });

    const next = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    const result = await correlateEvent(await eventRow(next.id));

    expect(result.outcome).toBe("attached");
    expect(result.findingId).toBe(finding.id);
  });
});
