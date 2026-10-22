// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { jobsContract, infraContractGyms } from '../../core/registry-infra-contracts.js';
import { PostgresJobs, PostgresJobStatsQuery, startJobsWorker } from './postgres.js';
import { cronOccurrences, occurrenceKey } from './cron.js';
import type { Jobs, JobOptions } from './index.js';

const database = useTestDatabase();
const factory = createFactories(database);
const gymA = infraContractGyms.a, gymB = infraContractGyms.b;
const options = { gymId: gymA, timezone: 'America/Vancouver' };
let clock: TestClock;
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });
beforeEach(async () => {
  await database.forSystem((tx) => tx.delete(jobs));
  clock = new TestClock('2026-01-01T00:00:00Z');
});
function queue(extra: Omit<ConstructorParameters<typeof PostgresJobs>[0], 'database' | 'clock'> = {}) {
  return new PostgresJobs({ database, clock, ...extra });
}
async function rows() { return database.forSystem((tx) => tx.select().from(jobs)); }
async function row(id: string) {
  const found = await database.forSystem((tx) => tx.select().from(jobs).where(eq(jobs.id, id)));
  return found[0]!;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => Promise<boolean>) {
  for (let n = 0; n < 300; n++) { if (await predicate()) return; await delay(10); }
  throw new Error('Condition did not become true');
}

jobsContract('Postgres Jobs contract', async () => queue());

describe('Postgres enqueue and execution', () => {
  it('deduplicates concurrent requests, isolates names, and snapshots payload/timezone', async () => {
    const q = queue();
    const results = await Promise.all(Array.from({ length: 12 }, () => q.enqueue('email', { to: 'member' },
      { ...options, idempotencyKey: 'same' })));
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    await q.enqueue('charge', {}, { ...options, idempotencyKey: 'same' });
    const payload = { value: 1 };
    await q.enqueue('snapshot', payload, options);
    payload.value = 9;
    await q.enqueue('snapshot', {}, options);
    expect(await rows()).toHaveLength(4);
    const seen: unknown[] = [];
    q.handle('snapshot', async (value, context) => { seen.push(value); expect(context.timezone).toBe(options.timezone); });
    expect(await q.runNext()).toBe(true);
    expect(seen).toEqual([{ value: 1 }]);
  });
  it('validates inputs and refuses enqueue from a transaction before inserting', async () => {
    const q = queue();
    await expect(database.forGym(gymA, () => q.enqueue('x', {}, options))).rejects.toThrow();
    await expect(q.enqueue('x', {}, { ...options, gymId: 'bad' })).rejects.toThrow();
    for (const opts of [{ timezone: 'bad' }, { maxAttempts: 0 }, { runAt: new Date('bad') }])
      await expect(q.enqueue('x', {}, { ...options, ...opts })).rejects.toThrow();
    await expect(q.enqueue('', {}, options)).rejects.toThrow();
    await expect(q.enqueue('x', undefined, options)).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    expect(() => queue({ perGymConcurrency: 0 })).toThrow();
  });
  it('does not claim future jobs or jobs with no local handler', async () => {
    const q = queue(); q.handle('future', async () => {});
    await q.enqueue('future', {}, { ...options, runAt: new Date(clock.now().getTime() + 1000) });
    await q.enqueue('unregistered', {}, options);
    expect(await q.runNext()).toBe(false);
    clock.advance(1000);
    expect(await q.runNext()).toBe(true);
    expect(await q.runNext()).toBe(false);
  });
  it('retries with exponential backoff and stops after maxAttempts', async () => {
    const q = queue(); const attempts: number[] = [];
    q.handle('fail', async (_, context) => { attempts.push(context.attempt); throw new Error('provider unavailable'); });
    const { jobId } = await q.enqueue('fail', {}, { ...options, maxAttempts: 3 });
    await q.runNext();
    expect(await row(jobId)).toMatchObject({ status: 'pending', attempts: 1, runAt: new Date('2026-01-01T00:00:01Z') });
    expect(await q.runNext()).toBe(false);
    clock.advance(1000); await q.runNext();
    expect((await row(jobId)).runAt).toEqual(new Date('2026-01-01T00:00:03Z'));
    clock.advance(2000); await q.runNext();
    expect(await row(jobId)).toMatchObject({ status: 'failed', attempts: 3, lastError: 'provider unavailable', lockToken: null });
    clock.advance(100_000); expect(await q.runNext()).toBe(false);
    expect(attempts).toEqual([1, 2, 3]);
  });
  it('uses a null gym and separate handlers for install jobs, excluding them from gym stats', async () => {
    const q = queue();
    let called = false;
    q.handleSystem('backup', async (value, context) => {
      called = true; expect(value).toEqual({ kind: 'manual' }); expect(context.gymId).toBeNull();
      expect(isInTransaction()).toBe(false);
    });
    const a = await q.enqueueSystem('backup', { kind: 'manual' }, { timezone: 'UTC', idempotencyKey: 'once' });
    expect(await q.enqueueSystem('backup', {}, { timezone: 'UTC', idempotencyKey: 'once' })).toEqual(a);
    expect(await q.runNext()).toBe(true); expect(called).toBe(true);
    expect(await new PostgresJobStatsQuery(database).get(gymA)).toEqual({
      pending: 0, running: 0, succeeded: 0, failed: 0, oldestPendingAt: null,
    });
    expect(await database.forGym(gymA, (tx) => tx.select().from(jobs))).toEqual([]);
  });
});

