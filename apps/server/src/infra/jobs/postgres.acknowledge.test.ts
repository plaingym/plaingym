// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { asc, inArray } from 'drizzle-orm';
import { jobs, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { PostgresJobs, withJobTransaction } from './index.js';

const db = useTestDatabase(), factory = createFactories(db);
const rows = (ids: readonly string[]) => db.forSystem(tx => tx.select().from(jobs).where(inArray(jobs.id, [...ids])).orderBy(asc(jobs.id)));

describe('failInterrupted', () => {
  it('fails and acknowledges only running jobs with the given names, install jobs included', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z'), earlier = new Date('2026-10-31T23:00:00Z');
    await factory('gyms', gymId);
    const queue = new PostgresJobs({ database: db, clock });
    const running = await factory('jobs', gymId, { gymId: null, name: 'health.backup', status: 'running', attempts: 1,
      runAt: earlier, lockToken: uuidv7(), lockedUntil: new Date('2026-11-01T00:05:00Z') });
    const pending = await factory('jobs', gymId, { gymId: null, name: 'health.backup', status: 'pending', runAt: earlier });
    const failed = await factory('jobs', gymId, { gymId: null, name: 'health.backup', status: 'failed', runAt: earlier, lastError: 'Earlier' });
    const other = await factory('jobs', gymId, { name: 'billing.runner.charge', status: 'running', attempts: 1, runAt: earlier,
      lockToken: uuidv7(), lockedUntil: new Date('2026-11-01T00:05:00Z') });
    const untouched = [pending.id, failed.id, other.id] as string[];
    const before = await rows(untouched);
    const at = clock.now();
    expect(await queue.failInterrupted(['health.backup'], { at, reason: 'Interrupted' })).toBe(1);
    const [settled] = await rows([running.id as string]);
    expect(settled).toMatchObject({ gymId: null, status: 'failed', acknowledgedAt: at, runAt: at, lastError: 'Interrupted',
      lockToken: null, lockedUntil: null, attempts: 1 });
    expect(await rows(untouched)).toEqual(before);
    expect(await queue.failInterrupted(['health.backup'], { at, reason: 'Interrupted' })).toBe(0);
    expect(await rows(untouched)).toEqual(before);
  });

  it('rejects an empty name list, an invalid time and an open transaction', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z'), queue = new PostgresJobs({ database: db, clock });
    await factory('gyms', gymId);
    await expect(queue.failInterrupted([], { at: clock.now(), reason: 'x' })).rejects.toThrow('No job names');
    await expect(queue.failInterrupted(['health.backup'], { at: new Date(Number.NaN), reason: 'x' })).rejects.toThrow('Invalid job time');
    await withJobTransaction(db.forGym, gymId, async () => {
      await expect(queue.failInterrupted(['health.backup'], { at: clock.now(), reason: 'x' })).rejects.toThrow();
    });
  });
});

describe('acknowledgeFailedThrough', () => {
  it('acknowledges only the gym\'s failed jobs that failed by the cutoff', async () => {
    const gymA = uuidv7(), gymB = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
    await factory('gyms', gymA); await factory('gyms', gymB);
    const queue = new PostgresJobs({ database: db, clock });
    const through = clock.now(), minute = 60_000;
    const before = await factory('jobs', gymA, { name: 'test.ack', status: 'failed', runAt: new Date(through.getTime() - minute) });
    const after = await factory('jobs', gymA, { name: 'test.ack', status: 'failed', runAt: new Date(through.getTime() + minute) });
    const pending = await factory('jobs', gymA, { name: 'test.ack', status: 'pending', runAt: new Date(through.getTime() - minute) });
    const foreign = await factory('jobs', gymB, { name: 'test.ack', status: 'failed', runAt: new Date(through.getTime() - minute) });
    const at = new Date(through.getTime() + 5 * minute);
    expect(await queue.acknowledgeFailedThrough({ gymId: gymA, through, at })).toBe(1);
    const read = await rows([before.id, after.id, pending.id, foreign.id] as string[]);
    const byId = (id: unknown) => read.find(row => row.id === id)!;
    expect(byId(before.id)).toMatchObject({ status: 'failed', acknowledgedAt: at });
    expect(byId(after.id)).toMatchObject({ status: 'failed', acknowledgedAt: null });
    expect(byId(pending.id)).toMatchObject({ status: 'pending', acknowledgedAt: null });
    expect(byId(foreign.id)).toMatchObject({ status: 'failed', acknowledgedAt: null });
    expect(await queue.acknowledgeFailedThrough({ gymId: gymA, through, at: new Date(at.getTime() + minute) })).toBe(0);
    expect((await rows([before.id as string]))[0]!.acknowledgedAt).toEqual(at);
  });

  it('leaves an acknowledged job visible to recovery', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
    await factory('gyms', gymId);
    const queue = new PostgresJobs({ database: db, clock }), name = 'test.ack.recovery', key = uuidv7();
    queue.handle(name, async () => { throw new Error('Job failed'); });
    const { jobId } = await queue.enqueue(name, {}, { gymId, timezone: 'UTC', idempotencyKey: key, maxAttempts: 1 });
    await queue.runNext();
    expect(await queue.acknowledgeFailedThrough({ gymId, through: clock.now(), at: clock.now() })).toBe(1);
    expect((await queue.failedJobs(name, [key], { gymId })).map(job => job.jobId)).toEqual([jobId]);
  });

  it('commits and rolls back with the caller transaction, and checks its gym and times', async () => {
    const gymA = uuidv7(), gymB = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
    await factory('gyms', gymA); await factory('gyms', gymB);
    const queue = new PostgresJobs({ database: db, clock }), through = clock.now();
    const job = await factory('jobs', gymA, { name: 'test.ack', status: 'failed', runAt: new Date(through.getTime() - 1000) });
    await expect(withJobTransaction(db.forGym, gymA, async transaction => {
      expect(await queue.acknowledgeFailedThrough({ gymId: gymA, through, at: through }, transaction)).toBe(1);
      throw new Error('Rollback');
    })).rejects.toThrow('Rollback');
    expect((await rows([job.id as string]))[0]!.acknowledgedAt).toBeNull();
    await withJobTransaction(db.forGym, gymA, async transaction => {
      await expect(queue.acknowledgeFailedThrough({ gymId: gymB, through, at: through }, transaction)).rejects.toThrow('gym');
      await expect(queue.acknowledgeFailedThrough({ gymId: gymA, through: new Date(Number.NaN), at: through }, transaction))
        .rejects.toThrow('Invalid job time');
      expect(await queue.acknowledgeFailedThrough({ gymId: gymA, through, at: through }, transaction)).toBe(1);
    });
    expect((await rows([job.id as string]))[0]!.acknowledgedAt).toEqual(through);
    await expect(queue.acknowledgeFailedThrough({ gymId: 'not-an-id', through, at: through })).rejects.toThrow();
  });
});
