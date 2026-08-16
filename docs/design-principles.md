# Design principles

The system every component references, rather than inventing values. Tokens live
in [`src/app/globals.css`](../src/app/globals.css); this file explains what each
is *for*. If a component needs a value that is not here, the value is wrong or
this file is incomplete — pick one and fix it.

**One light palette.** There is no dark theme and no `prefers-color-scheme`
override. A second palette that follows the OS means the palette being designed
is whichever one the author's machine is not set to, so it ships unseen. One
theme, always visible, properly measured.

## 0. shadcn/ui is the component layer

Vendored into [`src/components/ui/`](../src/components/ui/). It is copy-paste —
the code is ours, and editing it is expected, not a workaround.

**Do not hand-roll anything it provides.** Currently vendored: Accordion, Badge,
Button, Card, Input, Popover, Separator, Sheet, Skeleton, Table, Textarea,
Tooltip.

Two rules for keeping it consistent with the palette:

- **Its tokens are aliases onto ours.** `--primary` resolves to `--brand`,
  `--muted` to `--surface`, `--border` to `--line`. There is exactly one place a
  colour is chosen. Never give a shadcn token its own literal value.
- **Strip `dark:` utilities from anything you add.** shadcn ships them, and with
  no `dark` custom variant defined Tailwind falls back to its built-in
  `prefers-color-scheme` behaviour — which would reintroduce the dark theme
  through the back door on exactly the machines this palette is trying to reach.
  `grep -rn "dark:" src/` must return nothing.

`cn()` in [`src/lib/utils.ts`](../src/lib/utils.ts) is extended with our custom
`font-size` and `shadow` scales. It has to be: tailwind-merge de-duplicates by
class group and infers the group from the name, so without that config it read
`text-headline` and `text-ink` as the same group and deleted one. **Adding a type
step or a shadow step to `globals.css` means adding its name there too.**

## 0b. Nothing shows a stored value

Every enum, key, identifier and timestamp goes through
[`src/lib/format/`](../src/lib/format/) before it reaches a screen. `delay_minutes`
is a correct stored value and a wrong displayed one.

- `labels.ts` — event types, issue classes, driver signals, recommended actions,
  tags, operator actions. Every map falls back to `humanize()` rather than to
  "Unknown", so a taxonomy that outgrows this file degrades to "Missing utensils"
  instead of hiding data.
- `identifiers.ts` — restaurant display names with a title-case fallback, and an
  opaque branch for generated ids (`rest_<uuid>` renders as a monospace chip,
  because title-casing a UUID is worse than leaving it alone). Order ids too.
- `datetime.ts` — UTC on the server, the viewer's timezone after mount.

**This module must never import React or an icon set.** The worker loads it
through the fallback enrichment writer, in a plain Node process. Glyphs live in
[`icons.tsx`](../src/app/components/icons.tsx), keyed on the same enum values,
and are written as switches returning elements — looking a component type up at
render time gives React an unstable component identity, which the compiler's
`static-components` rule rejects.

Display only. Stored values never change.

## 1. Type

**Plus Jakarta Sans** for UI, **JetBrains Mono** for identifiers. The mono face is
carried specifically because event ids and opaque restaurant ids get copied into
queries, and unambiguous `0/O` and `1/l` matter there.

Five steps. Deliberately few, and deliberately far apart: the board this replaced
used five sizes inside a 7px range, which is why nothing on it led the eye. Line
heights are generous on purpose — the goal is calm, not dense.

| Utility | Size / line-height / weight | Role |
|---|---|---|
| `text-lead` | 21 / 30 / 600 | Page title, stat numbers, sidebar wordmark |
| `text-headline` | 17 / 26 / 600 | **The row's issue title.** The one thing that leads a row |
| `text-body` | 15 / 26 / 400 | Summary prose, evidence text, driver detail |
| `text-label` | 13 / 20 / 500 | Drivers line, buttons, nav items |
| `text-meta` | 12 / 18 / 400 | Timestamps, restaurant name, chips, section headings |

Prose measures are capped at `72ch` so a summary never runs the full width of a
wide monitor.

Three rules about how the steps combine:

