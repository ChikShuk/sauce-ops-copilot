import type { PriorityDriver } from "@/lib/correlation/priority";
import { formatDrivers } from "@/lib/findings/cardState";
import { cn } from "@/lib/utils";

/**
 * The deterministic answer to "why is this priority", and the row's trust
 * anchor. It sits directly under the model-written title so both land in one
 * fixation — the title names the pattern, this line is the evidence that the
 * ranking above it was earned.
 *
 * `prominent` inverts the two when there is no title. An un-enriched finding
 * used to lead with its placeholder ("Queued for analysis…"), which put the
 * least informative string on the row in the largest type and pushed the only
 * real content beneath it. When the model has written nothing, the deterministic
 * facts are the headline.
 */
export function DriversLine({
  drivers,
  prominent = false,
}: {
  drivers: PriorityDriver[];
  prominent?: boolean;
}) {
  const line = formatDrivers(drivers);

  if (line.emptyLabel) {
    // Never a blank row. scorePriority returns no drivers at base priority, and
    // an empty line here would read as a rendering failure on the one element
    // whose whole job is to be believed.
    return (
      <p className={cn(prominent ? "text-headline text-ink-muted" : "text-label text-ink-subtle")}>
        {line.emptyLabel}
      </p>
    );
  }

  return (
    <p className={cn(prominent ? "text-headline text-ink" : "text-label text-ink")}>
      {line.shown.map((driver, index) => (
        <span key={`${driver.signal}-${index}`}>
          {index > 0 && <span className="text-ink-subtle"> · </span>}
          {driver.detail}
        </span>
      ))}
      {line.moreCount > 0 && (
        <span className="text-ink-subtle"> · +{line.moreCount} more</span>
      )}
    </p>
  );
}
