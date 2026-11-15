// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { announcements, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { announcementSendJob } from './send.js';
import { cancellationNoticeJob, cancellationNoticeKeyPrefix } from './cancellation.js';
import { createAnnouncementRecovery, createAnnouncementRecoveryJobs } from './recovery.js';

const db = useTestDatabase(), factory = createFactories(db), minute = 60_000;
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-14T12:00:00Z'), jobs = new FakeJobs(clock);
  await factory('gyms', gymId);
  jobs.handle(announcementSendJob, async () => { throw new Error('Unavailable'); });
  jobs.handle(cancellationNoticeJob, async () => { throw new Error('Unavailable'); });
  const options = { scope: db.forGym, clock, jobs };
  const run = () => createAnnouncementRecovery(options).run(gymId); // Recreate to model a process restart.
  async function queue(id: string, name = announcementSendJob, key = id) {
    return jobs.enqueue(name, {}, { gymId, timezone: 'UTC', idempotencyKey: key, maxAttempts: 1 });
  }
  return { gymId, clock, jobs, options, run, queue };
}

it('backs off across restarts to a daily cap, with only one reset per failure under concurrent sweeps', async () => {
  const f = await fixture(), row = await factory('announcements', f.gymId);
  const queued = await f.queue(row.id);
  expect(createAnnouncementRecoveryJobs(f.options)).toMatchObject([{ id: 'announcements.recover', cron: '*/15 * * * *' }]);
  for (let recovery = 0; recovery < 9; recovery++) {
    expect(await f.jobs.runNext()).toBe(true);
    const failed = f.jobs.jobs.find(job => job.id === queued.jobId)!;
    expect(failed.status).toBe('failed');
    const delay = Math.min(24 * 60, 15 * 2 ** recovery) * minute;
    f.clock.advance(delay - 1);
    expect(await f.run()).toEqual({ recovered: 0 });
    f.clock.advance(1);
    const resets = await Promise.all([f.run(), f.run()]);
    expect(resets.reduce((total, result) => total + result.recovered, 0)).toBe(1);
    expect(f.jobs.jobs).toMatchObject([{ id: queued.jobId, status: 'queued', attempt: 0 }]);
    expect(await f.run()).toEqual({ recovered: 0 });
  }
  const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'announcement.delivery_retried'))
    .orderBy(asc(auditEvents.occurredAt)));
  expect(audits).toHaveLength(9);
  expect(audits.at(-1)!.after).toEqual({ jobId: queued.jobId, delayMs: 24 * 60 * minute });
});

it('ignores other gyms, completed announcements and scheduled sessions, and does not recreate missing jobs', async () => {
  const a = await fixture(), b = await fixture();
  const own = await factory('announcements', a.gymId), foreign = await factory('announcements', b.gymId);
  const completed = await factory('announcements', a.gymId, { status: 'sent', completedAt: a.clock.now() });
  const scheduled = await factory('classSessions', a.gymId);
  await factory('announcements', a.gymId); // No job: must not create one.
  const ownJob = await a.queue(own.id), completedJob = await a.queue(completed.id);
  const scheduledJob = await a.queue(scheduled.id, cancellationNoticeJob, cancellationNoticeKeyPrefix + scheduled.id);
  // Both gyms share the same real queue in production; share the fake here too.
  const foreignJob = await a.jobs.enqueue(announcementSendJob, {}, { gymId: b.gymId, timezone: 'UTC', idempotencyKey: foreign.id, maxAttempts: 1 });
  for (let i = 0; i < 4; i++) expect(await a.jobs.runNext()).toBe(true);
  a.clock.advance(15 * minute);
  expect(await a.run()).toEqual({ recovered: 1 });
  expect(a.jobs.jobs.find(job => job.id === ownJob.jobId)!.status).toBe('queued');
  for (const jobId of [completedJob.jobId, scheduledJob.jobId, foreignJob.jobId])
    expect(a.jobs.jobs.find(job => job.id === jobId)!.status).toBe('failed');
  expect(a.jobs.jobs).toHaveLength(4);
  expect(await db.forGym(b.gymId, tx => tx.$count(auditEvents))).toBe(0);
});

it('pages candidates and bounds key lookups without transactions around queue calls', async () => {
  const f = await fixture(), user = await factory('authUser', f.gymId);
  const rows = await db.forGym(f.gymId, tx => tx.insert(announcements).values(Array.from({ length: 205 }, () => ({
    gymId: f.gymId, createdBy: user.id, sendGeneration: uuidv7(), subject: 'Update', body: 'Class update',
    audience: { statuses: ['active' as const], programIds: [] },
  }))).returning({ id: announcements.id }));
  const ordered = rows.map(row => row.id).sort(), last = ordered.at(-1)!;
  await f.queue(last); expect(await f.jobs.runNext()).toBe(true);
  f.clock.advance(15 * minute);
  const failedJobs = f.jobs.failedJobs.bind(f.jobs), retryFailed = f.jobs.retryFailed.bind(f.jobs);
  const lookups = vi.spyOn(f.jobs, 'failedJobs').mockImplementation(async (...args) => {
    expect(isInTransaction()).toBe(false); expect(args[1].length).toBeLessThanOrEqual(100);
    return failedJobs(...args);
  });
  vi.spyOn(f.jobs, 'retryFailed').mockImplementation(async (...args) => {
    expect(isInTransaction()).toBe(false); return retryFailed(...args);
  });
  expect(await f.run()).toEqual({ recovered: 1 });
  expect(lookups.mock.calls.map(call => call[1].length)).toEqual([100, 100, 5]);
  expect(lookups.mock.calls.flatMap(call => call[1])).toEqual(ordered);
});

it('keeps queued jobs alone and does not audit a reset lost to another worker', async () => {
  const f = await fixture(), row = await factory('announcements', f.gymId);
  await f.queue(row.id);
  f.clock.advance(15 * minute);
  expect(await f.run()).toEqual({ recovered: 0 });
  expect(await f.jobs.runNext()).toBe(true); f.clock.advance(15 * minute);
  vi.spyOn(f.jobs, 'retryFailed').mockResolvedValue(false);
  expect(await f.run()).toEqual({ recovered: 0 });
  expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(0);
});

it('keeps running and completed jobs alone even while their announcement is still sending', async () => {
  const f = await fixture(), jobs = new FakeJobs(f.clock);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let calls = 0;
  jobs.handle(announcementSendJob, async () => {
    if (++calls === 1) return;
    started.resolve(); await finish.promise;
  });
  for (let i = 0; i < 2; i++) {
    const row = await factory('announcements', f.gymId);
    await jobs.enqueue(announcementSendJob, {}, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: row.id });
  }
  expect(await jobs.runNext()).toBe(true);
  const running = jobs.runNext(); await started.promise;
  try {
    f.clock.advance(24 * 60 * minute);
    expect(await createAnnouncementRecovery({ ...f.options, jobs }).run(f.gymId)).toEqual({ recovered: 0 });
    expect(jobs.jobs.map(job => job.status)).toEqual(['completed', 'running']);
  } finally { finish.resolve(); await running; }
});
