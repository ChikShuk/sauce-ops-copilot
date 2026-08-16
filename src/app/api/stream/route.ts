import { SSE_KEEPALIVE_MS } from "@/lib/config";
import { subscribe } from "@/lib/realtime/broadcaster";
import { logJson } from "@/lib/log";

// Node runtime, not edge: this holds an open connection backed by the shared
// Postgres pool. force-dynamic because a cached SSE response is not a stream.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-way server → client, which is all a live dashboard needs. A WebSocket
// would add a second protocol and a handshake to carry the same payload in the
// same direction.
export async function GET(req: Request): Promise<Response> {
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(chunk: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client vanished between our last check and this write. Not an
          // error worth logging — it is how every SSE connection ends.
          cleanup();
        }
      }

      // The browser's own reconnect delay. Every reconnect re-subscribes and
      // gets a full board, so backing off costs freshness and nothing else.
      send("retry: 3000\n\n");

      unsubscribe = await subscribe((message) => {
        send(`event: board\ndata: ${JSON.stringify(message)}\n\n`);
      });

      // A named event rather than an SSE comment. It still does the comment's
      // job — any bytes keep a proxy from closing a quiet connection — but
      // EventSource does not surface comments to JavaScript, and the client
      // needs to be able to tell "nothing has changed" from "nothing is
      // arriving". The board itself is only broadcast when it changes, so
      // silence is the normal state of a healthy quiet system and cannot be
      // read as a fault on its own.
      keepalive = setInterval(
        () => send(`event: heartbeat\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`),
        SSE_KEEPALIVE_MS,
      );

      // A tab close aborts the request without cancelling the stream, so the
      // subscription would otherwise outlive the reader it feeds.
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      });

      logJson({ msg: "sse.client_connected" });
    },
    cancel() {
      cleanup();
      logJson({ msg: "sse.client_disconnected" });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tells nginx not to buffer the response, which would otherwise hold
      // events until the buffer filled and make the dashboard look frozen.
      "X-Accel-Buffering": "no",
    },
  });
}
