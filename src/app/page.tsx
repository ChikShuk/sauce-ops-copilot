import { FindingsBoard } from "./components/FindingsBoard";
import { currentBoard } from "@/lib/realtime/broadcaster";

// Server-rendered first paint, then the client takes over the same data via
// SSE. This is what makes a refresh mid-processing paint the correct state
// immediately instead of flashing an empty list and filling in a second later.
export const dynamic = "force-dynamic";

export default async function Home() {
  const { findings, queue } = await currentBoard();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline gap-3 border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight text-zinc-100">
          Sauce Ops Copilot
        </h1>
        <p className="text-xs text-zinc-500">
          Operational findings across all restaurants, updated live
        </p>
      </header>

      <FindingsBoard initialFindings={findings} initialQueue={queue} />
    </div>
  );
}
