// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { FakeJobs, resetFailedJobs, type FailedJob } from './index.js';

it('resets only the planned jobs the queue still holds as failed and records each reset once', async () => {
  const clock = new TestClock('2028-03-01T09:00:00Z'), jobs = new FakeJobs(clock), gymId = 'gym-a';
  jobs.handle('work', async () => { throw new Error('Unavailable'); });
  for (const key of ['skip', 'taken', 'reset'])
    await jobs.enqueue('work', {}, { gymId, timezone: 'UTC', idempotencyKey: key, maxAttempts: 1 });
  while (await jobs.runNext());
  const failed = await jobs.failedJobs('work', ['skip', 'taken', 'reset'], { gymId });
  expect(failed).toHaveLength(3);
  const runAt = new Date('2028-03-01T10:00:00Z');
  const plan = vi.fn(async (job: FailedJob) => {
    if (job.idempotencyKey === 'skip') return null;
    // Another sweep resets this job first, so the helper's compare-and-set refuses it.
    if (job.idempotencyKey === 'taken') await jobs.retryFailed(job.jobId, { gymId, runAt: clock.now() });
    return runAt;
  });
  const record = vi.fn(async (_job: FailedJob, _runAt: Date) => {});
  expect(await resetFailedJobs(jobs, 'work', ['skip', 'taken', 'reset'], gymId, plan, record)).toBe(1);
  expect(plan).toHaveBeenCalledTimes(3);
  const reset = failed.find(job => job.idempotencyKey === 'reset')!;
  expect(record).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalledWith(reset, runAt);
  expect(jobs.jobs.map(job => [job.options.idempotencyKey, job.status, job.runAt])).toEqual([
    ['skip', 'failed', clock.now()], ['taken', 'queued', clock.now()], ['reset', 'queued', runAt],
  ]);
});
