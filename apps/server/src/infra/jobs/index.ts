// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';

export interface JobOptions {
  readonly gymId: string;
  readonly timezone: string;
  readonly runAt?: Date;
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
}
export interface JobContext {
  readonly jobId: string;
  readonly gymId: string;
  readonly timezone: string;
  readonly attempt: number;
  readonly clock: Clock;
}
export type JobHandler = (payload: unknown, context: JobContext) => Promise<void>;
export interface Jobs {
  enqueue(name: string, payload: unknown, options: JobOptions): Promise<{ jobId: string }>;
  handle(name: string, handler: JobHandler): void;
  schedule(name: string, cron: string, handler: JobHandler): void;
}
export interface FakeJob {
  id: string;
  name: string;
  payload: unknown;
  options: JobOptions;
  runAt: Date;
  attempt: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
}

export class FakeJobs implements Jobs {
  readonly #jobs: FakeJob[] = [];
  readonly #handlers = new Map<string, JobHandler>();
  readonly #schedules = new Map<string, string>();
  readonly #keys = new Map<string, string>();
  constructor(readonly clock: Clock = systemClock, readonly perGymConcurrency = 1) {
    if (!Number.isSafeInteger(perGymConcurrency) || perGymConcurrency < 1) throw new Error('Invalid concurrency cap');
  }
  get jobs(): readonly FakeJob[] {
    return structuredClone(this.#jobs);
  }
  get schedules(): ReadonlyMap<string, string> {
    return new Map(this.#schedules);
  }
  handle(name: string, handler: JobHandler): void {
    if (!name || this.#handlers.has(name)) throw new Error(`Duplicate or empty job handler: ${name}`);
    this.#handlers.set(name, handler);
  }
  schedule(name: string, cron: string, handler: JobHandler): void {
    if (cron.trim().split(/\s+/).length !== 5) throw new Error('Expected a five-field cron expression');
    this.handle(name, handler);
    this.#schedules.set(name, cron);
  }
  async enqueue(name: string, payload: unknown, options: JobOptions): Promise<{ jobId: string }> {
    assertNoTransaction('jobs.enqueue');
    if (!name || !options.gymId) throw new Error('Job name and gym are required');
    new Intl.DateTimeFormat('en', { timeZone: options.timezone });
    if (
      options.maxAttempts !== undefined &&
      (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1)
    ) {
      throw new Error('maxAttempts must be a positive integer');
    }
    const runAt = options.runAt ?? this.clock.now();
    if (!Number.isFinite(runAt.getTime())) throw new Error('Invalid job time');
    const key =
      options.idempotencyKey === undefined
        ? undefined
        : JSON.stringify([options.gymId, name, options.idempotencyKey]);
    const existing = key === undefined ? undefined : this.#keys.get(key);
    if (existing) return { jobId: existing };
    const id = `job_${this.#jobs.length + 1}`;
    this.#jobs.push({
      id,
      name,
      payload: structuredClone(payload),
      options: structuredClone(options),
      runAt: new Date(runAt),
      attempt: 0,
      status: 'queued',
    });
    if (key !== undefined) this.#keys.set(key, id);
    return { jobId: id };
  }
  /** Explicitly fires a scheduled occurrence; the fake does not interpret cron time. */
  async triggerSchedule(
    name: string,
    gyms: readonly Pick<JobOptions, 'gymId' | 'timezone'>[],
    occurrence: string,
  ): Promise<void> {
    assertNoTransaction('jobs.triggerSchedule');
    if (!this.#schedules.has(name)) throw new Error(`Unknown schedule: ${name}`);
    for (const gym of gyms) await this.enqueue(name, {}, { ...gym, idempotencyKey: occurrence });
  }
  async runNext(): Promise<boolean> {
    assertNoTransaction('jobs.runNext');
    const running = new Map<string, number>();
    for (const item of this.#jobs) {
      if (item.status === 'running') running.set(item.options.gymId, (running.get(item.options.gymId) ?? 0) + 1);
    }
    const job = this.#jobs.find((item) => item.status === 'queued' && item.runAt <= this.clock.now()
      && (running.get(item.options.gymId) ?? 0) < this.perGymConcurrency);
    if (!job) return false;
    const handler = this.#handlers.get(job.name);
    if (!handler) throw new Error(`No handler for ${job.name}`);
    job.status = 'running';
    job.attempt++;
    try {
      await handler(structuredClone(job.payload), {
        jobId: job.id,
        gymId: job.options.gymId,
        timezone: job.options.timezone,
        attempt: job.attempt,
        clock: this.clock,
      });
      job.status = 'completed';
    } catch {
      job.status = job.attempt >= (job.options.maxAttempts ?? 3) ? 'failed' : 'queued';
      job.runAt = new Date(this.clock.now().getTime() + 1000 * 2 ** (job.attempt - 1));
    }
    return true;
  }
}

export { PostgresJobs, PostgresJobStatsQuery, startJobsWorker } from './postgres.js';
export type { PostgresJobsOptions, WorkerOptions, JobWorker, SystemJobContext, SystemJobHandler, SystemJobOptions } from './postgres.js';