- **The issue title leads.** It is the largest thing on a row and the only thing
  at `text-headline`. It is also the one element the model wrote, which is the
  point: naming the pattern is where the model earns its place.
- **The drivers line is co-equal but smaller** — `text-label` at full-strength
  `text-ink`. It is the deterministic counterweight to a model-written title and
  must not read as metadata.
- **When there is no title, the hierarchy inverts.** An un-enriched finding
  promotes its drivers line to `text-headline` and drops the placeholder
  ("Queued for analysis…") to `text-meta text-ink-subtle`. The least informative
  string on the row never gets the largest type.

Metadata — restaurant, order, event count, time — is always `text-meta` +
`text-ink-subtle`, on one line below the drivers.

## 2. Spacing

Tailwind's 4px scale, with roles fixed so the rhythm stays consistent:

| Step | Use |
|---|---|
| `gap-2` (8px) | Within a chip row, icon to label |
| `gap-3` (12px) | Between rows in the list |
| `gap-4` (16px) | Between stat cards |
| `py-4 pl-6 pr-5` | Collapsed row inset |
| `gap-5` / `px-5 py-5` | Sections inside an expanded row |
| `px-6` | Main column gutter |

## 3. Radii

One ladder, in shadcn's names because its components already speak them.

| Utility | Value | Use |
|---|---|---|
| `rounded-sm` | 6px | Chips, activity log entries |
| `rounded-md` | 8px | (shadcn internals) |
| `rounded-lg` | 10px | Buttons, inputs, popovers, nav items |
| `rounded-xl` | 12px | Cards, findings rows, simulator buttons |
| `rounded-3xl` | 24px | The sidebar panel, and nothing else |

Badges and status pills stay fully round — the shape is part of how they read as
status rather than as content.

`rounded-3xl` is the one rung off the ladder and it is deliberate: the sidebar is
the only surface at that size, and a 12px corner on a panel 700px tall reads as an
accident rather than as a choice. Radius has to scale with the shape it is cut
into. Nothing smaller may use it.

## 4. Elevation

Three steps. **Cards are separated by shadow and background lift, not by a 1px
border.** A hard outline on every element is what made the old board read as a
technical readout.

| Utility | Role |
|---|---|
| `shadow-rest` | A card or row at rest |
| `shadow-lift` | Hover, and the expanded row |
| `shadow-pop` | Popovers floating over everything |

Never hand-roll a `box-shadow` at a call site.

`--line` still exists, but its job is narrow: a divider *inside* a card, such as
between evidence rows or above an expanded body. It is not a card's outline.
`--line-strong` is the separate, darker value for a control's own boundary,
because WCAG 1.4.11 holds those to 3:1 and a decorative divider cannot follow it
down.

### Nesting alternates two surfaces

There are exactly two container surfaces — `--card` (white) and `--surface`
(tint) — and **depth alternates between them.** A card's contents sit on the
tint; anything inside *those* returns to white.

| Depth | Surface | Example |
|---|---|---|
| Canvas | `--canvas` | the page |
| Card | `--card` + `shadow-rest` | a findings row, a section of an expanded row |
| Inset | `--surface` | a recommended action, a priority tile, an action button |
| Inset's own detail | `--card` | the icon tile inside an action button |

Two rules fall out of it, and both were learned by breaking them. **Never reach
for a third grey** to separate a third level — if two adjacent levels need
distinguishing, one of them is at the wrong depth. And **an inset is not a
card**: giving it `bg-card ring-1 ring-line` inside a card produces the
card-in-a-card that made the expanded finding read as boxes inside boxes, and it
contradicts the rule above it — cards separate by elevation, not by outline.

