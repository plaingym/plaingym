// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeJobStatsQuery } from '../../core/interfaces/job-stats.js';
import { FakeJobs, PostgresJobs, withJobTransaction, type JobTransaction } from './index.js';

const db = useTestDatabase(), factory = createFactories(db);
it.each(['postgres', 'fake'] as const)('commits and rolls back recovery with the caller transaction: %s', async provider => {
  const gymId = uuidv7(), foreign = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
  await factory('gyms', gymId); await factory('gyms', foreign);
  const queue = provider === 'postgres' ? new PostgresJobs({ database: db, clock }) : new FakeJobs(clock);
  const name = 'test.recovery', key = uuidv7(), options = { gymId, timezone: 'UTC', idempotencyKey: key, maxAttempts: 1 };
  queue.handle(name, async () => { throw new Error('Job failed'); });
  const { jobId } = await queue.enqueue(name, {}, options); await queue.runNext();
  let expired: JobTransaction | undefined;
  await expect(withJobTransaction(db.forGym, gymId, async transaction => {
    expired = transaction;
    expect(await queue.failedJobs(name, [key], { gymId }, transaction)).toHaveLength(1);
    expect(await queue.retryFailed(jobId, { gymId, runAt: clock.now() }, transaction)).toBe(true);
    expect(await queue.retryFailed(jobId, { gymId, runAt: clock.now() }, transaction)).toBe(false);
    expect(await queue.failedJobs(name, [key], { gymId }, transaction)).toEqual([]);
    throw new Error('Rollback');
  })).rejects.toThrow('Rollback');
  expect(await queue.failedJobs(name, [key], { gymId })).toHaveLength(1);
  await expect(queue.retryFailed(jobId, { gymId, runAt: clock.now() }, expired)).rejects.toThrow('active');
  await withJobTransaction(db.forGym, gymId, async transaction => {
    await expect(queue.failedJobs(name, [key], { gymId: foreign }, transaction)).rejects.toThrow('gym');
    await expect(queue.retryFailed(jobId, { gymId: foreign, runAt: clock.now() }, transaction)).rejects.toThrow('gym');
    expect(await queue.retryFailed(jobId, { gymId, runAt: clock.now() }, transaction)).toBe(true);
  });
  expect(await queue.failedJobs(name, [key], { gymId })).toEqual([]);
  expect(await queue.runNext()).toBe(true);
});

it('lets only one open transaction stage a fake job reset', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z'), queue = new FakeJobs(clock);
  await factory('gyms', gymId);
  const name = 'test.recovery', key = uuidv7();
  queue.handle(name, async () => { throw new Error('Job failed'); });
  const { jobId } = await queue.enqueue(name, {}, { gymId, timezone: 'UTC', idempotencyKey: key, maxAttempts: 1 });
  await queue.runNext();
  const staged = Promise.withResolvers<boolean>(), release = Promise.withResolvers<void>();
  const winnerAt = clock.now(), contenderAt = new Date(winnerAt.getTime() + 1000);
  const winner = withJobTransaction(db.forGym, gymId, async transaction => {
    staged.resolve(await queue.retryFailed(jobId, { gymId, runAt: winnerAt }, transaction));
    await release.promise;
  });
  try {
    expect(await Promise.race([staged.promise, winner])).toBe(true);
    expect(await withJobTransaction(db.forGym, gymId, async transaction => {
      expect(await queue.failedJobs(name, [key], { gymId }, transaction)).toHaveLength(1);
      return queue.retryFailed(jobId, { gymId, runAt: contenderAt }, transaction);
    })).toBe(false);
    expect(await queue.retryFailed(jobId, { gymId, runAt: contenderAt })).toBe(false);
    expect(queue.jobs[0]).toMatchObject({ status: 'failed', attempt: 1 });
  } finally {
    release.resolve();
    await winner;
  }
  expect(queue.jobs[0]).toMatchObject({ status: 'queued', attempt: 0, runAt: winnerAt });
});

it('stages fake acknowledgments until commit and counts a new failure after retry', async () => {
  const gymId = uuidv7(), foreign = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
  const queue = new FakeJobs(clock);
  await factory('gyms', gymId); await factory('gyms', foreign);
  const name = 'test.recovery', idempotencyKey = 'failed';
  queue.handle(name, async () => { throw new Error('Job failed'); });
  const { jobId } = await queue.enqueue(name, {}, { gymId, timezone: 'UTC', idempotencyKey, maxAttempts: 1 });
  await queue.runNext();
  const before = queue.jobs[0]!;
  const failed = [{ jobId, idempotencyKey, failedAt: before.runAt }];
  const stats = async () => {
    const job = queue.jobs[0]!;
    return new FakeJobStatsQuery([{ gymId, status: 'failed', runAt: job.runAt.toISOString(),
      acknowledged: job.acknowledgedAt !== undefined }]).get(gymId);
  };
  expect(await stats()).toMatchObject({ failed: 1, oldestFailureAt: before.runAt.toISOString() });
  clock.advance(1000);
  const at = clock.now();
  expect(await queue.acknowledgeFailed(jobId, { gymId: foreign, at })).toBe(false);
  expect(queue.jobs[0]).toEqual(before);
  const stage = async (transaction: JobTransaction) => {
    expect(await queue.acknowledgeFailed(jobId, { gymId, at }, transaction)).toBe(true);
    expect(await queue.acknowledgeFailed(jobId, { gymId, at }, transaction)).toBe(false);
    expect(await queue.failedJobs(name, [idempotencyKey], { gymId }, transaction)).toEqual(failed);
    expect(queue.jobs[0]).toEqual(before);
  };
  await expect(withJobTransaction(db.forGym, gymId, async transaction => {
    await stage(transaction);
    throw new Error('Rollback');
  })).rejects.toThrow('Rollback');
  expect(queue.jobs[0]).toEqual(before);

  await withJobTransaction(db.forGym, gymId, stage);
  expect(await queue.acknowledgeFailed(jobId, { gymId, at: new Date(at.getTime() + 1000) })).toBe(false);
  expect(queue.jobs[0]).toEqual({ ...before, acknowledgedAt: at });
  expect(await queue.failedJobs(name, [idempotencyKey], { gymId })).toEqual(failed);
  expect(await stats()).toMatchObject({ failed: 0, oldestFailureAt: null });
  expect(await queue.retryFailed(jobId, { gymId, runAt: at })).toBe(true);
  expect(queue.jobs[0]).toMatchObject({ status: 'queued', attempt: 0, runAt: at });
  expect(queue.jobs[0]?.acknowledgedAt).toBeUndefined();
  await queue.runNext();
  expect(await stats()).toMatchObject({ failed: 1, oldestFailureAt: at.toISOString() });
});
