// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
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
