"use client";

import { useCallback, useMemo, useState } from "react";
import {
  BracesIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  Link2Icon,
  ListOrderedIcon,
  LoaderCircleIcon,
  MessageSquareWarningIcon,
  ShieldAlertIcon,
  ShuffleIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FindingCard } from "@/lib/findings/types";
import type { ProviderName, ProviderToggleState } from "@/lib/settings/types";
import { cn } from "@/lib/utils";
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
import { labelEventType, labelRestaurant } from "@/lib/format";
import { Tip } from "./Tip";
import { SIMULATOR_TIPS } from "./tips";

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
        // The whole point of surfacing this: say what did NOT happen. Names the
        // original *row's* id rather than the client-supplied event_id — the
        // latter is identical in both posts by definition, so printing it says
        // only "you sent this twice", while the row id says which stored row the
        // second post collided with and is the value you would go and query.
        detail: `Recognized as a duplicate of row ${data.id} — no second event row, no second job, no new finding.`,
      };
    }

    if (res.ok) {
      return {
        ...entry,
        status: res.status,
        outcome: "created",
        // The event id stays raw on purpose — it is the value you would grep
        // the logs or the database for. The type and restaurant are read, not
        // looked up, so they get their display forms.
        detail: `${labelEventType(post.body.event_type)} · ${labelRestaurant(post.restaurantId)} · ${data.event_id}`,
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
  created: { className: "bg-surface text-ink-muted", label: "Accepted" },
  duplicate: { className: "bg-warn-bg text-warn-fg", label: "Duplicate" },
  rejected: { className: "bg-danger-bg text-danger-fg", label: "Rejected" },
  error: { className: "bg-danger-bg text-danger-fg", label: "Failed" },
};

/**
 * The sidebar's body: every way to put an event into the system.
 *
 * It lives in a permanent sidebar rather than a collapsible strip above the
 * board, so it never competes with the findings list for vertical space and a
 * reviewer never has to discover it. Each control carries an InfoTip saying what
 * it posts and what to expect, which is what makes the board explain itself.
 */
export function SimulatorPanel({
  selected,
  fallbackFinding,
  demoFailureEnabled,
  providerToggle,
}: {
  selected: FindingCard | null;
  fallbackFinding: FindingCard | null;
  demoFailureEnabled: boolean;
  providerToggle: ProviderToggleState;
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
    <div className="flex flex-col gap-6">
      {providerToggle.enabled && <ProviderSwitch state={providerToggle} />}

      <Group
        title="Reference scenario"
        // Says where these post, because they are the two buttons that ignore
        // Target and the only way to discover that was to change Target, click,
        // and be surprised. They have to own their restaurants: correlation
        // allows one open finding per restaurant, so a shared target would merge
        // the two runs into a single six-event finding and the convergence claim
        // — the whole point of shipping both — would have nothing left to show.
        note="The assignment's three events, in order and shuffled. Each button posts to its own restaurant and ignores Target, so the two runs stay separate and comparable."
      >
        <Action
          busy={busy === "reference_chronological"}
          icon={<ListOrderedIcon className="size-4" />}
          infoLabel="Reference scenario"
          info={SIMULATOR_TIPS.referenceChronological}
          onClick={() => runReferencePair("chronological")}
        >
          In order
        </Action>
        <Action
          busy={busy === "reference_out_of_order"}
          icon={<ShuffleIcon className="size-4" />}
          infoLabel="Reference scenario, out of order"
          info={SIMULATOR_TIPS.referenceOutOfOrder}
          onClick={() => runReferencePair("out_of_order")}
        >
          Out of order
        </Action>
      </Group>

      {/* Related event is the exception and the note says so: it posts to the
          open finding's restaurant, not to Target, because an event "related to
          an existing finding" has to land where that finding already is. Its
          own label names the destination too. */}
      <Group
        title="Single events"
        note={`Posted to ${labelRestaurant(restaurantId)} — except Related event, which goes to the open finding's restaurant.`}
      >
        <Action
          busy={busy === "delay"}
          icon={<ClockIcon className="size-4" />}
          infoLabel="Delivery delay"
          info={SIMULATOR_TIPS.delay}
          onClick={() => run("delay", [buildDeliveryDelay(restaurantId)], "Delivery delay")}
        >
          Delivery delay
        </Action>
        <Action
          busy={busy === "complaint"}
          icon={<MessageSquareWarningIcon className="size-4" />}
          infoLabel="Customer complaint"
          info={SIMULATOR_TIPS.complaint}
          onClick={() => run("complaint", [buildComplaint(restaurantId)], "Complaint")}
        >
          Customer complaint
        </Action>
        <Action
          busy={busy === "duplicate"}
          icon={<CopyIcon className="size-4" />}
          infoLabel="Duplicate event"
          info={SIMULATOR_TIPS.duplicate}
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
          icon={<Link2Icon className="size-4" />}
          disabled={!relatedTarget}
          title={
            relatedTarget
              ? undefined
              : "No findings on the board yet — there is nothing to relate an event to."
          }
          infoLabel="Related event"
          info={SIMULATOR_TIPS.related}
          onClick={() =>
            relatedTarget &&
            run("related", [buildRelatedEvent(relatedTarget.restaurantId)], "Related event")
          }
        >
          {relatedTarget
            ? `Related → ${labelRestaurant(relatedTarget.restaurantId)}`
            : "Related event"}
        </Action>
      </Group>

      {/* These two do honour Target, so they say the same thing Single events
          does rather than staying silent — after the group above, silence about
          the destination is what now reads as "this one ignores it". */}
      <Group
        title="Defences"
        note={`Posted to ${labelRestaurant(restaurantId)}. Both are tested; these buttons make them watchable.`}
      >
        <Action
          busy={busy === "injection"}
          icon={<ShieldAlertIcon className="size-4" />}
          infoLabel="Prompt injection attempt"
          info={SIMULATOR_TIPS.injection}
          onClick={() =>
            run("injection", [buildInjectionComplaint(restaurantId)], "Prompt injection")
          }
        >
          Prompt injection
        </Action>
        {demoFailureEnabled && (
          <Action
            busy={busy === "force_fail"}
            icon={<ZapIcon className="size-4" />}
            infoLabel="Forced processing failure"
            info={SIMULATOR_TIPS.forceFail}
            onClick={() => run("force_fail", [buildForceFailure(restaurantId)], "Forced failure")}
          >
            Force a failure (~15s)
          </Action>
        )}
      </Group>

      <Group title="Target">
        <div className="flex items-center gap-1">
          <label htmlFor="sim-restaurant" className="sr-only">
            Restaurant
          </label>
          <Input
            id="sim-restaurant"
            value={restaurantId}
            onChange={(event) => setRestaurantId(event.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 font-mono text-meta"
          />
          <Tip label="Restaurant" wide>
            {SIMULATOR_TIPS.restaurant}
          </Tip>
        </div>
      </Group>

      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-meta font-semibold uppercase tracking-wider text-ink-subtle hover:text-ink-muted">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90"
          />
          Custom JSON
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            value={json}
            onChange={(event) => setJson(event.target.value)}
            spellCheck={false}
            rows={10}
            aria-label="Custom event JSON"
            className="font-mono text-meta"
          />
          <Action
            busy={busy === "json"}
            icon={<BracesIcon className="size-4" />}
            infoLabel="Custom JSON"
            info={SIMULATOR_TIPS.customJson}
            onClick={submitJson}
          >
            Post JSON
          </Action>
        </div>
      </details>

      {log.length > 0 && (
        <div>
          <p className="mb-2 text-meta font-semibold uppercase tracking-wider text-ink-subtle">
            Activity
          </p>
          <ul className="flex flex-col gap-1.5">
            {log.map((entry) => {
              const style = OUTCOME_STYLES[entry.outcome];
              return (
                <li key={entry.id} className={cn("rounded-sm px-2.5 py-2", style.className)}>
                  <p className="flex items-baseline gap-1.5 text-meta">
                    <span className="font-mono">{entry.status || "—"}</span>
                    <span className="font-medium">{style.label}</span>
                    <span className="truncate text-ink-subtle">{entry.label}</span>
                  </p>
                  <p className="mt-1 break-words text-meta leading-relaxed">{entry.detail}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Which writer produces the prose, switched at runtime.
 *
 * The value lives in Postgres rather than in this component, because the process
 * that acts on it is the worker and it is not this one. The button writes a row;
 * the worker reads that row on its next enrichment. No restart, no signal, no
 * shared cache — the two processes already agree on a database.
 *
 * State is local after the write. A second browser tab keeps showing what it
 * loaded with until it reloads, which is cosmetic: the enrichment itself is
 * always correct because the worker reads the row per call, never the UI.
 */
function ProviderSwitch({ state }: { state: ProviderToggleState }) {
  const [active, setActive] = useState<ProviderName>(state.active);
  const [source, setSource] = useState(state.source);
  const [busy, setBusy] = useState<ProviderName | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(provider: ProviderName) {
    if (provider === active || busy !== null) return;

    setBusy(provider);
    setError(null);

    try {
      const res = await fetch("/api/settings/provider", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json()) as {
        name?: ProviderName;
        source?: "override" | "env";
        message?: string;
      };

      if (!res.ok || !data.name || !data.source) {
        setError(data.message ?? "Could not switch the provider.");
        return;
      }

      setActive(data.name);
      setSource(data.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Group title="Model">
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 gap-1 rounded-xl bg-surface p-1">
          <SwitchOption
            label="Real model"
            selected={active === "anthropic"}
            busy={busy === "anthropic"}
            // Said here rather than discovered at enrichment time: without a key
            // the real model cannot run, and a control that accepts the click and
            // silently produces template prose teaches the reviewer the wrong
            // thing about the system.
            disabledReason={
              state.hasKey ? null : "No ANTHROPIC_API_KEY in this environment."
            }
            onClick={() => choose("anthropic")}
          />
          <SwitchOption
            label="Template"
            selected={active === "fallback"}
            busy={busy === "fallback"}
            disabledReason={null}
            onClick={() => choose("fallback")}
          />
        </div>
        <Tip label="Which writer produces the prose" wide>
          {SIMULATOR_TIPS.provider}
        </Tip>
      </div>

      <p className="text-meta leading-relaxed text-ink-subtle">
        {source === "env"
          ? "From LLM_PROVIDER — nobody has switched it."
          : "Overridden here. Applies to the worker on its next enrichment."}
      </p>

      {error && <p className="text-meta leading-relaxed text-danger-fg">{error}</p>}
    </Group>
  );
}

function SwitchOption({
  label,
  selected,
  busy,
  disabledReason,
  onClick,
}: {
  label: string;
  selected: boolean;
  busy: boolean;
  disabledReason: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabledReason !== null || busy}
      title={disabledReason ?? undefined}
      // aria-pressed rather than a radiogroup: two buttons where one is always
      // on is a toggle, and the pressed state is what a screen reader needs to
      // convey. The colour difference is backed by weight, so it does not rest
      // on hue alone.
      aria-pressed={selected}
      className={cn(
        "min-w-0 flex-1 cursor-pointer truncate rounded-lg px-2 py-1.5 text-meta transition-colors",
        selected
          ? "bg-card font-medium text-ink shadow-rest"
          : "text-ink-subtle hover:text-ink",
        disabledReason !== null && "cursor-not-allowed opacity-50 hover:text-ink-subtle",
      )}
    >
      {busy ? "Switching…" : label}
    </button>
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
      <p className="text-meta font-semibold uppercase tracking-wider text-ink-subtle">{title}</p>
      {note && <p className="mt-1 text-meta leading-relaxed text-ink-subtle">{note}</p>}
      <div className="mt-2.5 flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

/**
 * A full-width row rather than a pill in a wrapping flex: the sidebar is a
 * column, and the shape gives every control somewhere to hang its InfoTip
 * without crowding the label.
 *
 * Each carries a glyph for the kind of event it posts — a clock for a delay,
 * two sheets for a duplicate, a shield for the injection probe. Nine buttons in
 * one column are a wall of similar-length text otherwise, and the icon is what
 * makes one findable at a glance. It doubles as the busy indicator: while a
 * post is in flight the glyph becomes a spinner, so the row's shape never
 * changes under the cursor.
 */
function Action({
  busy,
  disabled,
  title,
  icon,
  infoLabel,
  info,
  onClick,
  children,
}: {
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  icon: React.ReactNode;
  infoLabel: string;
  info: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={disabled || busy}
        title={title}
        className="h-9 min-w-0 flex-1 justify-start gap-2.5 rounded-xl px-3 text-label font-normal text-ink-muted shadow-rest hover:text-ink hover:shadow-lift"
      >
        <span
          aria-hidden
          className="shrink-0 text-ink-subtle transition-colors group-hover/button:text-brand"
        >
          {busy ? <LoaderCircleIcon className="size-4 animate-spin" /> : icon}
        </span>
        <span className="min-w-0 truncate">{busy ? "Posting…" : children}</span>
      </Button>
      <Tip label={infoLabel} wide>
        {info}
      </Tip>
    </div>
  );
}
