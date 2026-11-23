// SPDX-License-Identifier: AGPL-3.0-only
import type { Id, IsoInstant } from '@plaingym/shared/contracts';
import { instant } from './common.js';

export interface JobStats {
  readonly pending: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly oldestPendingAt: IsoInstant | null;
  /** Final failure time of the oldest unacknowledged failed job, or null when none remain. */
  readonly oldestFailureAt: IsoInstant | null;
  /**
   * An opaque digest of the unacknowledged failed jobs, each by its ID, the time it failed and how many times it has
   * failed (`none` when there are none); it changes when that set changes or when one of those jobs fails again.
   */
  readonly failedVersion: string;
}
/**
 * The fake's version: each `id:runAt-milliseconds:failureCount`, sorted by ID and joined, or a short FNV-1a hash of
 * them when they don't fit the contract's 64 characters.
 */
function fakeVersion(ids: string): string {
  if (ids.length <= 64) return ids;
  let hash = 0x811c9dc5;
  for (let index = 0; index < ids.length; index++) hash = Math.imul(hash ^ ids.charCodeAt(index), 0x01000193) >>> 0;
  return 'fnv-' + hash.toString(16).padStart(8, '0');
}
/** Implemented by the jobs module; callers never read jobs rows. */
export interface JobStatsQuery { get(gymId: Id): Promise<JobStats>; }
export interface JobStatsFixture {
  readonly id?: string;
  readonly gymId: Id | null;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly runAt: IsoInstant;
  readonly acknowledged?: boolean;
  /** How many times the job has failed; 0 when unset. */
  readonly failureCount?: number;
}
export class FakeJobStatsQuery implements JobStatsQuery {
  readonly #jobs: readonly JobStatsFixture[];
  constructor(jobs: readonly JobStatsFixture[] = []) { this.#jobs = structuredClone(jobs); }
  async get(gymId: Id): Promise<JobStats> {
    const result: { -readonly [K in keyof JobStats]: JobStats[K] } = {
      pending: 0, running: 0, succeeded: 0, failed: 0, oldestPendingAt: null, oldestFailureAt: null, failedVersion: 'none',
    };
    const failures: { id: string; at: number; count: number }[] = [];
    for (const [index, job] of this.#jobs.entries()) {
      if (job.gymId !== gymId || (job.status === 'failed' && job.acknowledged)) continue;
      result[job.status]++;
      if (job.status === 'failed')
        failures.push({ id: job.id ?? 'job-' + index, at: instant(job.runAt), count: job.failureCount ?? 0 });
      if (job.status === 'pending' && (result.oldestPendingAt === null || instant(job.runAt) < instant(result.oldestPendingAt)))
        result.oldestPendingAt = job.runAt;
      if (job.status === 'failed' && (result.oldestFailureAt === null || instant(job.runAt) < instant(result.oldestFailureAt)))
        result.oldestFailureAt = job.runAt;
    }
    if (failures.length) result.failedVersion = fakeVersion(failures
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(failure => `${failure.id}:${failure.at}:${failure.count}`).join(','));
    return result;
  }
}
