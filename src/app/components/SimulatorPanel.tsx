"use client";

import { useCallback, useMemo, useState } from "react";
import type { FindingCard } from "@/lib/findings/types";
import {
  buildComplaint,
  buildDeliveryDelay,
  buildForceFailure,
  buildInjectionComplaint,
  buildReferenceScenario,
  buildRelatedEvent,
  sampleJsonBody,
  type SimulatorPost,
} from "@/lib/simulator/presets";

// Newest first, and short: this is a demo affordance, not an audit log. The
// board itself is the record of what happened.
const LOG_LIMIT = 12;

type LogEntry = {
  id: string;
  status: number;
  outcome: "created" | "duplicate" | "rejected" | "error";
  label: string;
  detail: string;
};

type IngestResponse = {
  status?: string;
  duplicate?: boolean;
  event_id?: string;
  id?: string;
  error?: string;
  message?: string;
  issues?: { path: string; message: string }[];
};

async function postEvent(post: SimulatorPost, label: string): Promise<LogEntry> {
  const entry = { id: crypto.randomUUID(), label };

  try {
    const res = await fetch(`/api/restaurants/${encodeURIComponent(post.restaurantId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(post.body),
    });

    const data = (await res.json()) as IngestResponse;

    if (res.ok && data.duplicate) {
      return {
        ...entry,
        status: res.status,
        outcome: "duplicate",
        // The whole point of surfacing this: say what did NOT happen. The
        // endpoint returns the original row's id, so the collision is nameable
        // rather than just asserted.
        detail: `Recognized as a duplicate of ${data.event_id} — no second event row, no second job, no new finding.`,
      };
    }

    if (res.ok) {
      return {
        ...entry,
        status: res.status,
        outcome: "created",
        detail: `${post.body.event_type} · ${post.restaurantId} · ${data.event_id}`,
      };
    }

    if (data.issues?.length) {
      return {
        ...entry,
        status: res.status,
        outcome: "rejected",
        detail: data.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      };
    }

    return {
      ...entry,
      status: res.status,
      outcome: "rejected",
      detail: data.message ?? data.error ?? "Rejected",
    };
  } catch (err) {
    return {
      ...entry,
      status: 0,
      outcome: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

const OUTCOME_STYLES: Record<LogEntry["outcome"], { className: string; label: string }> = {
  created: { className: "border-line text-ink-muted", label: "Accepted" },
  duplicate: { className: "border-warn-border bg-warn-bg text-warn-fg", label: "Duplicate" },
  rejected: { className: "border-danger-border text-danger-fg", label: "Rejected" },
  error: { className: "border-danger-border text-danger-fg", label: "Failed" },
};

export function SimulatorPanel({
  open,
  onToggle,
  selected,
  fallbackFinding,
  demoFailureEnabled,
}: {
  open: boolean;
  onToggle: () => void;
  selected: FindingCard | null;
  fallbackFinding: FindingCard | null;
  demoFailureEnabled: boolean;
}) {
  const [restaurantId, setRestaurantId] = useState("bellas_pizza");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [json, setJson] = useState(() => sampleJsonBody());
  // Each reference run needs its own restaurant, so a second click produces a
  // second pair of cards to compare rather than merging into the first.
  const [runCount, setRunCount] = useState(0);

  const append = useCallback((entries: LogEntry[]) => {
    setLog((current) => [...entries.reverse(), ...current].slice(0, LOG_LIMIT));
  }, []);

  const run = useCallback(
    async (key: string, posts: SimulatorPost[], label: string) => {
      setBusy(key);
      const entries: LogEntry[] = [];
      // Sequential, not Promise.all: the duplicate preset depends on its first
      // post having committed, and the reference scenarios are more legible on
      // the board when the cards appear in the order they were sent.
      for (const post of posts) {
        entries.push(await postEvent(post, label));
      }
      append(entries);
      setBusy(null);
    },
    [append],
  );

  // Prefer whatever the operator is looking at; fall back to the top card.
  const relatedTarget = selected ?? fallbackFinding;

  const referenceSuffix = useMemo(
    () => (runCount === 0 ? "" : `_${runCount + 1}`),
    [runCount],
  );

  async function runReferencePair(order: "chronological" | "out_of_order") {
    const key = `reference_${order}`;
    const target =
      order === "chronological"
        ? `bellas_pizza${referenceSuffix}`
        : `bellas_pizza_ooo${referenceSuffix}`;

    await run(
      key,
      buildReferenceScenario(target, order),
      order === "chronological" ? "Reference scenario" : "Reference scenario (out of order)",
    );

    if (order === "out_of_order") setRunCount((n) => n + 1);
  }

  async function submitJson() {
    setBusy("json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      append([
        {
          id: crypto.randomUUID(),
          status: 0,
          outcome: "error",
          label: "Custom JSON",
          detail: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
      setBusy(null);
      return;
    }

    // Deliberately unvalidated on the way out — the point of this box is to see
    // what the endpoint's own Zod validation says about arbitrary input.
    const post = { restaurantId, body: parsed } as SimulatorPost;
    append([await postEvent(post, "Custom JSON")]);
    setBusy(null);
  }

  return (
    <section className="shrink-0 border-b border-line">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-ink-muted hover:bg-surface"
      >
        <span aria-hidden className="text-ink-subtle">
          {open ? "▾" : "▸"}
        </span>
        Simulate events
        <span className="font-normal text-ink-subtle">
          post operational events and watch the board react
        </span>
      </button>

      {open && (
        <div className="max-h-[50vh] overflow-y-auto border-t border-line px-4 py-3">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <Group
              title="The assignment's reference scenario"
              note="Both post the same three events — a delay, a complaint 17 minutes later, and a review 2h15m after that. They converge on an identical finding: one card, three events, the same window. Arrival order does not change the result. Each run uses its own restaurant so the two cards sit side by side."
            >
              <Action
                busy={busy === "reference_chronological"}
                onClick={() => runReferencePair("chronological")}
              >
                Reference scenario
              </Action>
              <Action
                busy={busy === "reference_out_of_order"}
                onClick={() => runReferencePair("out_of_order")}
              >
                Reference scenario (out of order)
              </Action>
            </Group>

            <Group title="Single events" note={`Posted to ${restaurantId}.`}>
              <Action
                busy={busy === "delay"}
                onClick={() => run("delay", [buildDeliveryDelay(restaurantId)], "Delivery delay")}
              >
                Delivery delay
              </Action>
              <Action
                busy={busy === "complaint"}
                onClick={() => run("complaint", [buildComplaint(restaurantId)], "Complaint")}
              >
                Customer complaint
              </Action>
              <Action
                busy={busy === "duplicate"}
                onClick={() => {
                  // One click, two posts of an identical body: always shows
                  // 201 then 200 without depending on anything posted earlier.
                  const post = buildDeliveryDelay(restaurantId);
                  return run("duplicate", [post, post], "Duplicate");
                }}
              >
                Duplicate event
              </Action>
              <Action
                busy={busy === "related"}
                disabled={!relatedTarget}
                title={
                  relatedTarget
                    ? undefined
                    : "No findings on the board yet — there is nothing to relate an event to."
                }
                onClick={() =>
                  relatedTarget &&
                  run(
                    "related",
                    [buildRelatedEvent(relatedTarget.restaurantId)],
                    "Related event",
                  )
                }
              >
                {relatedTarget
                  ? `Related event → ${relatedTarget.restaurantId}`
                  : "Related event"}
              </Action>
            </Group>

            <Group
              title="Defences"
              note="Both of these are tested; these buttons make them watchable."
            >
              <Action
                busy={busy === "injection"}
                onClick={() =>
                  run(
                    "injection",
                    [buildInjectionComplaint(restaurantId)],
                    "Prompt injection",
                  )
                }
              >
                Prompt injection attempt
              </Action>
              {demoFailureEnabled && (
                <Action
                  busy={busy === "force_fail"}
                  onClick={() =>
                    run("force_fail", [buildForceFailure(restaurantId)], "Forced failure")
                  }
                >
                  Force a processing failure (~15s)
                </Action>
              )}
            </Group>

            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="sim-restaurant" className="text-xs text-ink-subtle">
                Restaurant
              </label>
              <input
                id="sim-restaurant"
                value={restaurantId}
                onChange={(event) => setRestaurantId(event.target.value)}
                className="rounded border border-line bg-canvas px-2 py-1 font-mono text-xs text-ink"
              />
              <span className="text-xs text-ink-subtle">
                Any value works — there is no tenant registry. Use a new one to watch a
                separate finding appear.
              </span>
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-ink-subtle hover:text-ink-muted">
                Post custom JSON
              </summary>
              <p className="mt-2 text-ink-subtle">
                Sent to the same endpoint with no client-side checking, so validation errors
                come back from the API&apos;s own schema.
              </p>
              <textarea
                value={json}
                onChange={(event) => setJson(event.target.value)}
                spellCheck={false}
                rows={10}
                className="mt-2 w-full rounded border border-line bg-surface p-2 font-mono text-xs text-ink"
              />
              <Action busy={busy === "json"} onClick={submitJson}>
                Post JSON
              </Action>
            </details>

            {log.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
                  Activity
                </p>
                <ul className="flex flex-col gap-1">
                  {log.map((entry) => {
                    const style = OUTCOME_STYLES[entry.outcome];
                    return (
                      <li
                        key={entry.id}
                        className={`rounded border px-2 py-1 text-xs ${style.className}`}
                      >
                        <span className="font-mono">{entry.status || "—"}</span>{" "}
                        <span className="font-medium">{style.label}</span>{" "}
                        <span className="text-ink-subtle">{entry.label}</span>
                        <p className="mt-0.5 break-words">{entry.detail}</p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</p>
      {note && <p className="mt-1 text-xs leading-relaxed text-ink-subtle">{note}</p>}
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Action({
  busy,
  disabled,
  title,
  onClick,
  children,
}: {
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className="rounded border border-line px-2.5 py-1.5 text-xs text-ink hover:bg-surface disabled:cursor-not-allowed disabled:text-ink-subtle disabled:hover:bg-transparent"
    >
      {busy ? "Posting…" : children}
    </button>
  );
}
