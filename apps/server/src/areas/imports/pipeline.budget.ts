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
export const PREVIEW_LEASE_MS = 60_000;

export interface PreviewSummary { totalRows: number; create: number; update: number; skip: number; errors: number }
/** Summary written after all immutable preview row files. */
export interface StoredPreview extends PreviewSummary { generation: string; files: number; startedAt: string; createdAt: string }
export interface PendingPreview {
  id: string; gymId: string; uploadId: string; expiresAt: string; leaseUntil: number;
  startedAt: number; stopped: boolean; stop(): void;
  status: 'queued' | 'computing'; admitted: Promise<void>; finished: Promise<StoredPreview>;
}

type WaitingPreview = { weight: number; signal: AbortSignal | undefined; start: () => void; cancel: () => void };
type GymPreviews = { waiting: WaitingPreview[]; running: number; priority: number };
const timedOut = () => new AppError('unavailable', t('imports/pipeline:previewTimedOut'));

/** Round-robin admission across gyms, in arrival order within each gym. */
export class PreviewBudget {
  /** Coalescing belongs to the same coordinator as process-wide admission. Keys include the gym and upload. */
  readonly pending = new Map<string, PendingPreview>();
  #used = 0;
  #waitingCount = 0;
  #admissionSequence = 0;
  readonly #gyms = new Map<string, GymPreviews>();
  constructor(readonly bytes = PREVIEW_MEMORY_BYTES, readonly queueLimit = PREVIEW_QUEUE_LIMIT,
    readonly gymQueueLimit = PREVIEW_GYM_QUEUE_LIMIT) {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid preview memory budget');
    if (!Number.isSafeInteger(queueLimit) || queueLimit < 0) throw new Error('Invalid preview queue limit');
    if (!Number.isSafeInteger(gymQueueLimit) || gymQueueLimit < 0) throw new Error('Invalid preview gym queue limit');
  }
  run<T>(gymId: string, size: number, rows: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(timedOut());
    // Include per-row overhead for narrow CSVs, whose parsed size is not proportional to their byte size.
    const weight = Math.min(this.bytes, 4 * MIB + size * 8 + rows * 256);
    const waits = this.#waitingCount > 0 || this.#used + weight > this.bytes;
    // Give a new gym a turn ahead of the gym just served, while preserving older turns.
    const gym: GymPreviews = this.#gyms.get(gymId) ?? { waiting: [], running: 0, priority: this.#admissionSequence - 0.5 };
    if (waits && (this.#waitingCount >= this.queueLimit || gym.waiting.length >= this.gymQueueLimit))
      throw new AppError('unavailable', t('imports/pipeline:previewBusy'));
    const admitted = new Promise<void>((resolve, reject) => {
      const cancel = () => {
        const index = gym.waiting.indexOf(entry);
        if (index === -1) return;
        gym.waiting.splice(index, 1);
        this.#waitingCount--;
        if (gym.running === 0 && gym.waiting.length === 0) this.#gyms.delete(gymId);
        signal?.removeEventListener('abort', onAbort);
        reject(timedOut());
      };
      const onAbort = () => {
        cancel();
        this.#drain();
      };
      const entry: WaitingPreview = { weight, signal, cancel, start: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      } };
      gym.waiting.push(entry);
      this.#gyms.set(gymId, gym);
      this.#waitingCount++;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#drain();
    });
    return (async () => {
      await admitted;
      try { return await work(); }
      finally {
        this.#used -= weight;
        gym.running--;
        if (gym.running === 0 && gym.waiting.length === 0) this.#gyms.delete(gymId);
        this.#drain();
      }
    })();
  }
  #drain(): void {
    while (this.#waitingCount > 0) {
      let gym: GymPreviews | undefined;
      // Equal priorities belong to gyms awaiting their first admission, in request order.
      for (const candidate of this.#gyms.values()) {
        if (candidate.waiting.length > 0 && (!gym || candidate.priority < gym.priority)) gym = candidate;
      }
      if (!gym) return;
      const next = gym.waiting[0]!;
      // Draining during an abort event can reach another entry with the same signal.
      if (next.signal?.aborted) { next.cancel(); continue; }
      // Wait for the selected preview to fit before admitting work from a later turn.
      if (this.#used + next.weight > this.bytes) return;
      gym.waiting.shift();
      this.#waitingCount--;
      gym.running++;
      gym.priority = ++this.#admissionSequence;
      this.#used += next.weight;
      next.start();
    }
  }
}

/** Shared across pipeline instances, not one allowance per gym or request. */
export const previewBudget = new PreviewBudget();

export async function previewDeadline<T>(milliseconds: number, work: (signal: AbortSignal, check: () => void) => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(), ends = performance.now() + milliseconds;
  const abort = () => controller.abort(new DOMException('Import preview deadline exceeded', 'TimeoutError'));
  const timer = setTimeout(abort, milliseconds);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
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
      throw timedOut();
    throw error;
  }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // A provider can fail one of several metadata reads first. Cancel its remaining reads on every exit.
    controller.abort();
  }
}
