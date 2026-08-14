import type { PriorityDriver } from "@/lib/correlation/priority";
import { formatDrivers } from "@/lib/findings/cardState";

/**
 * The deterministic answer to "why is this priority", and the card's trust
 * anchor. It sits directly under the model-written title at co-equal weight so
 * both land in one fixation — the title names the pattern, this line is the
 * evidence that the ranking above it was earned.
 */
export function DriversLine({ drivers }: { drivers: PriorityDriver[] }) {
  const line = formatDrivers(drivers);

  if (line.emptyLabel) {
    // Never a blank row. scorePriority returns no drivers at base priority, and
    // an empty line here would read as a rendering failure on the one element
    // whose whole job is to be believed.
    return <p className="text-sm text-zinc-500">{line.emptyLabel}</p>;
  }

  return (
    <p className="text-sm text-zinc-200">
      {line.shown.map((driver, index) => (
        <span key={`${driver.signal}-${index}`}>
          {index > 0 && <span className="text-zinc-600"> · </span>}
          {driver.detail}
        </span>
      ))}
      {line.moreCount > 0 && (
        <span className="text-zinc-500"> · +{line.moreCount} more</span>
      )}
    </p>
  );
}
