// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { advisoryLockNamespace, advisoryLocks, jobs, jobScheduleCursors, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- holds the backup advisory lock exactly as a running snapshot does
import { openConnection } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { jobsContract, infraContractGyms } from '../../core/registry-infra-contracts.js';
import { PostgresJobs, PostgresJobStatsQuery, retentionJob, startJobsWorker } from './postgres.js';
import { cronOccurrences, occurrenceKey } from './cron.js';
import { FakeJobs, withJobTransaction, type JobTransaction, type Jobs, type JobOptions, type JobRecovery } from './index.js';

const database = useTestDatabase();
const factory = createFactories(database);
const gymA = infraContractGyms.a, gymB = infraContractGyms.b;
const options = { gymId: gymA, timezone: 'America/Vancouver' };
let clock: TestClock;
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });
beforeEach(async () => {
  await database.forSystem(async (tx) => { await tx.delete(jobs); await tx.delete(jobScheduleCursors); });
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

describe.each(['fake', 'postgres'] as const)('%s caller-transaction enqueue contract', kind => {
  function subject() {
    const q = kind === 'fake' ? new FakeJobs(clock) : new PostgresJobs({ clock, database: {
      forGym: async () => { throw new Error('Enqueue opened another gym scope'); },
      forSystem: async () => { throw new Error('Enqueue opened a system scope'); },
    } });
    return { q, ids: async () => q instanceof FakeJobs ? q.jobs.map(job => job.id) : (await rows()).map(job => job.id) };
  }
  it('commits its job, deduplicates on the caller handle, and opens no queue scope', async () => {
    const { q, ids } = subject();
    const opts = { ...options, idempotencyKey: 'transaction' };
    let saved!: JobTransaction;
    const first = await withJobTransaction(database.forGym, gymA, async transaction => {
      saved = transaction;
      const job = await q.enqueue('atomic', { value: 1 }, opts, transaction);
      expect(await q.enqueue('atomic', { value: 2 }, opts, transaction)).toEqual(job);
      if (q instanceof FakeJobs) expect(q.jobs).toEqual([]);
      return job;
    });
    expect(await ids()).toEqual([first.jobId]);
    await withJobTransaction(database.forGym, gymA, async transaction => {
      expect(await q.enqueue('atomic', {}, opts, transaction)).toEqual(first);
    });
    await expect(q.enqueue('atomic', {}, opts, saved)).rejects.toThrow('active');
  });
  it('discards the inserted job and its key on rollback, allowing a later retry', async () => {
    const { q, ids } = subject();
    const opts = { ...options, idempotencyKey: 'rollback' };
    let rolledBackId = '';
    await expect(withJobTransaction(database.forGym, gymA, async transaction => {
      rolledBackId = (await q.enqueue('atomic', {}, opts, transaction)).jobId;
      throw new Error('failure before commit');
    })).rejects.toThrow('failure before commit');
    expect(await ids()).toEqual([]);
    const retried = await withJobTransaction(database.forGym, gymA, transaction => q.enqueue('atomic', {}, opts, transaction));
    expect(retried.jobId).not.toBe(rolledBackId);
    expect(await ids()).toEqual([retried.jobId]);
  });
  it('rejects implicit enqueue and a foreign gym without publishing a job', async () => {
    const { q, ids } = subject();
    await withJobTransaction(database.forGym, gymA, async transaction => {
      await expect(q.enqueue('atomic', {}, options)).rejects.toThrow('cannot run inside a transaction');
      await expect(q.enqueue('atomic', {}, { ...options, gymId: gymB }, transaction)).rejects.toThrow('job gym');
    });
    expect(await ids()).toEqual([]);
  });
  it.each([false, true])('deduplicates a competing caller after the first transaction settles (rollback=%s)', async rollback => {
    const { q, ids } = subject(), inserted = latch(), competing = latch();
    const opts = { ...options, idempotencyKey: 'competing' };
    let firstId = '';
    // Attach rejection handling before the other transaction releases this one.
    const first = withJobTransaction(database.forGym, gymA, async transaction => {
      const job = await q.enqueue('atomic', {}, opts, transaction);
      firstId = job.jobId;
      inserted.resolve();
      await competing.promise;
      if (rollback) throw new Error('rollback first');
      return job;
    }).catch(error => { if (!rollback) throw error; return null; });
    await inserted.promise;
    const second = withJobTransaction(database.forGym, gymA, transaction => {
      const job = q.enqueue('atomic', {}, opts, transaction);
      competing.resolve();
      return job;
    });
    const [one, two] = await Promise.all([first, second]);
    expect(await ids()).toEqual([two.jobId]);
    if (rollback) { expect(one).toBeNull(); expect(two.jobId).not.toBe(firstId); }
    else expect(two).toEqual(one);
  });
});

describe('Postgres enqueue and execution', () => {
  it('retries the insert when retention deletes the conflicting row before its lookup', async () => {
    const opts = { ...options, idempotencyKey: 'retention-race' };
    const original = await queue().enqueue('work', {}, opts);
    let conflicted = false;
    const resume = latch();
    const q = new PostgresJobs({ clock, database: { ...database, forGym: (gymId, fn) => database.forGym(gymId, async tx => {
      // Intercept the real INSERT result, then delete its conflict before enqueue's SELECT.
      const insert = tx.insert.bind(tx);
      vi.spyOn(tx, 'insert').mockImplementation(((...args: Parameters<typeof insert>) => {
        const builder = insert(...args), values = builder.values.bind(builder);
        builder.values = ((...input: Parameters<typeof values>) => {
          const query = values(...input), returning = query.returning.bind(query);
          query.returning = (async (...fields: Parameters<typeof returning>) => {
            const result = await returning(...fields);
            if (!conflicted && result.length === 0) {
              conflicted = true;
              await resume.promise;
            }
            return result;
          }) as typeof query.returning;
          return query;
        }) as typeof builder.values;
        return builder;
      }) as typeof tx.insert);
      return fn(tx);
    }) } });
    const pending = q.enqueue('work', {}, opts);
    try {
      await until(async () => conflicted);
      await database.forSystem(other => other.delete(jobs).where(eq(jobs.id, original.jobId)));
    } finally { resume.resolve(); }
    const replacement = await pending;
    expect(conflicted).toBe(true);
    expect(replacement.jobId).not.toBe(original.jobId);
    expect((await rows()).map(r => r.id)).toEqual([replacement.jobId]);
  });
  it('rejects a caller wrapper around another gym or a system database scope', async () => {
    const q = queue();
    const wrongGym: typeof database.forGym = (_gymId, fn) => database.forGym(gymB, fn);
    const system: typeof database.forGym = (_gymId, fn) => database.forSystem(fn);
    for (const scope of [wrongGym, system]) await expect(withJobTransaction(scope, gymA,
      transaction => q.enqueue('atomic', {}, options, transaction))).rejects.toThrow('wrong database scope');
    expect(await rows()).toEqual([]);
  });
  it('stores only error names and codes, without private messages or query parameters', async () => {
    const q = queue();
    q.handle('private-failure', async () => { throw Object.assign(new Error('Failed query: private\nparams: payer@example.test, secret'), { code: '23505' }); });
    const { jobId } = await q.enqueue('private-failure', {}, { ...options, maxAttempts: 1 });
    await q.runNext();
    expect((await row(jobId)).lastError).toBe('{"name":"Error","code":"23505"}');
    expect(await database.forGym(gymB, tx => tx.select().from(jobs).where(eq(jobs.id, jobId)))).toEqual([]);
  });
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
  it('keeps claiming jobs while a backup holds its lock', async () => {
    const backup = openConnection(database.maintenanceUrl, 1);
    try {
      await backup.sql`select pg_advisory_lock(${advisoryLockNamespace}::int, ${advisoryLocks.backups}::int)`;
      const q = queue(); let ran = false; q.handle('unrelated', async () => { ran = true; });
      await q.enqueue('unrelated', {}, options);
      expect(await q.runNext()).toBe(true);
      expect(ran).toBe(true);
    } finally { await backup.close(); }
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
    expect(await row(jobId)).toMatchObject({ status: 'failed', attempts: 3, lastError: '{"name":"Error"}', lockToken: null });
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
  it('logs a worker infrastructure error through the logger by default, without its message', async () => {
    const q = queue(), lines: string[] = [], previous = setLogSink((line) => lines.push(line));
    q.handle('work', async () => {});
    await q.enqueue('work', {}, options);
    const worker = startJobsWorker(q, { pollMs: 2,
      around: async () => { throw new Error('lost /srv/SECRETPATH/socket connecting to postgres://app:DBPASSWORD@db.invalid/gym with rk_test_SECRETKEY'); } });
    try { await until(async () => lines.length > 0); } finally { await worker.stop(); setLogSink(previous); }
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', event: 'jobs.worker_error', error: { name: 'Error' } });
    for (const line of lines) expect(line).not.toMatch(/SECRETPATH|postgres:|DBPASSWORD|rk_test_SECRETKEY/);
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
  it('claims nothing while paused and wraps each execution (restore gate)', async () => {
    const q = queue(); let paused = true; const wrapped: string[] = [];
    q.handle('work', async () => { wrapped.push('run'); });
    const { jobId: id } = await q.enqueue('work', {}, options);
    const worker = q.start({ pollMs: 5, paused: async () => paused,
      around: async (execute) => { wrapped.push('enter'); try { await execute(); } finally { wrapped.push('leave'); } } });
    await delay(40);
    expect((await row(id)).status).toBe('pending');
    paused = false;
    await until(async () => (await row(id)).status === 'succeeded');
    await worker.stop();
    expect(wrapped).toEqual(['enter', 'run', 'leave']);
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

describe('schedule cursors', () => {
  const gyms: Pick<JobOptions, 'gymId' | 'timezone'>[] = [{ gymId: gymA, timezone: 'UTC' }];
  const make = (expression = '*/5 * * * *') => {
    const q = queue({ listGyms: async () => gyms }); q.schedule('tick', expression, async () => {}); return q;
  };
  const cursors = () => database.forSystem((tx) => tx.select().from(jobScheduleCursors));
  const occurrences = async () => (await rows()).map((r) => (r.payload as { schedule: { at: string } }).schedule.at.slice(11, 16)).sort();
  it('catches up from the cursor, so pruned history is never enqueued again', async () => {
    clock.set('2026-01-01T00:02:00Z');
    await make().scheduleDue();
    expect(await cursors()).toMatchObject([{ gymId: gymA, name: 'tick', expression: '*/5 * * * *', timezone: 'UTC',
      lastOccurrence: new Date('2026-01-01T00:01:59.999Z') }]);
    expect(await rows()).toEqual([]);
    clock.set('2026-01-01T00:21:00Z');
    await make().scheduleDue();
    expect(await occurrences()).toEqual(['00:05', '00:10', '00:15', '00:20']);
    expect((await cursors())[0]!.lastOccurrence).toEqual(new Date('2026-01-01T00:20:00Z'));
    await database.forSystem((tx) => tx.delete(jobs));
    clock.set('2026-01-01T00:26:00Z');
    await make().scheduleDue();
    expect(await occurrences()).toEqual(['00:25']);
    expect(await cursors()).toHaveLength(1);
  });
  it('seeds a missing cursor once from the newest occurrence row on upgrade, without skipping or repeating', async () => {
    await make().scheduleDue();
    clock.set('2026-01-01T00:10:00Z'); await make().scheduleDue();
    // The previous release kept no cursor: its newest occurrence row was the watermark.
    await database.forSystem((tx) => tx.delete(jobScheduleCursors));
    expect(await occurrences()).toEqual(['00:00', '00:05', '00:10']);
    clock.set('2026-01-01T00:31:00Z');
    await Promise.all([make().scheduleDue(), make().scheduleDue()]);
    expect(await occurrences()).toEqual(['00:00', '00:05', '00:10', '00:15', '00:20', '00:25', '00:30']);
    expect(await cursors()).toMatchObject([{ lastOccurrence: new Date('2026-01-01T00:30:00Z') }]);
  });
  it('starts a new generation when the expression or timezone changes', async () => {
    clock.set('2026-01-01T00:00:30Z'); await make().scheduleDue();
    clock.set('2026-01-01T00:07:30Z'); await make('*/2 * * * *').scheduleDue();
    // A new generation starts at the current minute; it does not replay another generation's history.
    expect(await cursors()).toMatchObject([{ expression: '*/2 * * * *', lastOccurrence: new Date('2026-01-01T00:06:59.999Z') }]);
    expect(await occurrences()).toEqual(['00:00']);
    clock.set('2026-01-01T00:12:30Z'); await make().scheduleDue();
    // A returning expression starts now too, despite its retained occurrence history.
    expect(await occurrences()).toEqual(['00:00']);
    gyms[0] = { gymId: gymA, timezone: 'America/Vancouver' };
    try {
      clock.set('2026-01-01T00:15:30Z'); await make().scheduleDue();
      expect(await cursors()).toMatchObject([{ timezone: 'America/Vancouver', lastOccurrence: new Date('2026-01-01T00:15:00Z') }]);
      expect(await occurrences()).toEqual(['00:00', '00:15']);
      gyms[0] = { gymId: gymA, timezone: 'UTC' };
      clock.set('2026-01-01T00:30:30Z'); await make().scheduleDue();
      expect(await occurrences()).toEqual(['00:00', '00:15', '00:30']);
    } finally { gyms[0] = { gymId: gymA, timezone: 'UTC' }; }
  });
  it('decides history seeding per schedule when one gym has a replaced and a cursorless schedule in the same tick', async () => {
    const make = (expression: string) => {
      const q = queue({ listGyms: async () => gyms });
      q.schedule('replaced', expression, async () => {}); q.schedule('upgrade', '*/5 * * * *', async () => {});
      return q;
    };
    const times = async (name: string) => (await rows()).filter((r) => r.name === name)
      .map((r) => (r.payload as { schedule: { at: string } }).schedule.at.slice(11, 16)).sort();
    clock.set('2026-01-01T00:00:00Z'); await make('*/5 * * * *').scheduleDue();
    clock.set('2026-01-01T00:10:00Z'); await make('*/10 * * * *').scheduleDue();
    await database.forSystem((tx) => tx.delete(jobScheduleCursors).where(eq(jobScheduleCursors.name, 'upgrade')));
    clock.set('2026-01-01T00:31:00Z'); await make('*/5 * * * *').scheduleDue();
    // 'replaced' returns to an expression with history and starts now; 'upgrade' has no cursor and inherits its history.
    expect(await times('replaced')).toEqual(['00:00', '00:10']);
    expect(await times('upgrade')).toEqual(['00:00', '00:05', '00:10', '00:15', '00:20', '00:25', '00:30']);
  });
  it.each(['invalid timezone', 'deleted gym'])('reports a gym with %s and schedules the next gym in the same tick', async (failure) => {
    const broken = failure === 'deleted gym' ? uuidv7() : gymA;
    const q = queue({ listGyms: async () => [
      { gymId: broken, timezone: failure === 'invalid timezone' ? 'Invalid/Timezone' : 'UTC' },
      { gymId: gymB, timezone: 'UTC' },
    ] });
    q.schedule('tick', '* * * * *', async () => {});
    const lines: string[] = [], previous = setLogSink(line => lines.push(line));
    try { await q.scheduleDue(); } finally { setLogSink(previous); }
    expect(lines.map(line => JSON.parse(line))).toMatchObject([
      { level: 'error', event: 'jobs.schedule_error', gymId: broken, error: { name: expect.any(String) } },
    ]);
    expect(await rows()).toMatchObject([{ gymId: gymB, name: 'tick' }]);
  });
  it.each(['ECONNREFUSED', 'CONNECTION_CLOSED', 'CONNECT_TIMEOUT', '08006', '57P01', '53300', '28P01', '57P04', '25006'].flatMap(code => [
    { code, stage: 'seed' }, { code, stage: 'enqueue' },
  ]))('ends a tick on wrapped $code during $stage without visiting later gyms', async ({ code, stage }) => {
    const visited: string[] = [];
    const outage = new Error('query failed', { cause: Object.assign(new Error('connection lost'), { code }) });
    const q = new PostgresJobs({ clock, listGyms: async () => [
      { gymId: gymA, timezone: 'UTC' }, { gymId: gymB, timezone: 'UTC' },
    ], database: { ...database, forGym: (gymId, fn) => {
      visited.push(gymId);
      if (stage === 'seed' || visited.length > 1) throw outage;
      return database.forGym(gymId, fn);
    } } });
    q.schedule('tick', '* * * * *', async () => {});
    await expect(q.scheduleDue()).rejects.toBe(outage);
    expect(visited).toEqual(stage === 'seed' ? [gymA] : [gymA, gymA]);
    expect(await rows()).toEqual([]);
  });
  it('does not persist a cursor for an invalid timezone and inherits history after it is corrected', async () => {
    let timezone = 'UTC';
    const q = queue({ listGyms: async () => [{ gymId: gymA, timezone }] });
    q.schedule('tick', '* * * * *', async () => {});
    await q.scheduleDue();
    await database.forSystem(tx => tx.delete(jobScheduleCursors));
    clock.advance(180_000); timezone = 'Invalid/Timezone';
    const previous = setLogSink(() => {});
    try { await q.scheduleDue(); } finally { setLogSink(previous); }
    expect(await database.forSystem(tx => tx.select().from(jobScheduleCursors))).toEqual([]);
    timezone = 'UTC'; await q.scheduleDue();
    expect(await rows()).toHaveLength(4);
  });
  it.each(['seed', 'enqueue'])('logs a failing schedule during %s and continues its gym\'s other schedules', async failure => {
    let calls = 0;
    const q = new PostgresJobs({ clock, listGyms: async () => [{ gymId: gymA, timezone: 'UTC' }],
      database: { ...database, forGym: (gymId, fn) => {
        calls++;
        // Bulk seed fails, then the bad schedule's individual seed fails; or seed succeeds and enqueue fails.
        if (calls === 2 || (failure === 'seed' && calls === 1)) throw new Error('bad schedule');
        return database.forGym(gymId, fn);
      } } });
    q.schedule('bad', '* * * * *', async () => {});
    q.schedule('good', '* * * * *', async () => {});
    const lines: string[] = [], previous = setLogSink(line => lines.push(line));
    try { await q.scheduleDue(); } finally { setLogSink(previous); }
    const logged = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    // A failed seed of all missing schedules is logged once, without a schedule name, before the per-schedule seeds.
    expect(logged).toMatchObject([
      ...(failure === 'seed' ? [{ event: 'jobs.schedule_error', gymId: gymA, stage: 'seed_all' }] : []),
      { event: 'jobs.schedule_error', gymId: gymA, schedule: 'bad' },
    ]);
    expect(logged[0]).not.toHaveProperty(failure === 'seed' ? 'schedule' : 'stage');
    expect((await rows()).map(r => r.name)).toEqual(['good']);
  });
  it('seeds a single missing schedule once per tick, not in a shared attempt as well', async () => {
    const first = queue({ listGyms: async () => [{ gymId: gymA, timezone: 'UTC' }] });
    first.schedule('good', '* * * * *', async () => {});
    await first.scheduleDue();
    // Malformed history makes the upgrade seed of 'bad' fail on every tick.
    await database.forSystem(tx => tx.insert(jobs).values({ gymId: gymA, name: 'bad', status: 'succeeded', runAt: clock.now(),
      idempotencyKey: uuidv7(), payload: { version: 1, timezone: 'UTC', value: {}, schedule: { expression: '* * * * *', at: 'not a time' } } }));
    let failures = 0;
    const q = new PostgresJobs({ clock, listGyms: async () => [{ gymId: gymA, timezone: 'UTC' }],
      database: { ...database, forGym: async (gymId, fn) => {
        try { return await database.forGym(gymId, fn); } catch (error) { failures++; throw error; }
      } } });
    q.schedule('good', '* * * * *', async () => {}); q.schedule('bad', '* * * * *', async () => {});
    clock.advance(60_000);
    const lines: string[] = [], previous = setLogSink(line => lines.push(line));
    try { await q.scheduleDue(); await q.scheduleDue(); } finally { setLogSink(previous); }
    expect(failures).toBe(2);
    expect(lines.map(line => JSON.parse(line))).toMatchObject([
      { event: 'jobs.schedule_error', gymId: gymA, schedule: 'bad' }, { event: 'jobs.schedule_error', gymId: gymA, schedule: 'bad' },
    ]);
    expect((await rows()).filter(r => r.name === 'good')).toHaveLength(2);
  });
  it('schedules from the worker once per clock minute, not on every poll', async () => {
    const q = make(); const tick = vi.spyOn(q, 'scheduleDue');
    const worker = q.start({ pollMs: 2 });
    try {
      await until(async () => tick.mock.calls.length === 1); await delay(30);
      expect(tick).toHaveBeenCalledTimes(1);
      clock.advance(60_000);
      await until(async () => tick.mock.calls.length === 2); await delay(30);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally { await worker.stop(); }
  });
});

describe('claim fairness', () => {
  const lease = (gymId: string | null, name = 'work') => ({ gymId, name, payload: { version: 1, timezone: 'UTC', value: {} },
    runAt: new Date('2025-12-31T00:00:00Z'), attempts: 1, maxAttempts: 3, status: 'running', lockToken: uuidv7(),
    lockedUntil: new Date('2026-01-01T00:01:00Z'), idempotencyKey: uuidv7() });
  it('skips every gym at its cap, install jobs included, and takes the earliest due job of the rest', async () => {
    const q = queue({ perGymConcurrency: 2 }); const seen: (string | null)[] = [];
    q.handle('work', async (_, c) => { seen.push(c.gymId); }); q.handleSystem('install', async () => { seen.push(null); });
    for (let n = 0; n < 200; n++) await q.enqueue('work', {}, { ...options, runAt: new Date(clock.now().getTime() - 60_000) });
    await q.enqueueSystem('install', {}, { timezone: 'UTC', runAt: new Date(clock.now().getTime() - 30_000) });
    await q.enqueue('work', {}, { ...options, gymId: gymB });
    // Gym A and the install bucket hold two live leases each; gym B holds one, below the cap.
    await database.forSystem((tx) => tx.insert(jobs).values([lease(gymA), lease(gymA), lease(null, 'install'), lease(null, 'install'), lease(gymB)]));
    expect(await q.runNext()).toBe(true);
    expect(await q.runNext()).toBe(false);
    expect(seen).toEqual([gymB]);
    // An expired lease frees its slot: gym A's oldest job runs next.
    await database.forSystem((tx) => tx.update(jobs).set({ lockedUntil: clock.now() }).where(eq(jobs.gymId, gymA)));
    expect(await q.runNext()).toBe(true);
    expect(seen).toEqual([gymB, gymA]);
  });
  it('counts live leases once per gym and lane, each lane against its own cap', async () => {
    const q = queue({ batch: { perGymConcurrency: 2 } }); const seen: string[] = [];
    q.handle('batch', async () => { seen.push('batch'); }, { lane: 'batch' }); q.handle('work', async () => { seen.push('work'); });
    await q.enqueue('work', {}, { ...options, runAt: new Date(clock.now().getTime() - 60_000) });
    await q.enqueue('batch', {}, options); await q.enqueue('batch', {}, options);
    // Gym A holds one live default lease (its cap) and one live batch lease (below the batch cap of two).
    await database.forSystem((tx) => tx.insert(jobs).values([lease(gymA), lease(gymA, 'batch')]));
    expect(await q.runNext()).toBe(true);
    expect(seen).toEqual(['batch']);
    // A second live batch lease fills the batch lane as well; the default lane stays full.
    await database.forSystem((tx) => tx.insert(jobs).values(lease(gymA, 'batch')));
    expect(await q.runNext()).toBe(false);
    expect(() => queue({ batch: { perGymConcurrency: 0 } })).toThrow();
  });
});

describe('batch lane', () => {
  it("runs a gym's other jobs while its batch lane is busy, one batch job per gym, and other gyms' alongside", async () => {
    const q = queue(), held = latch(), seen: string[] = [];
    const name = (gymId: string) => gymId === gymA ? 'A' : 'B';
    q.handle('batch', async (_, c) => { seen.push('batch ' + name(c.gymId)); await held.promise; }, { lane: 'batch' });
    q.handle('dispatch', async (_, c) => { seen.push('dispatch ' + name(c.gymId)); });
    await q.enqueue('batch', {}, options); await q.enqueue('batch', {}, options);
    await q.enqueue('dispatch', {}, options); await q.enqueue('batch', {}, { ...options, gymId: gymB });
    const first = q.runNext(); await until(async () => seen.length === 1);
    let other: Promise<boolean> | undefined;
    try {
      // Gym A's second batch job waits for its lane, gym A's dispatch doesn't, and gym B's batch lane is its own.
      expect(await q.runNext()).toBe(true);
      other = q.runNext(); await until(async () => seen.length === 3);
      expect(seen).toEqual(['batch A', 'dispatch A', 'batch B']);
      expect(await q.runNext()).toBe(false);
    } finally { held.resolve(); await Promise.all([first, other]); }
    expect(await q.runNext()).toBe(true);
    expect(seen.at(-1)).toBe('batch A');
  });
  it('puts a job registered with the batch lane in it, scheduled or not, and leaves one registered without in the default lane', async () => {
    const q = queue(), held = latch(), seen: string[] = [];
    q.handle('batch', async () => { seen.push('batch'); await held.promise; }, { lane: 'batch' });
    q.schedule('scan', '7 * * * *', async () => { seen.push('scan'); }, { lane: 'batch' });
    q.handle('work', async () => { seen.push('work'); }); q.handle('other', async () => { seen.push('other'); });
    for (const name of ['batch', 'scan', 'work', 'other']) await q.enqueue(name, {}, options);
    const first = q.runNext(); await until(async () => seen.length === 1);
    try {
      // The held batch job fills the gym's batch lane, so the scan waits and the default lane's first job runs; that job
      // has finished by then, so the second default-lane job runs as well.
      expect(await q.runNext()).toBe(true);
      expect(await q.runNext()).toBe(true);
      expect(await q.runNext()).toBe(false);
      expect(seen).toEqual(['batch', 'work', 'other']);
    } finally { held.resolve(); await first; }
    expect(await q.runNext()).toBe(true);
    expect(seen.at(-1)).toBe('scan');
  });
  it('records the batch lane registrations of the fake queue', () => {
    const fake = new FakeJobs(clock);
    fake.handle('batch', async () => {}, { lane: 'batch' }); fake.schedule('scan', '7 * * * *', async () => {}, { lane: 'batch' });
    fake.handle('work', async () => {});
    expect([...fake.batchJobs].sort()).toEqual(['batch', 'scan']);
  });
  it('keeps a worker slot for other jobs while batch jobs could fill them all', async () => {
    const q = queue(), held = latch(); const batches: string[] = [], dispatched: string[] = [];
    q.handle('batch', async (_, c) => { batches.push(c.gymId); await held.promise; }, { lane: 'batch' });
    q.handle('dispatch', async (_, c) => { dispatched.push(c.gymId); });
    await q.enqueue('batch', {}, options); await q.enqueue('batch', {}, { ...options, gymId: gymB });
    for (const invalid of [{ batchConcurrency: 0 }, { concurrency: 2, batchConcurrency: 3 }]) expect(() => startJobsWorker(q, invalid)).toThrow();
    // Two slots: one for batch work, so gym B's batch job waits although its own lane is free.
    const worker = startJobsWorker(q, { concurrency: 2, pollMs: 2 });
    try {
      await until(async () => batches.length === 1);
      await q.enqueue('dispatch', {}, { ...options, gymId: gymB });
      await until(async () => dispatched.length === 1);
      expect(batches).toEqual([gymA]);
    } finally { held.resolve(); await worker.stop(); }
  });
});

describe('retention', () => {
  const finished = (status: 'succeeded' | 'failed' | 'pending' | 'running', days: number, extra: Partial<typeof jobs.$inferInsert> = {}) => ({
    gymId: gymA, name: 'work', payload: { version: 1, timezone: 'UTC', value: {} }, status, attempts: 1, maxAttempts: 1,
    runAt: new Date(clock.now().getTime() - days * 86_400_000), idempotencyKey: uuidv7(), ...extra });
  const occurrence = (gymId: string, days: number) => finished('succeeded', days, { gymId, name: 'tick',
    payload: { version: 1, timezone: 'UTC', value: {}, schedule: { expression: '* * * * *', at: '2025-01-01T00:00:00.000Z' } } });
  it('deletes old finished jobs in batches, keeping active rows, protected names and unseeded cron history', async () => {
    clock.set('2026-06-01T00:00:00Z');
    const q = queue({ retention: { keep: ['billing.alerts.send'], batchSize: 2 } });
    await database.forSystem((tx) => tx.insert(jobScheduleCursors).values({ gymId: gymA, name: 'tick', expression: '* * * * *',
      timezone: 'UTC', lastOccurrence: clock.now() }));
    const deleted = await database.forSystem((tx) => tx.insert(jobs).values([
      finished('succeeded', 15), finished('succeeded', 15), finished('succeeded', 400), finished('failed', 91),
      finished('succeeded', 15, { gymId: null, name: 'install' }), occurrence(gymA, 15),
    ]).returning({ id: jobs.id }));
    const kept = await database.forSystem((tx) => tx.insert(jobs).values([
      finished('succeeded', 13), finished('failed', 89), finished('pending', 400), finished('running', 400),
      finished('succeeded', 400, { name: 'billing.alerts.send' }), finished('failed', 400, { name: 'billing.alerts.send' }),
      // Gym B has no cursors yet: its newest occurrence rows are still its scheduler's watermark.
      occurrence(gymB, 15),
    ]).returning({ id: jobs.id }));
    expect(await q.prune()).toBe(deleted.length);
    expect((await rows()).map((r) => r.id).sort()).toEqual(kept.map((r) => r.id).sort());
  });
  it('keeps a schedule\'s history until that schedule has a cursor, whatever else its gym has seeded', async () => {
    const cursor = (name: string) => database.forSystem(tx => tx.insert(jobScheduleCursors).values({ gymId: gymA, name,
      expression: '* * * * *', timezone: 'UTC', lastOccurrence: clock.now() }));
    const q = queue({ retention: { keep: [] } });
    await cursor('other');
    await database.forSystem(tx => tx.insert(jobs).values(occurrence(gymA, 15)));
    expect(await q.prune()).toBe(0);
    await cursor('tick');
    expect(await q.prune()).toBe(1);
  });
  it('does not row-lock protected names or unseeded history while deleting a batch', async () => {
    const kept = await database.forSystem(tx => tx.insert(jobs).values([
      finished('succeeded', 400, { name: 'keep' }), occurrence(gymB, 400),
    ]).returning({ id: jobs.id }));
    await database.forSystem(tx => tx.insert(jobs).values(finished('succeeded', 30)));
    let checked = false;
    const resume = latch();
    const q = new PostgresJobs({ clock, retention: { keep: ['keep'] }, database: { ...database,
      forSystem: fn => database.forSystem(async tx => {
        const result = await fn(tx);
        if (!checked) {
          checked = true;
          await resume.promise;
        }
        return result;
      }),
    } });
    const pruning = q.prune();
    try {
      await until(async () => checked);
      // The prune transaction is still open: NOWAIT would fail if either retained row was locked.
      await database.forSystem(other => other.select().from(jobs).where(inArray(jobs.id, kept.map(r => r.id)))
        .for('update', { noWait: true }));
    } finally { resume.resolve(); }
    expect(await pruning).toBe(1);
    expect(checked).toBe(true);
  });
  it('ages a succeeded job from when it finished, not when it was first due', async () => {
    const q = queue({ retention: { keep: [] } }); q.handle('work', async () => {});
    const { jobId } = await q.enqueue('work', {}, { ...options, runAt: new Date('2025-12-01T00:00:00Z') });
    expect(await q.runNext()).toBe(true);
    expect(await row(jobId)).toMatchObject({ status: 'succeeded', runAt: clock.now() });
    clock.advance(13 * 86_400_000);
    expect(await q.prune()).toBe(0);
    clock.advance(2 * 86_400_000);
    expect(await q.prune()).toBe(1);
  });
  it('keeps a protected key unique after pruning, while an unprotected key can be reused', async () => {
    const q = queue({ retention: { keep: ['billing.alerts.send'] } });
    q.handle('billing.alerts.send', async () => {}); q.handle('work', async () => {});
    const alert = await q.enqueue('billing.alerts.send', {}, { ...options, idempotencyKey: 'card:2026-02-01' });
    const work = await q.enqueue('work', {}, { ...options, idempotencyKey: 'once' });
    await q.runNext(); await q.runNext();
    clock.advance(15 * 86_400_000);
    expect(await q.prune()).toBe(1);
    expect(await q.enqueue('billing.alerts.send', {}, { ...options, idempotencyKey: 'card:2026-02-01' })).toEqual(alert);
    expect(await q.enqueue('work', {}, { ...options, idempotencyKey: 'once' })).not.toEqual(work);
  });
  it('enqueues one install retention job per UTC day and runs it through the queue', async () => {
    const make = () => queue({ retention: { keep: [] } });
    const q = make();
    await database.forSystem((tx) => tx.insert(jobs).values(finished('succeeded', 30)));
    await q.scheduleDue(); await q.scheduleDue(); await make().scheduleDue();
    expect((await rows()).filter((r) => r.name === retentionJob)).toMatchObject([{ gymId: null, status: 'pending',
      runAt: new Date('2026-01-01T03:30:00Z') }]);
    expect(await q.runNext()).toBe(false);
    clock.set('2026-01-01T03:30:00Z');
    expect(await q.runNext()).toBe(true);
    expect((await rows()).map((r) => [r.name, r.status])).toEqual([[retentionJob, 'succeeded']]);
    clock.set('2026-01-02T05:00:00Z'); await q.scheduleDue();
    expect((await rows()).filter((r) => r.name === retentionJob)).toHaveLength(2);
    await expect(queue().prune()).rejects.toThrow('not configured');
    expect(() => queue({ retention: { keep: [], failedDays: 0 } })).toThrow('failedDays');
  });
});

/** Shared by the fake and the real queue so the fake's recovery cannot drift. */
function recoveryContract(name: string, create: (clock: TestClock) => Jobs & JobRecovery & { runNext(): Promise<boolean> }) {
  it(`${name}: finds and retries only the gym's failed jobs, keeping their ID and key`, async () => {
    const q = create(clock); let fail = true; const attempts: number[] = [];
    q.handle('send', async (_, c) => { attempts.push(c.attempt); if (fail) throw new Error('down'); });
    const failed = await q.enqueue('send', {}, { ...options, idempotencyKey: 'k1', maxAttempts: 1 });
    await q.runNext();
    const active = await q.enqueue('send', {}, { ...options, idempotencyKey: 'k2', runAt: new Date('2026-01-02Z') });
    expect(await q.failedJobs('send', ['k1', 'k2', 'missing'], options)).toEqual([
      { jobId: failed.jobId, idempotencyKey: 'k1', failedAt: clock.now() }]);
    expect(await q.failedJobs('other', ['k1'], options)).toEqual([]);
    expect(await q.failedJobs('send', ['k1'], { gymId: gymB })).toEqual([]);
    const later = new Date('2026-01-01T01:00:00Z');
    expect(await q.retryFailed(active.jobId, { gymId: gymA, runAt: later })).toBe(false);
    expect(await q.retryFailed(failed.jobId, { gymId: gymB, runAt: later })).toBe(false);
    expect(await q.retryFailed(failed.jobId, { gymId: gymA, runAt: later })).toBe(true);
    expect(await q.retryFailed(failed.jobId, { gymId: gymA, runAt: later })).toBe(false);
    expect(await q.enqueue('send', {}, { ...options, idempotencyKey: 'k1' })).toEqual(failed);
    expect(await q.failedJobs('send', ['k1'], options)).toEqual([]);
    expect(await q.runNext()).toBe(false);
    fail = false; clock.set(later);
    expect(await q.runNext()).toBe(true);
    expect(attempts).toEqual([1, 1]);
  });
}
describe('failed job recovery', () => {
  recoveryContract('FakeJobs', (c) => new FakeJobs(c));
  recoveryContract('PostgresJobs', () => queue());
  it('leaves a running final attempt alone until a claim marks its expired lease failed, and fences its old handler', async () => {
    const q = queue({ leaseMs: 1000 }); const started = latch(), held = latch();
    q.handle('work', async () => { started.resolve(); await held.promise; });
    const { jobId } = await q.enqueue('work', {}, { ...options, idempotencyKey: 'slow', maxAttempts: 1 });
    const active = q.runNext(); await started.promise;
    try {
      clock.advance(1001);
      // Expired but not yet marked: its handler may still be running, so it is not offered for a retry.
      expect(await q.failedJobs('work', ['slow'], options)).toEqual([]);
      expect(await q.retryFailed(jobId, { gymId: gymA, runAt: clock.now() })).toBe(false);
      clock.advance(1000);
      expect(await q.runNext()).toBe(false);
      expect(await q.failedJobs('work', ['slow'], options)).toEqual([
        { jobId, idempotencyKey: 'slow', failedAt: new Date('2026-01-01T00:00:02.001Z') }]);
      expect(await q.retryFailed(jobId, { gymId: gymA, runAt: clock.now() })).toBe(true);
    } finally { held.resolve(); await active; }
    expect(await row(jobId)).toMatchObject({ status: 'pending', attempts: 0, lockToken: null, lastError: null });
  });
});
