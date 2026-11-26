// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
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

it('logs a failed record and still resets and records the rest of the batch', async () => {
  const clock = new TestClock('2028-03-01T09:00:00Z'), jobs = new FakeJobs(clock), gymId = 'gym-a';
  jobs.handle('work', async () => { throw new Error('Unavailable'); });
  for (const key of ['first', 'second'])
    await jobs.enqueue('work', { member: 'payload-value' }, { gymId, timezone: 'UTC', idempotencyKey: key, maxAttempts: 1 });
  while (await jobs.runNext());
  const failed = await jobs.failedJobs('work', ['first', 'second'], { gymId });
  expect(failed).toHaveLength(2);
  const runAt = new Date('2028-03-01T10:00:00Z'), first = failed.find(job => job.idempotencyKey === 'first')!;
  const record = vi.fn(async (job: FailedJob, _runAt: Date) => {
    if (job.jobId === first.jobId) throw new Error('Audit write failed for payload-value');
  });
  const lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try {
    expect(await resetFailedJobs(jobs, 'work', ['first', 'second'], gymId, async () => runAt, record)).toBe(2);
  } finally {
    setLogSink(previous);
  }
  expect(record).toHaveBeenCalledTimes(2);
  expect(record.mock.calls.map(([job]) => job.idempotencyKey)).toEqual(['first', 'second']);
  expect(jobs.jobs.map(job => [job.options.idempotencyKey, job.status, job.runAt])).toEqual([
    ['first', 'queued', runAt], ['second', 'queued', runAt],
  ]);
  const logged = lines.map(line => JSON.parse(line) as Record<string, unknown>);
  expect(logged).toEqual([expect.objectContaining({
    level: 'error', event: 'jobs.reset_record_failed', gymId, name: 'work', jobId: first.jobId,
    error: expect.objectContaining({ name: 'Error' }),
  })]);
  expect(lines.join('\n')).not.toContain('payload-value');
  expect(logged[0]).not.toHaveProperty('payload');
});
