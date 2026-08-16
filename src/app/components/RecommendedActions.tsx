import type { RecommendedAction } from "@/lib/findings/types";
import { labelRecommendedAction } from "@/lib/format";
import { RecommendedActionIcon } from "./icons";

/**
 * What the model suggests doing about the finding.
 *
 * Rendered as distinct cards rather than a flat list: the previous version put
 * the action and its rationale in two adjacent paragraphs of near-identical
 * weight, so three suggestions read as six interchangeable lines. Each one now
 * gets an icon, a numbered position and a clear split between the instruction
 * and the reasoning behind it.
 *
 * The action `type` is constrained to a known allowlist, which is what makes an
 * icon per action possible at all — and what stops a prompt injection from
 * inventing an action the UI would render as legitimate.
 */
export function RecommendedActions({ actions }: { actions: RecommendedAction[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {actions.map((action, index) => {
        return (
          // Tinted inset inside a white section card, not an outlined card on a
          // tinted body. See the alternation rule in docs/design-principles.md:
          // depth alternates between the two surfaces, so nesting never needs a
          // third value or a border to stay legible.
          <li key={`${action.type}-${index}`} className="flex gap-3 rounded-lg bg-surface p-3.5">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"
            >
              <RecommendedActionIcon type={action.type} className="size-4" />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-label text-ink">{labelRecommendedAction(action.type)}</p>
              <p className="mt-1 text-body text-ink-muted">{action.rationale}</p>
            </div>

            <span
              aria-hidden
              className="shrink-0 text-meta tabular-nums text-ink-subtle"
            >
              {index + 1}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
