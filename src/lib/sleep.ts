// A sleep that a shutdown signal can cut short. Without this, an idle
// worker sitting in a poll-interval sleep would ignore SIGTERM until the
// timer expired, making `docker compose down` (slice 10) wait it out.
//
// Extracted rather than inlined in the worker loop so the wake behaviour is
// directly exercisable — on Windows the OS never generates SIGTERM, so the
// signal path itself can only be verified in the Linux container.
export function createSleeper() {
  let wake: (() => void) | null = null;

  return {
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        wake = finish;
      });
    },
    // No-op when no sleep is in flight.
    wake(): void {
      wake?.();
    },
  };
}
