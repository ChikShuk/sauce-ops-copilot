import type { BoardMessage } from "../../src/lib/realtime/broadcaster";

/**
 * Collects everything the broadcaster pushes, and lets a test wait for the next
 * one rather than sleeping past the poll interval and hoping.
 *
 * The cursor is the point. An earlier version compared `messages.length` to a
 * copy of itself taken one line earlier, so the "already arrived" branch was
 * dead code and a message delivered between subscribe() and waitForNext() was
 * never seen — the test then hung until its timeout. It passed only because the
 * poller happened to tick after the call. Draining from a cursor makes arrival
 * order irrelevant, which is what a test asserting on a race actually needs.
 */
export function collector(): {
  messages: BoardMessage[];
  listener: (message: BoardMessage) => void;
  waitForNext: (timeoutMs?: number) => Promise<BoardMessage>;
} {
  const messages: BoardMessage[] = [];
  let cursor = 0;
  let notify: (() => void) | null = null;

  const listener = (message: BoardMessage): void => {
    messages.push(message);
    notify?.();
  };

  async function waitForNext(timeoutMs = 5_000): Promise<BoardMessage> {
    if (cursor >= messages.length) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("no board message arrived")),
          timeoutMs,
        );
        notify = () => {
          clearTimeout(timer);
          notify = null;
          resolve();
        };
      });
    }

    const message = messages[cursor];
    cursor += 1;
    return message;
  }

  return { messages, listener, waitForNext };
}

export type SseFrame = {
  raw: string;
  event: string | null;
  data: string | null;
};

function parseFrame(raw: string): SseFrame {
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }

  return { raw, event, data: dataLines.length > 0 ? dataLines.join("\n") : null };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Reads the SSE route's response as discrete frames.
 *
 * Frames are separated by a blank line, and a single read() can carry several
 * of them or half of one, so the buffer is split on "\n\n" rather than trusting
 * chunk boundaries. Every wait is bounded: a stream that stops producing should
 * fail the assertion it was waiting on, not the whole file's timeout.
 */
export function frameReader(res: Response): {
  next: (timeoutMs?: number) => Promise<SseFrame>;
  expectDone: (timeoutMs?: number) => Promise<void>;
  cancel: () => Promise<void>;
} {
  const body = res.body;
  if (!body) throw new Error("SSE response had no body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: string[] = [];

  function drainBuffer(): void {
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      pending.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
    }
  }

  async function next(timeoutMs = 5_000): Promise<SseFrame> {
    while (pending.length === 0) {
      const chunk = await withTimeout(reader.read(), timeoutMs, "the next SSE frame");
      if (chunk.done) throw new Error("stream closed before the next frame arrived");
      buffer += decoder.decode(chunk.value, { stream: true });
      drainBuffer();
    }

    const raw = pending.shift();
    if (raw === undefined) throw new Error("unreachable: pending frame vanished");
    return parseFrame(raw);
  }

  // Asserts the server actually closed the stream, rather than merely going
  // quiet — the difference between a torn-down subscription and a leaked one.
  async function expectDone(timeoutMs = 5_000): Promise<void> {
    const chunk = await withTimeout(reader.read(), timeoutMs, "the stream to close");
    if (!chunk.done) {
      throw new Error(`expected a closed stream, got a chunk: ${decoder.decode(chunk.value)}`);
    }
  }

  return { next, expectDone, cancel: () => reader.cancel() };
}

export function boardFrom(frame: SseFrame): BoardMessage {
  if (frame.event !== "board") throw new Error(`expected a board frame, got ${frame.event}`);
  if (frame.data === null) throw new Error("board frame carried no data");
  return JSON.parse(frame.data) as BoardMessage;
}