describe('worker leases, caps, and lifecycle', () => {
  it('runs two independent workers without duplicate claims and enforces the shared per-gym cap', async () => {
    const q1 = queue(), q2 = queue();
    const seen = new Set<string>(), running = new Map<string, number>(), errors: unknown[] = [];
    const handler = async (_: unknown, context: Parameters<Parameters<Jobs['handle']>[1]>[1]) => {
      expect(isInTransaction()).toBe(false);
      expect(seen.has(context.jobId)).toBe(false); seen.add(context.jobId);
      running.set(context.gymId, (running.get(context.gymId) ?? 0) + 1);
      expect(running.get(context.gymId)).toBe(1);
      await database.forGym(context.gymId, async (tx) => {
        const visible = await tx.select().from(jobs);
        expect(visible.every((r) => r.gymId === context.gymId)).toBe(true);
      });
      await delay(2); running.set(context.gymId, running.get(context.gymId)! - 1);
    };
    q1.handle('work', handler); q2.handle('work', handler);
    for (let i = 0; i < 40; i++) await q1.enqueue('work', { n: i }, { ...options, gymId: i % 2 ? gymA : gymB });
    const worker1 = startJobsWorker(q1, { pollMs: 2, onError: (e) => errors.push(e) });
    const worker2 = startJobsWorker(q2, { pollMs: 2, onError: (e) => errors.push(e) });
    try { await until(async () => (await rows()).every((r) => r.status === 'succeeded')); }
    finally { await Promise.all([worker1.stop(), worker2.stop()]); }
    expect(errors).toEqual([]); expect(seen.size).toBe(40);
    expect((await rows()).every((r) => r.attempts === 1)).toBe(true);
  });
  it('lets gym B run while gym A holds its cap despite an older A backlog', async () => {
    const q1 = queue(), q2 = queue(); const held = latch(), started = latch();
    q1.handle('work', async () => { started.resolve(); await held.promise; });
    const seen: string[] = [];
    q2.handle('work', async (_, c) => { seen.push(c.gymId); });
    for (let n = 0; n < 20; n++) await q1.enqueue('work', {}, options);
    await q1.enqueue('work', {}, { ...options, gymId: gymB });
    const first = q1.runNext(); await started.promise;
    try { expect(await q2.runNext()).toBe(true); expect(seen).toEqual([gymB]); }
    finally { held.resolve(); await first; }
  });
  it('reclaims a crashed lease and fences an old handler while its replacement is still running', async () => {
    const q1 = queue({ leaseMs: 1000 }), q2 = queue({ leaseMs: 1000 });
    const held = latch(), started = latch(), replacementHeld = latch(), replacementStarted = latch();
    q1.handle('work', async () => { started.resolve(); await held.promise; throw new Error('stale failure'); });
    q2.handle('work', async (_, c) => { expect(c.attempt).toBe(2); replacementStarted.resolve(); await replacementHeld.promise; });
    const { jobId } = await q1.enqueue('work', {}, options);
    const old = q1.runNext(); await started.promise;
    const token = (await row(jobId)).lockToken;
    clock.advance(1001);
    const replacement = q2.runNext(); await replacementStarted.promise;
    try {
      const current = await row(jobId);
      expect(current.lockToken).not.toEqual(token);
      held.resolve(); await old;
      expect(await row(jobId)).toMatchObject({ status: 'running', attempts: 2, lockToken: current.lockToken, lastError: null });
    } finally { held.resolve(); replacementHeld.resolve(); await Promise.all([old, replacement]); }
    expect(await row(jobId)).toMatchObject({ status: 'succeeded', attempts: 2, lockToken: null, lastError: null });
  });
  it('skips a locked pending row instead of waiting for another transaction', async () => {
    const q = queue(); const held = latch(), locked = latch(); const seen: string[] = [];
    q.handle('work', async (_, c) => { seen.push(c.jobId); });
    const first = await q.enqueue('work', {}, options), second = await q.enqueue('work', {}, options);
    const blocking = database.forGym(gymA, async (tx) => {
      await tx.select().from(jobs).where(eq(jobs.id, first.jobId)).for('update');
      locked.resolve(); await held.promise;
    });
    await locked.promise;
    try { expect(await q.runNext()).toBe(true); expect(seen).toEqual([second.jobId]); }
    finally { held.resolve(); await blocking; }
    expect((await row(first.jobId)).status).toBe('pending');
  });
  it('renews a live lease so a second worker cannot reclaim a long handler', async () => {
    const q1 = queue({ leaseMs: 900 }), q2 = queue({ leaseMs: 900 });
    const started = latch(), held = latch();
    q1.handle('work', async () => { started.resolve(); await held.promise; });
    q2.handle('work', async () => { throw new Error('must not run'); });
    const { jobId } = await q1.enqueue('work', {}, options);
    const active = q1.runNext(); await started.promise;
    clock.advance(600);
    try {
      await until(async () => (await row(jobId)).lockedUntil!.getTime() > Date.parse('2026-01-01T00:00:00.900Z'));
      clock.advance(400);
      expect(await q2.runNext()).toBe(false);
    } finally { held.resolve(); await active; }
    expect((await row(jobId)).status).toBe('succeeded');
  });
  it('marks an expired final attempt failed instead of leaving it running forever', async () => {
    const q = queue({ leaseMs: 1000 }); const started = latch(), held = latch();
    q.handle('work', async () => { started.resolve(); await held.promise; });
    const { jobId } = await q.enqueue('work', {}, { ...options, maxAttempts: 1 });
    const active = q.runNext(); await started.promise; clock.advance(1001);
    try { expect(await queue().runNext()).toBe(false); }
    finally { held.resolve(); await active; }
    expect(await row(jobId)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'Lease expired after final attempt' });
  });
  it('stops claiming and waits for active handlers on graceful shutdown', async () => {
    const q = queue(); const held = latch(), started = latch();
    q.handle('work', async () => { started.resolve(); await held.promise; });
    await q.enqueue('work', {}, options); await q.enqueue('work', {}, options);
    const worker = q.start({ concurrency: 1, pollMs: 5 });
    expect(() => q.start()).toThrow('already started');
    await started.promise;
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await delay(20); expect(stopped).toBe(false);
    held.resolve(); await stopping;
    expect((await rows()).map((r) => r.status).sort()).toEqual(['pending', 'succeeded']);
    const again = q.start(); await again.stop();
  });
});

