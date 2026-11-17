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
export const PREVIEW_QUEUE_LIMIT = 16;
export const PREVIEW_GYM_QUEUE_LIMIT = 3;
export const PREVIEW_LEASE_INTERVAL_MS = 10_000;
export const PREVIEW_LEASE_MS = 30_000;

export interface PreviewSummary { totalRows: number; create: number; update: number; skip: number; errors: number }
/** Summary written after all immutable preview row files. */
export interface StoredPreview extends PreviewSummary { generation: string; files: number; startedAt: string; createdAt: string }
export interface PendingPreview {
  id: string; gymId: string; uploadId: string; expiresAt: string; leaseUntil: number;
  status: 'queued' | 'computing'; admitted: Promise<void>; finished: Promise<StoredPreview>;
}

/** FIFO admission keeps small previews concurrent without allowing them to starve a large file. */
export class PreviewBudget {
  /** Coalescing belongs to the same coordinator as process-wide admission. Keys include the gym and upload. */
  readonly pending = new Map<string, PendingPreview>();
  #used = 0;
  readonly #waiting: { gymId: string; weight: number; start: () => void }[] = [];
  constructor(readonly bytes = PREVIEW_MEMORY_BYTES, readonly queueLimit = PREVIEW_QUEUE_LIMIT,
    readonly gymQueueLimit = PREVIEW_GYM_QUEUE_LIMIT) {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid preview memory budget');
    if (!Number.isSafeInteger(queueLimit) || queueLimit < 0) throw new Error('Invalid preview queue limit');
    if (!Number.isSafeInteger(gymQueueLimit) || gymQueueLimit < 0) throw new Error('Invalid preview gym queue limit');
  }
  run<T>(gymId: string, size: number, rows: number, work: () => Promise<T>): Promise<T> {
    // Include per-row overhead for narrow CSVs, whose parsed size is not proportional to their byte size.
    const weight = Math.min(this.bytes, 4 * MIB + size * 8 + rows * 256);
    const waits = this.#waiting.length > 0 || this.#used + weight > this.bytes;
    if (waits && (this.#waiting.length >= this.queueLimit
      || this.#waiting.filter(entry => entry.gymId === gymId).length >= this.gymQueueLimit))
      throw new AppError('unavailable', t('imports/pipeline:previewBusy'));
    const admitted = new Promise<void>((start) => { this.#waiting.push({ gymId, weight, start }); this.#drain(); });
    return (async () => {
      await admitted;
      try { return await work(); }
      finally { this.#used -= weight; this.#drain(); }
    })();
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
    // Local reads use the signal's reason or AbortError; S3 can reject with AbortError.
    // A concurrent storage or mapper failure must keep its cause even after the timer fires.
    // The S3 client also names connection resets TimeoutError, so that name needs a DOMException.
    if (controller.signal.aborted && (error === controller.signal.reason
      || error instanceof Error && error.name === 'AbortError'
      || error instanceof DOMException && error.name === 'TimeoutError'))
      throw new AppError('unavailable', t('imports/pipeline:previewTimedOut'));
    throw error;
  }
  finally {
    clearTimeout(timer);
    // A provider can fail one of several metadata reads first. Cancel its remaining reads on every exit.
    controller.abort();
  }
}
