import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { correlateEvent } from "../../src/lib/correlation/correlateEvent";
import { enrichFinding } from "../../src/lib/llm/enrichFinding";
import { processEvent } from "../../src/worker/processEvent";
import { runJob } from "../../src/worker/runJob";
import { eventRowById as eventRow, evidenceFor, findingsFor, jobFor } from "../helpers/db";
import { newRestaurantId, postEvent, seedEvent } from "../helpers/factories";
import {
  failingProvider,
  rawTextProvider,
  stubProvider,
  timingOutProvider,
} from "../helpers/providers";

const AT = new Date("2026-08-14T20:10:00Z");

describe("enrichment: the model path", () => {
  it("writes prose, actions, tags and citations, and moves the finding to ready", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });
    const provider = stubProvider();

    await processEvent(await eventRow(event.id), provider);

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.status).toBe("ready");
    expect(finding.issue).toBe("Stubbed issue");
    expect(finding.summary).toBe("Stubbed summary.");
    expect(finding.summary_source).toBe("llm");
    expect(finding.llm_model).toBe("stub-model-1");
    expect(finding.enriched_at).not.toBeNull();
    expect(finding.recommended_actions).toEqual([
      { type: "contact_customer", rationale: "Stubbed rationale." },
    ]);
    expect(finding.extracted_tags).toEqual(["other"]);
  });

  it("persists citations as real event ids drawn from the finding's own evidence", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });

    await processEvent(await eventRow(event.id), stubProvider());

    const finding = (await findingsFor(restaurantId))[0];
    const evidence = await evidenceFor(finding.id);

    expect(finding.cited_event_ids).toEqual([event.id]);
    for (const cited of finding.cited_event_ids ?? []) {
      expect(evidence).toContain(cited);
    }
  });

  it("leaves correlation's decisions untouched — it only writes prose", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT, payload: { delay_minutes: 60 } });

    const correlated = await correlateEvent(await eventRow(event.id));
    const before = (await findingsFor(restaurantId))[0];

    await enrichFinding(
      {
        findingId: correlated.findingId,
        expectedVersion: correlated.version,
        drivers: correlated.drivers,
      },
      stubProvider(),
    );

    const after = (await findingsFor(restaurantId))[0];
    expect(after.priority).toBe(before.priority);
    expect(after.event_count).toBe(before.event_count);
    // Enrichment must never bump the version — version is correlation-owned and
    // is what fences these writes.
    expect(after.version).toBe(before.version);
  });
});

describe("enrichment: failure is survivable", () => {
  // FAILURE TEST 1 — the model is down.
  it("falls back to the deterministic writer and still reaches ready", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });
    const provider = failingProvider();

    // Must not throw: an LLM outage is never a job failure.
    await expect(processEvent(await eventRow(event.id), provider)).resolves.toBeUndefined();

    const finding = (await findingsFor(restaurantId))[0];
    expect(provider.calls).toHaveLength(1);
    expect(finding.status).toBe("ready");
    expect(finding.summary_source).toBe("fallback");
    expect(finding.summary).toContain("without the language model");
    expect(finding.llm_model).toBeNull();
  });

  it("keeps evidence and priority intact on the degraded path", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT, payload: { delay_minutes: 95 } });

    await processEvent(await eventRow(event.id), failingProvider());

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.priority).toBe("critical");
    expect(await evidenceFor(finding.id)).toEqual([event.id]);
  });

  it("writes no citations on the degraded path rather than citing everything", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });

    await processEvent(await eventRow(event.id), failingProvider());

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.cited_event_ids).toBeNull();
  });

  // FAILURE TEST 2 — the model is up but talking nonsense.
  it("falls back when the model's output cannot be validated", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });

    await expect(
      processEvent(await eventRow(event.id), rawTextProvider("Sure! Here's a summary:")),
    ).resolves.toBeUndefined();

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.status).toBe("ready");
    expect(finding.summary_source).toBe("fallback");
  });

  /**
   * FAILURE TEST 3 — the model never answers.
   *
   * Distinct from "the provider is down" in one way that matters: a timeout is
   * a *successful* outcome for the job. The degrade already produced everything
   * the operator needs, so retrying would spend four more LLM budgets to
   * rewrite prose we already have. This runs through runJob rather than
   * processEvent because the disposition is the whole claim — and nothing else
   * in the suite asserts it.
   */
  it("degrades on an LLM timeout and marks the job succeeded, not for retry", async () => {
    const restaurantId = newRestaurantId();
    const response = await postEvent(restaurantId, {
      event_id: `evt_${randomUUID()}`,
      event_type: "delivery_delay",
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
      payload: { delay_minutes: 40 },
    });
    const eventId = response.body.id;
    if (eventId === undefined) throw new Error("ingestion returned no id");

    const provider = timingOutProvider();

    // Bounded drain rather than a single call: the queue is global, so this
    // worker may pick up a row another test left behind before it reaches ours.
    for (let i = 0; i < 10 && (await jobFor(eventId))?.status === "pending"; i += 1) {
      await runJob(`worker-${randomUUID().slice(0, 8)}`, provider);
    }

    const job = await jobFor(eventId);
    expect(job?.status).toBe("succeeded");
    expect(job?.attempts).toBe(1);
    expect(job?.last_error).toBeNull();

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.status).toBe("ready");
    expect(finding.summary_source).toBe("fallback");
    // The evidence and the priority never depended on the model.
    expect(finding.priority).not.toBeNull();
    expect(await evidenceFor(finding.id)).toEqual([eventId]);
  });
});

