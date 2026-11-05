// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { saveTimeoutMs } from './gym-settings.js';

/**
 * Holds back every timer set for one of `delays` (the save queue's timeout by default) so a test fires them itself with
 * `expire`; every other timer runs. `held(delay)` counts the timers waiting for that delay; `restore` puts the real
 * `setTimeout` back.
 */
export function holdTimeouts(...delays: number[]) {
  const holding = new Set(delays.length ? delays : [saveTimeoutMs]);
  const real = globalThis.setTimeout, waiting: Array<{ delay: number; run: () => void }> = [];
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay?: number) =>
    delay !== undefined && holding.has(delay) ? (waiting.push({ delay, run }), 0) : real(run, delay)) as unknown as typeof setTimeout);
  return {
    held: (delay = saveTimeoutMs) => waiting.filter((timer) => timer.delay === delay).length,
    /** Fires the timers waiting for `delay`, or for every held delay. */
    expire(delay?: number) {
      for (const timer of waiting.filter((candidate) => delay === undefined || candidate.delay === delay)) {
        waiting.splice(waiting.indexOf(timer), 1); timer.run();
      }
    },
    restore() { spy.mockRestore(); },
  };
}

/** A request that never answers; `signals` records the signal each call was sent with. */
export function stalledRequests() {
  const signals: AbortSignal[] = [];
  return {
    signals,
    answer: (_path: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal ?? new AbortController().signal);
      return new Promise<never>(() => undefined);
    },
  };
}