describe('timezone scheduling and health statistics', () => {
  it('fans out per gym, deduplicates concurrent schedulers, and catches up after restart', async () => {
    const gyms: Pick<JobOptions, 'gymId' | 'timezone'>[] = [
      { gymId: gymA, timezone: 'UTC' }, { gymId: gymB, timezone: 'America/Vancouver' },
    ];
    const make = () => { const q = queue({ listGyms: async () => gyms, maxScheduledPerTick: 2 }); q.schedule('daily', '* * * * *', async () => {}); return q; };
    const q = make();
    await Promise.all([q.scheduleDue(), make().scheduleDue()]);
    expect(await rows()).toHaveLength(2);
    clock.advance(180_000);
    await make().scheduleDue(); expect(await rows()).toHaveLength(6);
    await make().scheduleDue(); expect(await rows()).toHaveLength(8);
    await q.scheduleDue(); expect(await rows()).toHaveLength(8);
    expect((await rows()).filter((r) => r.gymId === gymB).every((r) =>
      (r.payload as { timezone: string }).timezone === 'America/Vancouver')).toBe(true);
  });
  it('shifts a spring-forward daily job and fires fall-back local time only once', async () => {
    const make = (expression: string) => {
      const q = queue({ listGyms: async () => [{ ...options, timezone: 'America/New_York' }] }); q.schedule('daily', expression, async () => {}); return q;
    };
    clock.set('2026-03-07T07:30:00Z'); await make('30 2 * * *').scheduleDue();
    clock.set('2026-03-08T07:31:00Z'); await make('30 2 * * *').scheduleDue();
    expect((await rows()).map((r) => r.runAt.toISOString()).sort()).toEqual([
      '2026-03-07T07:30:00.000Z', '2026-03-08T07:30:00.000Z',
    ]);
    await database.forSystem((tx) => tx.delete(jobs));
    clock.set('2026-10-31T05:30:00Z'); await make('30 1 * * *').scheduleDue();
    clock.set('2026-11-01T05:31:00Z'); await make('30 1 * * *').scheduleDue();
    clock.set('2026-11-01T06:31:00Z'); await make('30 1 * * *').scheduleDue();
    expect(await rows()).toHaveLength(2);
    clock.set('2026-11-02T06:31:00Z'); await make('30 1 * * *').scheduleDue();
    expect(await rows()).toHaveLength(3);
    expect(occurrenceKey(new Date('2026-11-01T05:30Z'), 'America/New_York'))
      .toBe(occurrenceKey(new Date('2026-11-01T06:30Z'), 'America/New_York'));
  });
  it('validates five-field schedules and requires a tenancy enumeration provider', async () => {
    for (const expr of ['bad', '0 0 0 * * *', '99 * * * *', 'H * * * *'])
      expect(() => queue().schedule('job', expr, async () => {})).toThrow();
    const q = queue(); q.schedule('job', '* * * * *', async () => {});
    await expect(q.scheduleDue()).rejects.toThrow('listGyms');
    expect(() => q.start()).toThrow('listGyms');
    expect([...cronOccurrences('0 0 * * *', 'UTC', new Date('2026-01-01Z'), new Date('2026-01-03Z'))])
      .toEqual([new Date('2026-01-02Z'), new Date('2026-01-03Z')]);
  });
  it('returns only scoped counts and oldest pending time without payloads or errors', async () => {
    const q = queue();
    await q.enqueue('a', { private: 'payload' }, options);
    clock.advance(1000); await q.enqueue('b', {}, options);
    const c = await q.enqueue('c', {}, options), d = await q.enqueue('d', {}, options);
    await database.forSystem(async (tx) => {
      await tx.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, c.jobId));
      await tx.update(jobs).set({ status: 'failed', lastError: 'private error' }).where(eq(jobs.id, d.jobId));
    });
    await q.enqueue('other', {}, { ...options, gymId: gymB });
    await q.enqueueSystem('install', {}, { timezone: 'UTC' });
    const stats = new PostgresJobStatsQuery(database);
    expect(await stats.get(gymA)).toEqual({ pending: 2, running: 0, succeeded: 1, failed: 1,
      oldestPendingAt: '2026-01-01T00:00:00.000Z' });
    expect(await stats.get(gymB)).toMatchObject({ pending: 1, succeeded: 0, failed: 0 });
    expect(await stats.get(uuidv7())).toEqual({ pending: 0, running: 0, succeeded: 0, failed: 0, oldestPendingAt: null });
    expect((await database.forGym(gymA, (tx) => tx.select().from(jobs))).every((r) => r.gymId === gymA)).toBe(true);
  });
});
