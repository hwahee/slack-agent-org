/**
 * Clock watch — notices when the process stopped running for a while.
 *
 * A one-second timer that fires much later than asked means the whole process
 * was frozen: the Mac slept, or something blocked the event loop. Both stop the
 * ears too, so the gap is worth a line next to the socket records. The wall
 * clock and the monotonic clock are reported separately; how far each moved
 * across a sleep depends on the OS, and the difference is itself a clue.
 */

export interface ClockWatchOptions {
  /** How often to look. */
  readonly everyMs: number;
  /** A tick this much later than `everyMs` is a gap. */
  readonly gapMs: number;
  readonly onGap: (gap: {
    expectedMs: number;
    wallElapsedMs: number;
    monoElapsedMs: number;
  }) => void;
  readonly wall?: () => number;
  readonly mono?: () => number;
  readonly setInterval?: (tick: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export function watchClock(options: ClockWatchOptions): () => void {
  const wall = options.wall ?? Date.now;
  const mono = options.mono ?? (() => performance.now());
  const set = options.setInterval ?? ((tick, ms) => unrefed(setInterval(tick, ms)));
  const clear =
    options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let lastWall = wall();
  let lastMono = mono();
  const handle = set(() => {
    const nowWall = wall();
    const nowMono = mono();
    const wallElapsedMs = nowWall - lastWall;
    const monoElapsedMs = nowMono - lastMono;
    lastWall = nowWall;
    lastMono = nowMono;
    if (Math.max(wallElapsedMs, monoElapsedMs) - options.everyMs >= options.gapMs) {
      options.onGap({
        expectedMs: options.everyMs,
        wallElapsedMs: Math.round(wallElapsedMs),
        monoElapsedMs: Math.round(monoElapsedMs),
      });
    }
  }, options.everyMs);
  return () => clear(handle);
}

/** A timer that does not keep the process alive on its own. */
export function unrefed<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
