import { titleCase } from "./labels";

// Restaurant and order ids are caller-supplied identifiers. They are correct as
// stored values and wrong as displayed ones — no operator calls a restaurant
// `bellas_pizza`.
//
// There is no name column in the schema, only `restaurant_id`, so display names
// come from a map here with a readable transform as the fallback. The map is
// display-only: correlation, the unique-open-finding constraint and every query
// keep using the id.

const RESTAURANT_NAMES: Record<string, string> = {
  bellas_pizza: "Bella's Pizza",
  sunset_grill: "Sunset Grill",
  nonna_kitchen: "Nonna's Kitchen",
  tokyo_ramen_bar: "Tokyo Ramen Bar",
  green_bowl: "Green Bowl",
  the_daily_roast: "The Daily Roast",
};

/**
 * Ids the test factories generate (`rest_<uuid>`) carry no human meaning at all.
 * Title-casing one produces "Rest 33a7ee43 F943…", which is worse than leaving
 * it alone — so they are flagged `opaque` and rendered as a monospace chip.
 */
const OPAQUE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const OPAQUE_LABEL_CHARS = 16;

export type RestaurantLabel = {
  /** What to show. */
  name: string;
  /** Demo-run qualifier, when the id carries one. */
  note: string | null;
  /** True when the id is a generated identifier with no human form. */
  opaque: boolean;
};

export function formatRestaurant(id: string): RestaurantLabel {
  if (OPAQUE_ID.test(id)) {
    const short = id.length > OPAQUE_LABEL_CHARS ? `${id.slice(0, OPAQUE_LABEL_CHARS)}…` : id;
    return { name: short, note: null, opaque: true };
  }

  // The simulator suffixes repeat runs so each pair lands on its own restaurant
  // (`bellas_pizza_ooo`, `bellas_pizza_2`). Those suffixes are demo mechanics,
  // not part of the name, so they move into a qualifier.
  let base = id;
  const notes: string[] = [];

  const run = base.match(/^(.*?)_(\d+)$/);
  if (run) {
    base = run[1];
    notes.push(`run ${run[2]}`);
  }

  if (base.endsWith("_ooo")) {
    base = base.slice(0, -"_ooo".length);
    notes.push("out-of-order run");
  }

  return {
    name: RESTAURANT_NAMES[base] ?? titleCase(base),
    note: notes.length > 0 ? notes.reverse().join(", ") : null,
    opaque: false,
  };
}

/** Convenience for the common case where only the name is wanted. */
export function labelRestaurant(id: string): string {
  return formatRestaurant(id).name;
}

/** `order_5001` -> `Order 5001`. */
export function labelOrder(id: string): string {
  const match = id.match(/^order[_-]?(.+)$/i);
  return match ? `Order ${match[1]}` : titleCase(id);
}
