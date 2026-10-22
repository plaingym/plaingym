// SPDX-License-Identifier: AGPL-3.0-only
import type { Id, IsoInstant } from '@plaingym/shared/contracts';
import { instant } from './common.js';

export interface JobStats {
  readonly pending: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly oldestPendingAt: IsoInstant | null;
}
/** Implemented by the jobs module; callers never read jobs rows. */
export interface JobStatsQuery { get(gymId: Id): Promise<JobStats>; }
export interface JobStatsFixture {
  readonly gymId: Id | null;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly runAt: IsoInstant;
}
export class FakeJobStatsQuery implements JobStatsQuery {
  readonly #jobs: readonly JobStatsFixture[];
  constructor(jobs: readonly JobStatsFixture[] = []) { this.#jobs = structuredClone(jobs); }
  async get(gymId: Id): Promise<JobStats> {
    const result: { -readonly [K in keyof JobStats]: JobStats[K] } = {
      pending: 0, running: 0, succeeded: 0, failed: 0, oldestPendingAt: null,
    };
    for (const job of this.#jobs) {
      if (job.gymId !== gymId) continue;
      result[job.status]++;
      if (job.status === 'pending' && (result.oldestPendingAt === null || instant(job.runAt) < instant(result.oldestPendingAt)))
        result.oldestPendingAt = job.runAt;
    }
    return result;
  }
}
