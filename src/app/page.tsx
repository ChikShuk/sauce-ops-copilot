import { FindingsBoard } from "./components/FindingsBoard";
import { env } from "@/lib/env";
import { currentBoard } from "@/lib/realtime/broadcaster";
import { resolveProviderName } from "@/lib/settings/provider";

// Server-rendered first paint, then the client takes over the same data via
// SSE. This is what makes a refresh mid-processing paint the correct state
// immediately instead of flashing an empty list and filling in a second later.
export const dynamic = "force-dynamic";

export default async function Home() {
  const { findings, queue } = await currentBoard();

  // Read here for the same reason the failure flag is: it is server-side state.
  // `source` distinguishes "nobody has chosen, this is LLM_PROVIDER" from "someone
  // flipped it", which is worth showing — a toggle that cannot tell you whether
  // you are looking at a default is a toggle you have to test to trust.
  const provider = await resolveProviderName();

  return (
    // Centred and capped: past about 1600px a findings row stops gaining
    // anything from extra width and the line length of a summary starts working
    // against it. The shell's own surfaces give it an edge on an ultrawide
    // monitor, so it needs no border to avoid looking afloat.
    //
    // The product identity lives at the top of the sidebar and the board's
    // heading in its header, both inside FindingsBoard — the sidebar, the queue
    // counts and the active/resolved views all read client state, so the shell
    // has to compose there.
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1600px]">
      {/*
        Read here, in a Server Component, because the flag is server-side env.
        Worth being precise about what it means: this is what the *web app's*
        environment says, and the process that actually acts on `force_fail_` is
        the worker. They are separate processes that happen to share one
        environment block under Docker Compose (the `x-app-env` anchor), so the
        button's presence is a strong hint rather than a guarantee.
      */}
      <FindingsBoard
        initialFindings={findings}
        initialQueue={queue}
        demoFailureEnabled={env.ENABLE_DEMO_FAILURE_TRIGGER}
        providerToggle={{
          enabled: env.ENABLE_PROVIDER_TOGGLE,
          active: provider.name,
          source: provider.source,
          // Boolean, never the key itself. Whether one exists is all the UI
          // needs to say "the real model can't run here".
          hasKey: Boolean(env.ANTHROPIC_API_KEY),
        }}
      />
    </div>
  );
}
