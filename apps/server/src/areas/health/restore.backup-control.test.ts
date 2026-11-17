// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { backupControlResponseSchema } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { authorize } from '../staff/auth.permissions.js';
import { createBackupControl, manualBackupJob } from './restore.backup-control.js';
import { createBackupControlRoutes } from './backups.routes.js';
import { registerBackupJobs } from './backups.jobs.js';

const db = useTestDatabase(), factory = createFactories(db);
const roles = ['owner', 'admin', 'coach', 'front_desk'] as const;
async function fixture() {
  const gymId = uuidv7(), user = await factory('authUser', gymId);
  await factory('gyms', gymId, { settings: { backupPruningHeld: true, kept: 'yes' } });
  const clock = new TestClock('2026-11-12T12:00:00Z'), queue = new PostgresJobs({ database: db, clock });
  const state = { restoring: false, configured: gymId as string | null, available: true };
  const control = createBackupControl({ clock, queue, scope: db.forGym, isRestoring: async () => state.restoring,
    configuredGym: async () => state.configured, available: () => state.available });
  const snapshotId = uuidv7(), snapshot = vi.fn(async () => {
    assertNoTransaction('test.backup');
    return { id: snapshotId, version: 1 as const, kind: 'manual' as const, startedAt: clock.now().toISOString(),
      database: { sha256: 'a'.repeat(64), size: 1 }, manifest: { sha256: 'b'.repeat(64), size: 1 }, uploads: [] };
  });
  registerBackupJobs(queue, { snapshot }, clock, async () => state.restoring, control);
  const request = (role: typeof roles[number], path = '/api/health/backups', body?: unknown, sessionGym = gymId) => createApp({
    clock, authorize, skipSetup: true,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: sessionGym, userId: user.id, roles: [role] } }); await next(); },
    contributions: { routes: createBackupControlRoutes(control) },
  }).request(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const read = async (response: Response) => backupControlResponseSchema.parse(await response.json()).data;
  return { gymId, user, clock, queue, control, request, read, state, snapshot, snapshotId };
}
const nowPath = '/api/health/backups/now', confirmPath = '/api/health/backups/confirm-old-server-gone';
describe('manual backups and restore pruning confirmation', () => {
  it.each(['queued', 'future_finished'])('reads stored %s state with unknown fields and lets the owner release the hold', async status => {
    const f = await fixture(), requestId = uuidv7();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ settings: { backupPruningHeld: true, manualBackup: {
      requestId, status, requestedAt: f.clock.now().toISOString(), completedAt: null, snapshotId: null, futureField: 'extra',
    } } }).where(eq(gyms.id, f.gymId)));
    expect((await f.control.get(f.gymId)).manual?.status).toBe(status === 'queued' ? 'queued' : 'failed');
    expect((await f.request('owner', confirmPath, { revision: 1, confirmed: true })).status).toBe(200);
    expect((await f.request('owner', nowPath, { requestId: uuidv7() })).status).toBe(status === 'queued' ? 409 : 200);
    await f.queue.runNext();
  });
  it('allows pruning confirmation even with malformed stored manual state', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ settings: { backupPruningHeld: true, manualBackup: { future: true } } }).where(eq(gyms.id, f.gymId)));
    expect((await f.request('owner', confirmPath, { revision: 1, confirmed: true })).status).toBe(200);
  });
  it('records a published snapshot as succeeded after transient success-write failures', async () => {
    const f = await fixture(), requestId = uuidv7();
    await f.control.request({ gymId: f.gymId, userId: f.user.id }, requestId);
    // Running uses one transaction; refuse the first two success bookkeeping attempts.
    const scope = vi.fn(db.forGym).mockImplementationOnce(db.forGym)
      .mockRejectedValueOnce(new Error('success write unavailable')).mockRejectedValueOnce(new Error('still unavailable'));
    const control = createBackupControl({ scope: scope as typeof db.forGym, clock: f.clock, queue: f.queue,
      available: () => true, isRestoring: async () => false, configuredGym: async () => f.gymId });
    await control.run(f.gymId, requestId, f.snapshot);
    expect(f.snapshot).toHaveBeenCalledOnce(); expect(scope).toHaveBeenCalledTimes(4);
    expect((await f.control.get(f.gymId)).manual).toMatchObject({ status: 'succeeded', snapshotId: f.snapshotId });
    const failed = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'backup.failed')));
    expect(failed).toHaveLength(0);
    // The direct invocation above leaves the original queued job; drain it before the next fixture.
    await f.queue.runNext();
    expect(f.snapshot).toHaveBeenCalledOnce();
    const succeeded = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'backup.succeeded')));
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.after).toMatchObject({ snapshotId: f.snapshotId });
  });
  it.each(['queued', 'running'])('reads %s state once when job recovery writes nothing', async status => {
    const f = await fixture(), requestId = uuidv7();
    await f.control.request({ gymId: f.gymId, userId: f.user.id }, requestId);
    await db.forGym(f.gymId, async tx => {
      const [row] = await tx.select().from(gyms).where(eq(gyms.id, f.gymId));
      const settings = row!.settings as Record<string, unknown>;
      await tx.update(gyms).set({ settings: { ...settings, manualBackup: { ...settings.manualBackup as object, status } } }).where(eq(gyms.id, f.gymId));
    });
    const scope = vi.fn(db.forGym), control = createBackupControl({ scope: scope as typeof db.forGym, queue: f.queue,
      clock: f.clock, available: () => true, configuredGym: async () => f.gymId });
    expect((await control.get(f.gymId)).manual?.status).toBe(status);
    expect(scope).toHaveBeenCalledOnce();
    await f.queue.runNext();
  });
  it.each(['succeeded', 'replaced', 'cleared'] as const)('re-reads when failed-job recovery finds the request %s under its lock', async change => {
    const f = await fixture(), requestId = uuidv7(), replacementId = uuidv7();
    await f.control.request({ gymId: f.gymId, userId: f.user.id }, requestId);
    const failed = vi.spyOn(f.queue, 'failedJobs').mockImplementationOnce(async () => {
      // Another worker changes the row between get() reading it and recovery acquiring its lock.
      await db.forGym(f.gymId, async tx => {
        const [row] = await tx.select().from(gyms).where(eq(gyms.id, f.gymId));
        const settings = row!.settings as Record<string, unknown>;
        await tx.update(gyms).set({ settings: { ...settings, manualBackup: change === 'cleared' ? null : {
          ...settings.manualBackup as object, requestId: change === 'replaced' ? replacementId : requestId,
          status: change === 'replaced' ? 'queued' : 'succeeded', completedAt: change === 'replaced' ? null : f.clock.now().toISOString(),
          snapshotId: change === 'replaced' ? null : f.snapshotId,
        } } }).where(eq(gyms.id, f.gymId));
      });
      return [{ jobId: uuidv7(), idempotencyKey: requestId, failedAt: f.clock.now() }];
    });
    const scope = vi.fn(db.forGym), control = createBackupControl({ scope: scope as typeof db.forGym, queue: f.queue,
      clock: f.clock, available: () => true, configuredGym: async () => f.gymId });
    try {
      const result = await control.get(f.gymId);
      expect(scope).toHaveBeenCalledTimes(3);
      if (change === 'cleared') expect(result.manual).toBeNull();
      else expect(result.manual).toMatchObject({ requestId: change === 'replaced' ? replacementId : requestId,
        status: change === 'replaced' ? 'queued' : 'succeeded' });
      const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'backup.failed')));
      expect(audits).toHaveLength(0);
    } finally { failed.mockRestore(); await f.queue.runNext(); }
  });
  it('reads idle state once, skips job recovery, and caches configured status for one poll interval', async () => {
    const f = await fixture(), scope = vi.fn(db.forGym), configured = vi.fn(async () => f.gymId);
    const failed = vi.spyOn(f.queue, 'failedJobs');
    const control = createBackupControl({ scope: scope as typeof db.forGym, clock: f.clock, queue: f.queue,
      available: () => true, configuredGym: configured });
    await Promise.all([control.get(f.gymId), control.get(f.gymId)]);
    expect(scope).toHaveBeenCalledTimes(2); expect(failed).not.toHaveBeenCalled(); expect(configured).toHaveBeenCalledOnce();
    f.clock.advance(2_000); await control.get(f.gymId);
    expect(configured).toHaveBeenCalledOnce();
    f.clock.advance(58_000); await control.get(f.gymId);
    expect(configured).toHaveBeenCalledTimes(2);
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ revision: 2 }).where(eq(gyms.id, f.gymId)));
    await control.get(f.gymId);
    expect(configured).toHaveBeenCalledTimes(3);
  });
  it('queues once atomically, collapses retries, refuses a concurrent request and runs outside a transaction', async () => {
    const f = await fixture(), requestId = uuidv7();
    const replies = await Promise.all([f.request('owner', nowPath, { requestId }), f.request('admin', nowPath, { requestId: uuidv7() })]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
    const queued = await f.control.get(f.gymId);
    expect(queued.manual?.status).toBe('queued'); expect(f.snapshot).not.toHaveBeenCalled();
    expect((await f.request('owner', nowPath, { requestId: queued.manual!.requestId })).status).toBe(200);
    expect(await f.queue.runNext()).toBe(true); expect(await f.queue.runNext()).toBe(false);
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith('manual');
    expect((await f.control.get(f.gymId)).manual).toMatchObject({ status: 'succeeded', snapshotId: f.snapshotId, completedAt: f.clock.now().toISOString() });
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'backup.requested')));
    expect(audits).toHaveLength(1);
  });
  it.each(roles)('enforces read, request and owner-only confirmation permissions for %s', async role => {
    const f = await fixture(), allowed = role === 'owner' || role === 'admin';
    expect((await f.request(role)).status).toBe(allowed ? 200 : 403);
    expect((await f.request(role, nowPath, { requestId: uuidv7() })).status).toBe(allowed ? 200 : 403);
    expect((await f.request(role, confirmPath, { revision: 1, confirmed: true })).status).toBe(role === 'owner' ? 200 : 403);
    expect((await f.control.get(f.gymId)).pruningHeld).toBe(role !== 'owner');
    await f.queue.runNext();
  });
  it('refuses an unconfigured destination, a restore and multi-gym installs without queuing', async () => {
    const f = await fixture();
    f.state.configured = null;
    expect((await f.request('owner', nowPath, { requestId: uuidv7() })).status).toBe(409);
    f.state.configured = f.gymId; f.state.restoring = true;
    expect((await f.request('owner', nowPath, { requestId: uuidv7() })).status).toBe(409);
    f.state.restoring = false; f.state.available = false;
    expect((await f.request('owner', nowPath, { requestId: uuidv7() })).status).toBe(409);
    expect(await f.queue.runNext()).toBe(false);
  });
  it('rejects another gym session and never triggers the configured gym from another gym host', async () => {
    const a = await fixture(), b = await fixture();
    for (const [path, body] of [['/api/health/backups', undefined], [nowPath, { requestId: uuidv7() }], [confirmPath, { revision: 1, confirmed: true }]] as const)
      expect((await b.request('owner', path, body, a.gymId)).status).toBe(403);
    b.state.configured = a.gymId;
    expect((await b.request('owner', nowPath, { requestId: uuidv7() })).status).toBe(409);
    expect(await b.queue.runNext()).toBe(false); expect(await a.queue.runNext()).toBe(false);
    expect((await a.control.get(a.gymId)).pruningHeld).toBe(true);
    expect((await b.control.get(b.gymId)).pruningHeld).toBe(true);
  });
  it('requires explicit confirmation and the current revision, preserving unrelated settings and auditing the release', async () => {
    const f = await fixture();
    expect((await f.request('owner', confirmPath, { revision: 1, confirmed: false })).status).toBe(400);
    expect((await f.request('owner', confirmPath, { revision: 99, confirmed: true })).status).toBe(409);
    const response = await f.request('owner', confirmPath, { revision: 1, confirmed: true });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await f.read(response)).toMatchObject({ pruningHeld: false, revision: 2 });
    const [row] = await db.forGym(f.gymId, tx => tx.select().from(gyms));
    expect(row?.settings).toMatchObject({ backupPruningHeld: false, kept: 'yes' });
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'backup.old_server_gone_confirmed')));
    expect(audits).toHaveLength(1); expect(audits[0]?.actorUserId).toBe(f.user.id);
  });
  it('shows failures and recovers a request whose worker died, allowing a new deliberate request', async () => {
    const f = await fixture();
    f.snapshot.mockRejectedValueOnce(new Error('destination unavailable'));
    await f.control.request({ gymId: f.gymId, userId: f.user.id }, uuidv7());
    await f.queue.runNext();
    expect((await f.control.get(f.gymId)).manual?.status).toBe('failed');
    const requestId = uuidv7();
    await f.control.request({ gymId: f.gymId, userId: f.user.id }, requestId);
    // A replacement worker exhausts the job without the backup handler recording the failure.
    const crashed = new PostgresJobs({ database: db, clock: f.clock });
    crashed.handle(manualBackupJob, async () => { throw new Error('worker stopped'); });
    await crashed.runNext();
    expect((await f.control.get(f.gymId)).manual?.status).toBe('failed');
    expect((await f.request('owner', nowPath, { requestId: uuidv7() })).status).toBe(200);
    await f.queue.runNext();
  });
});
