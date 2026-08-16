import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to be told about our custom scales, or it silently drops
 * classes.
 *
 * It de-duplicates by class group, and it infers the group from the class name.
 * `text-headline` is a font size and `text-ink` is a colour, but tailwind-merge
 * only knows the sizes Tailwind ships with — so it read both as the same group
 * and kept the last one, deleting the type scale wherever `cn()` combined a size
 * with a colour. Same trap for `shadow-rest`, which it would otherwise treat as
 * a shadow *colour* and fail to de-duplicate against `shadow-md`.
 *
 * These names come from the `@theme` block in globals.css. Adding a step there
 * means adding it here.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["lead", "headline", "body", "label", "meta"] }],
      shadow: [{ shadow: ["rest", "lift", "pop"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
