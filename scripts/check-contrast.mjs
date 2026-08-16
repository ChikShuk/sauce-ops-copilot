#!/usr/bin/env node
/**
 * Measures WCAG contrast for every foreground/background pair the dashboard
 * actually renders, straight out of globals.css.
 *
 * A palette that has been measured once is not a palette that stays measured,
 * so this is committed and wired to `npm run check:contrast` rather than being
 * a throwaway.
 *
 * There is one palette. The dark override was removed because a theme that
 * follows the OS is a theme the author never sees on a machine locked to the
 * other setting — so it ships unverified. This script no longer has a notion
 * of a second palette to check.
 *
 * Thresholds:
 *   4.5:1  all text. Nothing in this UI qualifies as WCAG large text — that
 *          needs 18.66px BOLD (700) or 24px regular, and the largest coloured
 *          text is the 20px/600 lead step. Note this corrects an earlier pass,
 *          which gave the 12px/600 priority word the 3:1 exemption.
 *   3:1    non-text graphical objects: the priority rail, and the input border
 *          that carries a control's boundary.
 *
 * Zero dependencies on purpose: this has to be runnable in a container with
 * nothing installed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "globals.css");

const TEXT = 4.5;
const GRAPHIC = 3;

/**
 * Every pair is listed explicitly rather than generated, because "which
 * surfaces does this token actually land on" is a fact about the components,
 * not about the palette. A generated cross-product would bury the real
 * failures under pairs that never render.
 */
const PAIRS = [
  // Body text, on every surface a card, row or panel can present.
  ...["ink", "ink-muted", "ink-subtle"].flatMap((fg) =>
    ["canvas", "card", "card-hover", "surface", "surface-hover"].map((bg) => [fg, bg, TEXT]),
  ),

  // The row-changed overlay paints above the row background and below the
  // content, so text is read through the highlight tint for 2.5s.
  ...["ink", "ink-muted", "ink-subtle"].map((fg) => [fg, "highlight", TEXT]),

  // Brand carries the active nav item and primary buttons, both of which are
  // solid fills with text on top.
  ["brand-fg", "brand", TEXT],
  ["brand", "canvas", TEXT],
  ["brand", "card", TEXT],
  ["brand", "brand-soft", TEXT],

  // Status vocabulary: each fg on its own tinted badge, and on the plain
  // surfaces where the same token is used for prose.
  ["ok-fg", "ok-bg", TEXT],
  ["ok-fg", "card", TEXT],
  ["ok-fg", "canvas", TEXT],
  ["warn-fg", "warn-bg", TEXT],
  ["warn-fg", "card", TEXT],
  ["warn-fg", "canvas", TEXT],
  ["danger-fg", "danger-bg", TEXT],
  ["danger-fg", "card", TEXT],
  ["danger-fg", "canvas", TEXT],

  // The evidence table's `cited` marker inverts: the card colour is the text
  // and --ok-fg is the fill, so this pair reads backwards from the ones above.
  ["card", "ok-fg", TEXT],

  // The priority word. 12px semibold — small text, so 4.5:1.
  ...["critical", "high", "medium", "low"].flatMap((level) =>
    ["card", "canvas", "card-hover", "surface"].map((bg) => [`priority-${level}-fg`, bg, TEXT]),
  ),

  // The priority rail. A block of colour carrying meaning, so 3:1.
  ...["critical", "high", "medium", "low"].flatMap((level) =>
    ["card", "canvas"].map((bg) => [`priority-${level}`, bg, GRAPHIC]),
  ),

  // Control boundaries. --line is a decorative divider and is deliberately not
  // checked; --line-strong is what draws an input's edge.
  ["line-strong", "card", GRAPHIC],
  ["line-strong", "canvas", GRAPHIC],
];

/** Returns the body of the brace-delimited block starting at `open`. */
function blockAt(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("Unbalanced braces in globals.css");
}

function parsePalette(source) {
  // Comments are stripped first for two reasons: prose in this file mentions
  // `prefers-color-scheme` by name, and a commented-out token would otherwise
  // be read as a live one.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

  const rootAt = css.indexOf(":root");
  if (rootAt === -1) throw new Error("No :root block found");

  if (/@media[^{]*prefers-color-scheme/.test(css)) {
    throw new Error(
      "globals.css declares a prefers-color-scheme block. This project ships one " +
        "palette; add the second palette's pairs here before reintroducing it.",
    );
  }

  const tokens = new Map();
  for (const match of blockAt(css, css.indexOf("{", rootAt)).matchAll(
    /--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g,
  )) {
    tokens.set(match[1], match[2]);
  }
  return tokens;
}

function toRgb(hex) {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const tokens = parsePalette(readFileSync(CSS_PATH, "utf8"));

const rows = [];
let failures = 0;

for (const [fg, bg, threshold] of PAIRS) {
  const fgHex = tokens.get(fg);
  const bgHex = tokens.get(bg);

  if (!fgHex || !bgHex) {
    failures += 1;
    rows.push({
      verdict: "FAIL",
      pair: `${fg} on ${bg}`,
      value: !fgHex ? `--${fg} undefined` : `--${bg} undefined`,
      threshold,
    });
    continue;
  }

  const value = ratio(fgHex, bgHex);
  const pass = value >= threshold;
  if (!pass) failures += 1;
  rows.push({
    verdict: pass ? "pass" : "FAIL",
    pair: `${fg} on ${bg}`,
    value: `${value.toFixed(2)}:1`,
    threshold,
  });
}

const width = Math.max(...rows.map((row) => row.pair.length));
for (const row of rows) {
  console.log(
    `  ${row.verdict}  ${row.pair.padEnd(width)}  ${row.value.padStart(9)}  (>= ${row.threshold})`,
  );
}

console.log(`\n${failures} failure${failures === 1 ? "" : "s"} across ${rows.length} pairs`);
process.exit(failures > 0 ? 1 : 0);
