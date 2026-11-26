// SPDX-License-Identifier: AGPL-3.0-only
import { logError } from '../../core/log.js';
import type { FailedJob, JobRecovery } from './index.js';

/**
 * Resets the gym's failed `name` jobs with these keys, outside any transaction. `plan` returns a job's run time,
 * or null to leave it failed; `record` runs only after the queue's compare-and-set reset that job, so a job is
 * reset and recorded at most once even when sweeps overlap. A failed `record` is logged and the batch goes on;
 * `plan` and reset errors propagate. Returns the number reset.
 */
export async function resetFailedJobs(
  jobs: Pick<JobRecovery, 'failedJobs' | 'retryFailed'>,
  name: string,
  keys: readonly string[],
  gymId: string,
  plan: (job: FailedJob) => Promise<Date | null>,
  record: (job: FailedJob, runAt: Date) => Promise<void>,
): Promise<number> {
  let reset = 0;
  for (const job of await jobs.failedJobs(name, keys, { gymId })) {
    const runAt = await plan(job);
    if (!runAt || !await jobs.retryFailed(job.jobId, { gymId, runAt })) continue;
    // The job is reset either way; a lost record only shortens the history it feeds, so the batch goes on.
    try {
      await record(job, runAt);
    } catch (error) {
      logError('jobs.reset_record_failed', { gymId, name, jobId: job.jobId }, error);
    }
    reset++;
  }
  return reset;
}