Where an inset must stand out from its siblings (the signal that decided a
finding's priority), lift it back to `--card` with `shadow-rest` rather than
outlining it. Elevation is a channel that costs no colour.

## 5. Colour

Semantic roles, never raw hues. A `zinc-500` at a call site is a bug — it is what
makes a palette change a change to every component instead of to one file.

**Surfaces.** `--canvas` (page ground, tinted) → `--card` (white, elevated) →
`--card-hover` → `--surface` / `--surface-hover` (chip fills, expanded row
bodies, inline tints). The canvas is tinted and cards are white so elevation
reads as a lift; a shadow on white-over-white is invisible.

**Ink.** `--ink` for content, `--ink-muted` for supporting text, `--ink-subtle`
for metadata. `--ink-subtle` is the most-used token in the app, which is why it
is a step darker than the obvious pick.

**Brand.** `--brand` carries the active nav item and primary buttons, and nothing
else. Status must never compete with brand for the eye.

**Priority.** Two weights of one hue per level: `--priority-*` for the rail (a
block of colour) and `--priority-*-fg` for the word. The array order in
[`src/lib/correlation/priority.ts`](../src/lib/correlation/priority.ts) is
load-bearing for comparison — do not reorder it.

**Status vocabulary,** grouped by meaning rather than hue so one amber cannot
drift from another. `--ok-*`, `--warn-*` (the analyzing badge, the retry chip and
the stale chip together), `--danger-*`. Each has `-fg`, `-border` and `-bg`, so a
status badge is a soft filled shape rather than an outline.

## 6. Status must stay distinguishable on three channels

The rule that outranks the visual direction. The four card states differ by
**hue, shape and wording together** — never by colour alone, which would collapse
the distinction for a colourblind operator, and telling them apart at a glance is
this board's entire job.

| State | Shape | Hue | Label |
|---|---|---|---|
| `queued` | hollow ring | neutral | Queued |
| `analyzing` | `◐`, pulsing | warn | Analyzing |
| `ready` | solid dot | ok | Ready |
| `failed_*` | `✕` | danger | Analysis failed |

Note what this constrains: badges get a coloured mark, but the mark's *form*
varies. A uniform round dot on all four would quietly drop the shape channel.

The four priority levels are likewise distinguished by the rail's hue **and** the
spelled-out level word, so the hues never have to carry it alone.

The labels and placeholder sentences are not presentation — they live in
[`src/lib/findings/cardState.ts`](../src/lib/findings/cardState.ts) and are
covered by tests. Changing that copy is a logic change.

## 7. Layout

One full-width list, no two-pane split. Each finding is a row that expands in
place; everything about a finding lives under the row it belongs to, so there is
no eye-travel between the row clicked and the detail that answers it. One row
open at a time.

Nothing interactive may go inside an `AccordionTrigger` — it is a button, and a
nested one is invalid HTML that breaks hydration. Explanations for anything shown
in a collapsed row live in the expanded body and in the header's legend popover.

Operator actions lead the expanded panel rather than closing it. Whether a
finding is reviewed or resolved is state you want before reading, not after.

**The vendored accordion is edited.** shadcn pins its inner wrapper to
`h-(--radix-accordion-content-height)`, the height measured when the panel
opened. Content here loads asynchronously, so it grows past that and gets
clipped. Any panel that fetches on expand will hit this — do not restore it.

The sidebar is persistent at `md` and up and a `Sheet` drawer below it.

## 8. Contrast is measured

`npm run check:contrast` reads `globals.css` directly, checks every
foreground/background pair the app actually renders, and exits non-zero on any
failure. Run it after touching a colour.

It refuses to run if a `prefers-color-scheme` block reappears, since its pair
table describes one palette.

Thresholds:

- **4.5:1 for all text.** Nothing here qualifies as WCAG large text — that needs
  18.66px bold or 24px regular, and the largest coloured text is the 20px/600
  lead step. This includes the 12px semibold priority word, which an earlier pass
  had wrongly exempted at 3:1.
- **3:1 for non-text graphical objects:** the priority rail, and `--line-strong`
  where it draws a control's boundary.

Current state: **58 pairs, 0 failures.**

Two pairs are worth knowing about, because they are easy to reintroduce:

- **Text over `--highlight`.** The changed-row tint sits under a row's text for
  2.5s, so it is a background like any other.
- **`--warn-fg` on `--warn-bg`** at 4.84:1 is the tightest passing pair in the
  system. Check it first after a change.

## 9. Motion

Only what already exists: the 2.5s changed-row fade, the pulsing `analyzing`
glyph, and the accordion's own open/close transition. All respect
`prefers-reduced-motion`.

The changed-row tint is an `::after` overlay behind the content, not the row's
own `background-color` — a row has a background of its own, so fading to
`transparent` would punch through to the canvas.
