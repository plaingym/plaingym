// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { asc, inArray } from 'drizzle-orm';
import { jobs, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { PostgresJobs, PostgresJobStatsQuery, withJobTransaction } from './index.js';

const db = useTestDatabase(), factory = createFactories(db);
const rows = (ids: readonly string[]) => db.forSystem(tx => tx.select().from(jobs).where(inArray(jobs.id, [...ids])).orderBy(asc(jobs.id)));
const stats = new PostgresJobStatsQuery(db);

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

describe('acknowledgeFailedVersion', () => {
  it('acknowledges exactly the gym\'s failed jobs the version named', async () => {
    const gymA = uuidv7(), gymB = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
    await factory('gyms', gymA); await factory('gyms', gymB);
    const queue = new PostgresJobs({ database: db, clock });
    const now = clock.now(), minute = 60_000;
    expect((await stats.get(gymA)).failedVersion).toBe('none');
    const earlier = await factory('jobs', gymA, { name: 'test.ack', status: 'failed', runAt: new Date(now.getTime() - minute) });
    const later = await factory('jobs', gymA, { name: 'test.ack', status: 'failed', runAt: new Date(now.getTime() + minute) });
    const pending = await factory('jobs', gymA, { name: 'test.ack', status: 'pending', runAt: new Date(now.getTime() - minute) });
    const foreign = await factory('jobs', gymB, { name: 'test.ack', status: 'failed', runAt: new Date(now.getTime() - minute) });
    const read = await stats.get(gymA), foreignVersion = (await stats.get(gymB)).failedVersion;
    expect(read).toMatchObject({ failed: 2, pending: 1 });
    expect(read.failedVersion).toMatch(/^[0-9a-f]{32}$/);
    expect((await stats.get(gymA)).failedVersion).toBe(read.failedVersion);
    expect(foreignVersion).not.toBe(read.failedVersion);
    // Gym B's version never matches gym A's jobs.
    expect(await queue.acknowledgeFailedVersion({ gymId: gymA, failedVersion: foreignVersion, at: now })).toBe('changed');
    const at = new Date(now.getTime() + 5 * minute);
    expect(await queue.acknowledgeFailedVersion({ gymId: gymA, failedVersion: read.failedVersion, at })).toEqual({ acknowledged: 2 });
    const after = await rows([earlier.id, later.id, pending.id, foreign.id] as string[]);
    const byId = (id: unknown) => after.find(row => row.id === id)!;
    expect(byId(earlier.id)).toMatchObject({ status: 'failed', acknowledgedAt: at });
    expect(byId(later.id)).toMatchObject({ status: 'failed', acknowledgedAt: at });
    expect(byId(pending.id)).toMatchObject({ status: 'pending', acknowledgedAt: null });
    expect(byId(foreign.id)).toMatchObject({ status: 'failed', acknowledgedAt: null });
    expect(await stats.get(gymA)).toMatchObject({ failed: 0, failedVersion: 'none' });
    expect(await queue.acknowledgeFailedVersion({ gymId: gymA, failedVersion: read.failedVersion, at })).toBe('changed');
    expect(await queue.acknowledgeFailedVersion({ gymId: gymA, failedVersion: 'none', at: new Date(at.getTime() + minute) }))
      .toEqual({ acknowledged: 0 });
    expect((await rows([earlier.id as string]))[0]!.acknowledgedAt).toEqual(at);
  });

  it('refuses a version read before a worker failed an expired final lease, then acknowledges both on a fresh read', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
    await factory('gyms', gymId);
    const queue = new PostgresJobs({ database: db, clock }), minute = 60_000;
    const failed = await factory('jobs', gymId, { name: 'test.ack', status: 'failed', runAt: new Date(clock.now().getTime() - 10 * minute) });
    const expiredAt = new Date(clock.now().getTime() - 5 * minute);
    const expired = await factory('jobs', gymId, { name: 'test.ack.lease', status: 'running', attempts: 1, maxAttempts: 1,
      runAt: new Date(clock.now().getTime() - 20 * minute), lockToken: uuidv7(), lockedUntil: expiredAt });
    const tile = await stats.get(gymId);
    expect(tile).toMatchObject({ failed: 1, running: 1 });
    // A worker's next claim fails the expired lease, backdated to the lease expiry, before the tile's check time.
    expect(await new PostgresJobs({ database: db, clock }).runNext()).toBe(false);
    expect((await rows([expired.id as string]))[0]).toMatchObject({ status: 'failed', runAt: expiredAt, acknowledgedAt: null });
    expect(await queue.acknowledgeFailedVersion({ gymId, failedVersion: tile.failedVersion, at: clock.now() })).toBe('changed');
    expect((await rows([failed.id, expired.id] as string[])).map(row => row.acknowledgedAt)).toEqual([null, null]);
    const fresh = await stats.get(gymId);
    expect(fresh.failed).toBe(2);
    expect(fresh.failedVersion).not.toBe(tile.failedVersion);
    expect(await queue.acknowledgeFailedVersion({ gymId, failedVersion: fresh.failedVersion, at: clock.now() })).toEqual({ acknowledged: 2 });
    expect((await rows([failed.id, expired.id] as string[])).map(row => row.acknowledgedAt)).toEqual([clock.now(), clock.now()]);
  });

  it('leaves an acknowledged job visible to recovery', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
    await factory('gyms', gymId);
    const queue = new PostgresJobs({ database: db, clock }), name = 'test.ack.recovery', key = uuidv7();
    queue.handle(name, async () => { throw new Error('Job failed'); });
    const { jobId } = await queue.enqueue(name, {}, { gymId, timezone: 'UTC', idempotencyKey: key, maxAttempts: 1 });
    await queue.runNext();
    const { failedVersion } = await stats.get(gymId);
    expect(await queue.acknowledgeFailedVersion({ gymId, failedVersion, at: clock.now() })).toEqual({ acknowledged: 1 });
    expect((await queue.failedJobs(name, [key], { gymId })).map(job => job.jobId)).toEqual([jobId]);
  });

  it('commits and rolls back with the caller transaction, and checks its gym, version and time', async () => {
    const gymA = uuidv7(), gymB = uuidv7(), clock = new TestClock('2026-11-01T00:00:00Z');
    await factory('gyms', gymA); await factory('gyms', gymB);
    const queue = new PostgresJobs({ database: db, clock }), at = clock.now();
    const job = await factory('jobs', gymA, { name: 'test.ack', status: 'failed', runAt: new Date(at.getTime() - 1000) });
    const { failedVersion } = await stats.get(gymA);
    await expect(withJobTransaction(db.forGym, gymA, async transaction => {
      expect(await queue.acknowledgeFailedVersion({ gymId: gymA, failedVersion, at }, transaction)).toEqual({ acknowledged: 1 });
      throw new Error('Rollback');
    })).rejects.toThrow('Rollback');
    expect((await rows([job.id as string]))[0]!.acknowledgedAt).toBeNull();
    await withJobTransaction(db.forGym, gymA, async transaction => {
      await expect(queue.acknowledgeFailedVersion({ gymId: gymB, failedVersion, at }, transaction)).rejects.toThrow('gym');
      await expect(queue.acknowledgeFailedVersion({ gymId: gymA, failedVersion, at: new Date(Number.NaN) }, transaction))
        .rejects.toThrow('Invalid job time');
      await expect(queue.acknowledgeFailedVersion({ gymId: gymA, failedVersion: '', at }, transaction)).rejects.toThrow('version');
      expect(await queue.acknowledgeFailedVersion({ gymId: gymA, failedVersion, at }, transaction)).toEqual({ acknowledged: 1 });
    });
    expect((await rows([job.id as string]))[0]!.acknowledgedAt).toEqual(at);
    await expect(queue.acknowledgeFailedVersion({ gymId: 'not-an-id', failedVersion, at })).rejects.toThrow();
  });
});
