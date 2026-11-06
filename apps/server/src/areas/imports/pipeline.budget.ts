// SPDX-License-Identifier: AGPL-3.0-only
import { getHeapStatistics } from 'node:v8';
import { AppError } from '@plaingym/shared';
import { t } from './pipeline.messages.js';

const MIB = 1024 * 1024;
/** Reserve room for the server and a run. Large previews occupy the whole preview allowance. */
export const PREVIEW_MEMORY_BYTES = Math.floor(Math.min(128 * MIB, getHeapStatistics().heap_size_limit / 3));
export const PREVIEW_TIMEOUT_MS = 120_000;
/** Removing a failed computation's rows, or reading a summary another process stored first, can follow its deadline, so each has this limit. */
export const PREVIEW_CLEANUP_MS = 10_000;

/** FIFO admission keeps small previews concurrent without allowing them to starve a large file. */
export class PreviewBudget {
  #used = 0;
  readonly #waiting: { weight: number; start: () => void }[] = [];
  constructor(readonly bytes = PREVIEW_MEMORY_BYTES) {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid preview memory budget');
  }
  async run<T>(size: number, rows: number, work: () => Promise<T>): Promise<T> {
    // Include per-row overhead for narrow CSVs, whose parsed size is not proportional to their byte size.
    const weight = Math.min(this.bytes, 4 * MIB + size * 8 + rows * 256);
    await new Promise<void>((start) => { this.#waiting.push({ weight, start }); this.#drain(); });
    try { return await work(); }
    finally { this.#used -= weight; this.#drain(); }
  }
  #drain(): void {
    while (this.#waiting.length && this.#used + this.#waiting[0]!.weight <= this.bytes) {
      const next = this.#waiting.shift()!;
      this.#used += next.weight; next.start();
    }
  }
}

/** Shared across pipeline instances, not one allowance per gym or request. */
export const previewBudget = new PreviewBudget();

export async function previewDeadline<T>(milliseconds: number, work: (signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController(), ends = performance.now() + milliseconds;
  const abort = () => controller.abort(new DOMException('Import preview deadline exceeded', 'TimeoutError'));
  const timer = setTimeout(abort, milliseconds);
  const check = () => { if (performance.now() >= ends) abort(); controller.signal.throwIfAborted(); };
  // Finished work keeps its result, even if best-effort cleanup ran past the deadline.
  try { check(); return await work(controller.signal, check); }
  catch (error) {
    // Each provider rejects a cancelled read with its own error, so the signal says what happened.
    if (controller.signal.aborted) throw new AppError('unavailable', t('imports/pipeline:previewTimedOut'));
    throw error;
  }
  finally {
    clearTimeout(timer);
    // A provider can fail one of several metadata reads first. Cancel its remaining reads on every exit.
    controller.abort();
  }
}
