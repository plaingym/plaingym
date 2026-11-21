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
  /** An opaque digest of the IDs of the unacknowledged failed jobs (`none` when there are none); it changes when that set does. */
  readonly failedVersion: string;
}
/** The fake's version: the sorted, joined IDs, or a short FNV-1a hash of them when they don't fit the contract's 64 characters. */
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
}
export class FakeJobStatsQuery implements JobStatsQuery {
  readonly #jobs: readonly JobStatsFixture[];
  constructor(jobs: readonly JobStatsFixture[] = []) { this.#jobs = structuredClone(jobs); }
  async get(gymId: Id): Promise<JobStats> {
    const result: { -readonly [K in keyof JobStats]: JobStats[K] } = {
      pending: 0, running: 0, succeeded: 0, failed: 0, oldestPendingAt: null, oldestFailureAt: null, failedVersion: 'none',
    };
    const failedIds: string[] = [];
    for (const [index, job] of this.#jobs.entries()) {
      if (job.gymId !== gymId || (job.status === 'failed' && job.acknowledged)) continue;
      result[job.status]++;
      if (job.status === 'failed') failedIds.push(job.id ?? 'job-' + index);
      if (job.status === 'pending' && (result.oldestPendingAt === null || instant(job.runAt) < instant(result.oldestPendingAt)))
        result.oldestPendingAt = job.runAt;
      if (job.status === 'failed' && (result.oldestFailureAt === null || instant(job.runAt) < instant(result.oldestFailureAt)))
        result.oldestFailureAt = job.runAt;
    }
    if (failedIds.length) result.failedVersion = fakeVersion(failedIds.sort().join(','));
    return result;
  }
}
