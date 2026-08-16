import {
  BanknoteIcon,
  BikeIcon,
  CheckCheckIcon,
  ChefHatIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClipboardCheckIcon,
  ClockIcon,
  GiftIcon,
  LayersIcon,
  MessageSquareWarningIcon,
  PhoneIcon,
  RepeatIcon,
  StarIcon,
  ThumbsDownIcon,
  TrendingUpIcon,
  Undo2Icon,
} from "lucide-react";

/**
 * Icon vocabulary, kept separate from `src/lib/format` on purpose.
 *
 * That module has to stay loadable in a plain Node process — the worker imports
 * it through the fallback enrichment writer — so it cannot pull in React or an
 * icon set. Labels live there; glyphs live here, keyed on the same enum values.
 *
 * These are written as switches returning elements rather than as a
 * `Record<string, LucideIcon>` the caller renders. Looking a component *type*
 * up at render time and rendering it as `<Icon />` gives React a component
 * identity that changes between renders, which the compiler's
 * `static-components` rule rejects — and rightly, since it defeats memoisation.
 */

type IconProps = { className?: string };

export function DriverSignalIcon({ signal, className }: IconProps & { signal: string }) {
  switch (signal) {
    case "delay_minutes":
      return <ClockIcon className={className} />;
    case "event_count":
      return <LayersIcon className={className} />;
    case "review_rating":
      return <StarIcon className={className} />;
    case "recurrence":
      return <RepeatIcon className={className} />;
    default:
      return <CircleAlertIcon className={className} />;
  }
}

export function EventTypeIcon({ eventType, className }: IconProps & { eventType: string }) {
  switch (eventType) {
    case "delivery_delay":
      return <ClockIcon className={className} />;
    case "complaint":
      return <MessageSquareWarningIcon className={className} />;
    case "refund":
      return <Undo2Icon className={className} />;
    case "negative_review":
      return <StarIcon className={className} />;
    default:
      return <CircleAlertIcon className={className} />;
  }
}

export function RecommendedActionIcon({ type, className }: IconProps & { type: string }) {
  switch (type) {
    case "contact_customer":
      return <PhoneIcon className={className} />;
    case "issue_refund":
      return <BanknoteIcon className={className} />;
    case "comp_next_order":
      return <GiftIcon className={className} />;
    case "escalate_to_manager":
      return <TrendingUpIcon className={className} />;
    case "check_kitchen_capacity":
      return <ChefHatIcon className={className} />;
    case "review_courier_assignment":
      return <BikeIcon className={className} />;
    case "audit_order_accuracy":
      return <ClipboardCheckIcon className={className} />;
    case "no_action_needed":
      return <CircleCheckIcon className={className} />;
    default:
      return <CircleCheckIcon className={className} />;
  }
}

/**
 * The gavel marking which signal set a finding's priority. Drawn here rather
 * than taken from lucide, which is the exception in this file and needs a
 * reason.
 *
 * Lucide's `Gavel` is a line drawing of a mallet struck at 45°, with the head,
 * the shaft and the sound block all rendered as 2px strokes. At the 14–16px this
 * mark renders at, those strokes land under a pixel after the diagonal is
 * antialiased, and the whole thing reads as a smudge at an angle — you can tell
 * something is there, not what.
 *
 * So: three filled shapes, axis-aligned. Filled beats stroked at this size
 * because a solid form keeps its silhouette when it is scaled down, and the
 * head/handle/block stack is what makes it read as a gavel rather than a hammer
 * or a T. Proportions are tuned for a 16px box; the viewBox scales cleanly if it
 * is ever used larger.
 *
 * It sits in this file because this file is the glyph vocabulary. It is a plain
 * component rather than a case in one of the switches above, because those are
 * keyed on domain enums that come out of the database — this is one UI mark with
 * one meaning.
 */
export function DecidingGavelIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {/* Head and handle as one rotated body. Struck at 30° rather than drawn
          flat: the diagonal is what makes the shape read as a gavel in motion
          rather than as a T, and it is the angle the reference uses. The whole
          group is laid out axis-aligned and then rotated, so the geometry stays
          readable and the corners land inside the 24-unit box. */}
      <g transform="rotate(30 11 8)">
        <rect x="3" y="4.5" width="6" height="7" rx="1.4" />
        {/* The striking face, at reduced opacity. Monochrome depth: it gives the
            head the two-tone front-and-side of the reference without needing a
            second colour, and it survives being scaled down because it is a
            block rather than a line. */}
        <rect x="3" y="4.5" width="2.1" height="7" rx="1.4" fillOpacity="0.55" />
        <rect x="8.4" y="6.6" width="10.6" height="2.8" rx="1.4" />
      </g>

      {/* The block, in two tiers like the reference. Without it this is a
          hammer; with it, a gavel. The lower tier is wider and sits flush to the
          bottom, which is what stops the whole mark from looking top-heavy once
          the head is thrown up and to the left. */}
      <rect x="3" y="15.6" width="16" height="3" rx="1" />
      <rect x="1.2" y="19.4" width="19.6" height="3.4" rx="1.2" />
    </svg>
  );
}

export function OperatorActionIcon({
  type,
  done,
  className,
}: IconProps & { type: string; done?: boolean }) {
  if (done) return <CheckCheckIcon className={className} />;

  switch (type) {
    case "mark_reviewed":
      return <CheckCheckIcon className={className} />;
    case "mark_resolved":
      return <CircleCheckIcon className={className} />;
    case "thumbs_down":
      return <ThumbsDownIcon className={className} />;
    default:
      return <CircleCheckIcon className={className} />;
  }
}
