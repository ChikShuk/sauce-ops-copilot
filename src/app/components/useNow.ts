"use client";

import { useSyncExternalStore } from "react";

/**
 * The current time, or null while rendering on the server.
 *
 * Relative timestamps and countdowns are client-only by nature: computed during
 * SSR they are stale before they paint, and a mismatch between the server's
 * value and the browser's is a hydration error. useSyncExternalStore expresses
 * that directly — its server snapshot is null, so the first paint (and the
 * hydration pass that must match it) renders an absolute time, and the ticking
 * value takes over afterwards.
 *
 * Written this way rather than as setState-in-an-effect because the clock is
 * exactly what useSyncExternalStore is for: an external source of truth React
 * subscribes to, not state React owns.
 */
type Clock = {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => number;
};

// One clock per interval, shared by every component using it, so a board with
// forty cards runs one timer rather than forty.
const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  const existing = clocks.get(intervalMs);
  if (existing) return existing;

  let value = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  const clock: Clock = {
    subscribe(onChange) {
      listeners.add(onChange);

      if (!timer) {
        timer = setInterval(() => {
          value = Date.now();
          for (const listener of listeners) listener();
        }, intervalMs);
      }

      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    // Must return a cached value, not Date.now(): a snapshot that changes on
    // every call makes React re-render forever.
    getSnapshot: () => value,
  };

  clocks.set(intervalMs, clock);
  return clock;
}

const serverSnapshot = () => null;

export function useNow(intervalMs: number): number | null {
  const clock = clockFor(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, serverSnapshot);
}
