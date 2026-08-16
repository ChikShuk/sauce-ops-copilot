"use client";

import { useEffect, useState } from "react";
import { ClockIcon, HistoryIcon, RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { deriveCardState } from "@/lib/findings/cardState";
import { findingDetailSchema } from "@/lib/findings/types";
import type { FindingCard, FindingDetail, OperatorActionRecord } from "@/lib/findings/types";
import { formatDuration, labelOperatorAction } from "@/lib/format";
import { FALLBACK_DISCLOSURE } from "@/lib/llm/fallback";
import { logJson } from "@/lib/log";
import { cn } from "@/lib/utils";
import {
  ActionBar,
  SummaryFeedbackChip,
  SummaryFeedbackPanel,
  type ActionResult,
} from "./ActionBar";
import { BotChip, DegradedChip, PriorityLabel, RetryChip, StaleChip, StatusBadge } from "./Badges";
import { EvidenceTable } from "./EvidenceTable";
import { PriorityPanel } from "./PriorityPanel";
import { RecommendedActions } from "./RecommendedActions";
import { ExactTime, TimeAgo } from "./TimeAgo";
import { Tip } from "./Tip";
import { DRIVERS_TIP, SIMULATOR_TIPS } from "./tips";

/**
 * The fallback writer restates the priority reasoning in prose ("Priority is
 * critical because: 95 minute delay; …"), which is useful when the summary is
 * read on its own but pure duplication directly under the panel that lays the
 * same drivers out in a table.
 *
 * Stripped at display time rather than at generation. The sentence is asserted
 * by `fallbackProvider.test.ts`, so removing it from `buildSummary` would break
 * the suite — and the stored summary should stay complete regardless of which
 * surface happens to render it.
 */
function trimRedundantPriorityProse(summary: string, hasDriverPanel: boolean): string {
  if (!hasDriverPanel) return summary;
  return summary
    .replace(/\s*Priority is [^.]*\.(?=\s|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Matched on its opening clause and run to the end of the string rather than
 * compared against `FALLBACK_DISCLOSURE` verbatim.
 *
 * The summary is stored as written, so rows enriched before the sentence was
 * last reworded still carry the older phrasing — an exact match would leave
 * exactly those rows rendering as one undifferentiated block. The disclosure is
 * always the last thing the fallback writer appends, so the tail is safe to
 * take whole.
 */
const DISCLOSURE_PATTERN = /\s*This summary was generated without the [\s\S]*$/;

/**
 * The fallback's degraded-path disclosure is about the summary, not part of
 * what it says — running the two together left the operator to notice mid-
 * paragraph that the prose had stopped describing the finding. Lifted out so it
 * can sit with the rest of the provenance instead.
 */
function splitDisclosure(summary: string): { prose: string; disclosure: string | null } {
  const match = DISCLOSURE_PATTERN.exec(summary);
  if (!match) return { prose: summary, disclosure: null };

  return {
    prose: summary.slice(0, match.index).replace(/\s{2,}/g, " ").trim(),
    // Today's wording, not whatever the row happens to store. This sentence is
    // our own boilerplate rather than anything the model wrote, and its claim —
    // no model ran — is identical in both phrasings.
    disclosure: FALLBACK_DISCLOSURE,
  };
}

/**
 * Everything behind a finding, rendered inline when its row expands.
 *
 * Fetched on demand — the accordion unmounts closed content, so this only ever
 * loads for findings someone actually opened. The board stream carries
 * `version` and this re-fetches when it moves, which is what makes an open row
 * update live without the stream carrying evidence and prose for every row.
 */
export function FindingBody({
  card,
  rewriteEnabled,
  onActionRecorded,
}: {
  card: FindingCard;
  rewriteEnabled: boolean;
  onActionRecorded: (result: ActionResult) => void;
}) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [error, setError] = useState(false);
  // An operator action changes none of the fields the effect below watches, so
  // it needs its own trigger to pull the refreshed action history.
  const [reloadKey, setReloadKey] = useState(0);
  // Owned here rather than inside the feedback control, because its trigger sits
  // in the section heading and its note field opens under the prose — two places
  // that cannot share component state without a portal.
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const findingId = card.id;
  const version = card.version;
  const status = card.status;

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(`/api/findings/${findingId}`, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));

        // Validated for the same reason the board payload is: this response was
        // cast, and a cast is a claim the compiler believes and the runtime does
        // not check. A malformed detail lands in the existing error state, which
        // says so, rather than rendering a panel whose evidence table crashes on
        // a missing array.
        const parsed = findingDetailSchema.safeParse(await res.json());
        if (!parsed.success) {
          logJson({
            msg: "finding_detail.payload_rejected",
            finding_id: findingId,
            problems: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`),
          });
          throw new Error("malformed finding detail");
        }

        setDetail(parsed.data);
        setError(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(true);
      }
    }

    void load();
    return () => controller.abort();
    // `status` is a dependency alongside `version` because enrichment moves the
    // status without bumping the version — that is what makes version usable as
    // a fence in the first place.
  }, [findingId, version, status, reloadKey]);

  const presentation = deriveCardState(detail ?? card);
  const drivers = (detail ?? card).drivers;
  const summary = detail?.summary
    ? splitDisclosure(trimRedundantPriorityProse(detail.summary, drivers.length > 0))
    : null;

  const recordAction = (result: ActionResult) => {
    onActionRecorded(result);
    setReloadKey((key) => key + 1);
  };

  return (
    <div className="flex flex-col gap-5 border-t border-line bg-surface px-6 py-6">
      {/* Unboxed on the tray, above the cards: this is a caption for the whole
          panel rather than a section of it, and giving it a card of its own
          would make it a peer of Summary and Evidence, which it is not.

          It repeats the row's own badges deliberately — this is where they carry
          their explanations, because inside the collapsed row they sit within
          the accordion's trigger button and cannot hold a popover. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <StatusBadge presentation={presentation} explain />
        <PriorityLabel priority={card.priority} explain />
        <span className="text-meta text-ink-subtle">
          Version {card.version} · <ExactTime iso={card.firstEventAt} short /> →{" "}
          <ExactTime iso={card.lastEventAt} short /> ·{" "}
          {formatDuration(card.firstEventAt, card.lastEventAt)} span
        </span>

        {/* The two decisions ride the strip rather than owning a card. They are
            state changes on the finding, and this line is where the finding's
            state already is — the strip says what it is, and now offers the two
            ways to change it. `ml-auto` on a wrapping row: they sit far right on
            one line and drop below the metadata when the width runs out. */}
        <div className="ml-auto flex flex-wrap items-center gap-x-1 gap-y-2">
          {detail && detail.actions.length > 0 && (
            <Tip
              label="Operator activity"
              trigger={
                <Badge className="h-7 gap-1.5 rounded-full bg-card px-2.5 text-meta font-normal text-ink-muted">
                  <HistoryIcon aria-hidden className="size-3.5" />
                  Activity · {detail.actions.length}
                </Badge>
              }
              wide
            >
              {/* The log lives here rather than in a card of its own: it is the
                  record of the two buttons beside it being pressed, so it belongs
                  with them, and a popover costs no height on a panel this long. */}
              <ActionHistory actions={detail.actions} />
            </Tip>
          )}

          <ActionBar card={card} onRecorded={recordAction} />
        </div>
      </div>

      <Section
        title="Summary"
        // Provenance rides the title rather than sitting in a block under the
        // prose: it is a caption on the heading, and a line of its own at the
        // bottom of the card cost ~40px to say who wrote three sentences.
        meta={
          detail && summary?.prose ? (
            <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span>
                {detail.summarySource === "llm"
                  ? `Written by ${detail.llmModel ?? "the AI model"}`
                  : "Written without the AI model"}
              </span>

              {summary.disclosure && (
                <Tip label="Written without the AI model" wide className="-ml-1">
                  <p>{summary.disclosure}</p>
                </Tip>
              )}

              {detail.enrichedAt && (
                <span className="inline-flex items-center gap-1.5">
                  <ClockIcon aria-hidden className="size-3.5" />
                  <TimeAgo iso={detail.enrichedAt} />
                </span>
              )}
            </span>
          ) : undefined
        }
        // Chips ride the heading line rather than sitting above the prose:
        // they qualify where the summary came from, so they belong with the
        // label, not in the reading column. The rewrite control joins them for
        // the same reason — it is an action about the prose, not about the
        // finding, so it does not belong on the strip with review and resolve.
        aside={
          <>
            {presentation.retry && <RetryChip retry={presentation.retry} explain />}
            {presentation.staleProse && <StaleChip />}
            {presentation.degraded && <DegradedChip />}
            {/* `detail` rather than `card` so the exact token counts come from
                the same fetch as the prose they paid for. */}
            {presentation.modelWritten && <BotChip usage={(detail ?? card).llmUsage} explain />}
            {rewriteEnabled && <RewriteButton findingId={card.id} />}
            {/* The judgement of the prose sits with the prose, at the same
                weight as the control that rewrites it. Only offered once there
                is something to judge. */}
            {detail && summary?.prose && (
              <SummaryFeedbackChip
                card={card}
                actions={detail.actions}
                open={feedbackOpen}
                onToggle={() => setFeedbackOpen((open) => !open)}
              />
            )}
          </>
        }
      >
        {detail ? (
          summary?.prose ? (
            <>
              {presentation.placeholder && (
                <p className="mb-2 text-body text-danger-fg">{presentation.placeholder}</p>
              )}
              <div className="max-w-[72ch]">
                {/* The one thing an operator reads first, so it takes the next
                    step up the scale — at `text-body` it weighed the same as
                    the evidence table and the provenance beneath it. Re-weighted
                    to normal because `text-headline` ships at 600: this wants
                    the size of a lead paragraph, not the authority of a title. */}
                <p className="text-headline font-normal leading-relaxed text-ink">
                  {summary.prose}
                </p>

                {/* Opens under what it is judging, rather than under the chip
                    row that launched it. */}
                {feedbackOpen && (
                  <SummaryFeedbackPanel
                    card={card}
                    actions={detail.actions}
                    onRecorded={recordAction}
                    onSent={() => setFeedbackOpen(false)}
                  />
                )}
              </div>
            </>
          ) : (
            <p className="text-body text-ink-subtle">{presentation.placeholder}</p>
          )
        ) : error ? (
          <p className="text-body text-danger-fg">Could not load this finding.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full bg-surface-hover" />
            <Skeleton className="h-4 w-4/5 bg-surface-hover" />
          </div>
        )}
      </Section>

      {detail && detail.recommendedActions.length > 0 && (
        <Section title="Recommended actions">
          <RecommendedActions actions={detail.recommendedActions} />
        </Section>
      )}

      <Section title="Why this priority" info={DRIVERS_TIP} infoLabel="How priority is decided">
        <PriorityPanel drivers={drivers} priority={card.priority} />
      </Section>

      <Section
        title={`Evidence (${detail?.evidence.length ?? card.eventCount})`}
        note={
          detail && detail.citedEventIds === null && detail.summarySource !== null
            ? "No citations recorded — this summary was not written by the AI model."
            : undefined
        }
      >
        {detail ? (
          <EvidenceTable evidence={detail.evidence} hasCitations={detail.citedEventIds !== null} />
        ) : (
          <Skeleton className="h-24 w-full bg-surface-hover" />
        )}
      </Section>
    </div>
  );
}

/**
 * Ask for this finding's prose to be written again, under whichever provider the
 * sidebar currently names.
 *
 * There is no success state to render and that is deliberate: the endpoint
 * queues the work, and the card's own status badge — `Analyzing`, then `Ready` —
 * is the progress indicator, arriving over the same stream every other
 * enrichment reports through. A private spinner here would be a second, quieter
 * account of the same thing.
 */
function RewriteButton({ findingId }: { findingId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/findings/${findingId}/reenrich`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "Could not queue that rewrite.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      {error && <span className="text-meta text-danger-fg">{error}</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={request}
        disabled={busy}
        className="h-6 gap-1.5 rounded-full px-2.5 text-meta font-normal text-ink-muted hover:text-ink"
      >
        <RefreshCwIcon aria-hidden className={cn("size-3", busy && "animate-spin")} />
        {busy ? "Queueing…" : "Re-write summary"}
      </Button>
      <Tip label="Re-write summary" wide className="-ml-0.5">
        {SIMULATOR_TIPS.rewrite}
      </Tip>
    </span>
  );
}

/**
 * Newest first. Exists so the persistence is visible rather than implied — the
 * audit log is append-only, so a finding reviewed twice shows twice, which is
 * the honest record even though `reviewed_at` only moved once.
 */
function ActionHistory({ actions }: { actions: OperatorActionRecord[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {actions.map((action) => (
        <li key={action.id} className="flex flex-wrap items-baseline gap-x-2 text-body">
          <span className="text-ink">{labelOperatorAction(action.actionType)}</span>
          <span className="text-meta text-ink-subtle">
            {action.actor}
            {action.version !== null && ` · version ${action.version}`}
            {" · "}
            <TimeAgo iso={action.createdAt} />
          </span>
          {action.note && (
            <p className="mt-1 w-full border-l-2 border-line pl-3 text-body text-ink-muted">
              &ldquo;{action.note}&rdquo;
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  note,
  info,
  infoLabel,
  meta,
  aside,
  children,
}: {
  title: string;
  note?: string;
  info?: React.ReactNode;
  infoLabel?: string;
  /**
   * Caption text for the title, on the same line — provenance, counts, anything
   * that qualifies the heading rather than acting on it. Distinct from `aside`,
   * which is the control cluster and is pushed to the far right.
   */
  meta?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // The section *is* the card. Separation comes from the white surface, the
    // rest elevation and the gap to its neighbours — never from an outline, per
    // docs/design-principles.md §4. The tinted tray behind it is what makes a
    // shadow this soft legible at all.
    <section className="rounded-xl bg-card p-5 shadow-rest">
      <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
        {/* Sentence case at label size, not a small-caps eyebrow. The card now
            does the separating, so the heading's job is to name the container
            rather than to fence it off — and an uppercase micro-label reads as
            an annotation above content, not as the title of a box it sits
            inside. */}
        <h4 className="text-label font-semibold text-ink">{title}</h4>
        {info && (
          <Tip label={infoLabel ?? title} wide>
            {info}
          </Tip>
        )}
        {meta && <span className="min-w-0 text-meta text-ink-subtle">{meta}</span>}
        {aside && <div className="ml-auto flex flex-wrap items-center gap-2">{aside}</div>}
      </div>
      {note && <p className="-mt-1 mb-3 text-meta text-ink-subtle">{note}</p>}
      {children}
    </section>
  );
}
