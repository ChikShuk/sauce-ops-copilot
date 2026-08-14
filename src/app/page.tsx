import { FindingsBoard } from "./components/FindingsBoard";
import { currentBoard } from "@/lib/realtime/broadcaster";

// Server-rendered first paint, then the client takes over the same data via
// SSE. This is what makes a refresh mid-processing paint the correct state
// immediately instead of flashing an empty list and filling in a second later.
export const dynamic = "force-dynamic";

export default async function Home() {
  const { findings, queue } = await currentBoard();

  return (
    // Centred and capped: past about 1600px the two panes stop gaining
    // anything from extra width and the eye just travels further between the
    // card it clicked and the evidence it opened. border-x gives the shell a
    // visible edge on an ultrawide monitor instead of leaving it afloat.
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col border-line lg:border-x">
      <header className="flex shrink-0 items-baseline gap-3 border-b border-line px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight text-ink">Sauce Ops Copilot</h1>
        <p className="text-xs text-ink-subtle">
          Operational findings across all restaurants, updated live
        </p>
      </header>

      <FindingsBoard initialFindings={findings} initialQueue={queue} />
    </div>
  );
}