describe("enrichment: the version fence", () => {
  it("discards a write whose evidence set has since been superseded", async () => {
    const restaurantId = newRestaurantId();
    const first = await seedEvent({ restaurantId, occurredAt: AT });

    const correlated = await correlateEvent(await eventRow(first.id));
    await enrichFinding(
      { findingId: correlated.findingId, expectedVersion: correlated.version, drivers: [] },
      stubProvider({ issue: "First pass" }),
    );

    // A second event lands and bumps the version — as it would while a slow
    // model call was still in flight.
    const second = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    const reCorrelated = await correlateEvent(await eventRow(second.id));
    await enrichFinding(
      { findingId: reCorrelated.findingId, expectedVersion: reCorrelated.version, drivers: [] },
      stubProvider({ issue: "Second pass" }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let logged: string[];
    try {
      // The straggler finally returns, carrying the stale version.
      await enrichFinding(
        { findingId: correlated.findingId, expectedVersion: correlated.version, drivers: [] },
        stubProvider({ issue: "Stale pass" }),
      );
      // Read before restoring — mockRestore clears the recorded calls.
      logged = logSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      logSpy.mockRestore();
    }

    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.issue).toBe("Second pass");

    // The outcome alone can't prove the fence ran — "Second pass" would also be
    // the result if the stale write had simply never been attempted.
    expect(logged.some((line) => line.includes("enrichment.superseded"))).toBe(true);
  });

  it("does not even call the provider when the fence fails at claim time", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });
    const correlated = await correlateEvent(await eventRow(event.id));

    const provider = stubProvider();
    await enrichFinding(
      { findingId: correlated.findingId, expectedVersion: correlated.version - 1, drivers: [] },
      provider,
    );

    expect(provider.calls).toHaveLength(0);
    const finding = (await findingsFor(restaurantId))[0];
    expect(finding.status).toBe("accepted");
    expect(finding.summary).toBeNull();
  });

  it("puts a re-enriching finding back into processing while the model runs", async () => {
    const restaurantId = newRestaurantId();
    const first = await seedEvent({ restaurantId, occurredAt: AT });
    await processEvent(await eventRow(first.id), stubProvider());
    expect((await findingsFor(restaurantId))[0].status).toBe("ready");

    const second = await seedEvent({
      restaurantId,
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    const correlated = await correlateEvent(await eventRow(second.id));

    // Observe the status from inside the provider call — the window a dashboard
    // sees while the model is working. This is what makes accepted → processing
    // → ready a real transition rather than a label.
    let statusDuringCall: string | null = null;
    const observing = stubProvider({ issue: "Refreshed" });
    const inner = observing.enrich.bind(observing);
    observing.enrich = async (enrichmentInput) => {
      statusDuringCall = (await findingsFor(restaurantId))[0].status;
      return inner(enrichmentInput);
    };

    await enrichFinding(
      { findingId: correlated.findingId, expectedVersion: correlated.version, drivers: [] },
      observing,
    );

    expect(statusDuringCall).toBe("processing");

    const refreshed = (await findingsFor(restaurantId))[0];
    expect(refreshed.status).toBe("ready");
    expect(refreshed.issue).toBe("Refreshed");
    expect(refreshed.event_count).toBe(2);
  });
});

describe("enrichment: redelivery", () => {
  it("does not spend an LLM call on an event that changed nothing", async () => {
    const restaurantId = newRestaurantId();
    const event = await seedEvent({ restaurantId, occurredAt: AT });
    const row = await eventRow(event.id);

    const first = stubProvider();
    await processEvent(row, first);
    expect(first.calls).toHaveLength(1);

    // The worker's stale-reclaim path can hand the same event back.
    const second = stubProvider({ issue: "Should never be written" });
    await processEvent(row, second);

    expect(second.calls).toHaveLength(0);
    expect((await findingsFor(restaurantId))[0].issue).toBe("Stubbed issue");
  });
});
