// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- The holder reads its backend PID for the lock-wait probe.
import { eq, sql } from 'drizzle-orm';
import { classBookings, classSessions, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import type { RestoreNotice } from '../announcements/restored.js';
import { createScheduleService } from './schedule.js';

// A restore reads every marked member `for share` before it locks the session, so an erasure that commits while the
// restore runs is either read as erased or waits for the restore, and a check-in (member, then session) can't deadlock
// with it. The test database allows two app connections: the holder and the restore.
const db = useTestDatabase(), factory = createFactories(db);

async function cancelledDate() {
  const gymId = uuidv7(), clock = new TestClock('2026-03-01T00:00:00Z');
  await factory('gyms', gymId, { timezone: 'America/New_York' });
  const user = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role: 'owner' });
  const coach = await factory('staffProfiles', gymId, {});
  const session = await factory('classSessions', gymId, { name: 'Restore lock test', coachId: coach.id, capacity: 3,
    startsAt: new Date('2026-03-02T18:00:00Z'), endsAt: new Date('2026-03-02T19:00:00Z') });
  await factory('classSessionPrograms', gymId, { sessionId: session.id });
  const ids: Record<'A' | 'B', string> = { A: '', B: '' };
  for (const [name, minute] of [['A', 1], ['B', 2]] as const) {
    const member = await factory('members', gymId, { firstName: name });
    ids[name] = member.id;
    await factory('classBookings', gymId, { sessionId: session.id, memberId: member.id, bookedBy: user.id, status: 'booked',
      createdAt: new Date(Date.UTC(2026, 1, 20, 12, minute)) });
  }
  const enqueue = vi.fn<RestoreNotice['enqueue']>(async () => {});
  const service = createScheduleService({ scope: db.forGym, clock, restore: { enqueue } });
  const actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const revision = async () => (await db.forGym(gymId, tx => tx.select().from(classSessions).where(eq(classSessions.id, session.id))))[0]!.revision;
  await service.changeSession(actor, session.id, 'cancel', { revision: await revision() });
  const bookings = async () => Object.fromEntries((await db.forGym(gymId, tx => tx.select().from(classBookings)
    .where(eq(classBookings.sessionId, session.id)))).map(row => [row.memberId === ids.A ? 'A' : row.memberId === ids.B ? 'B' : row.memberId, row]));
  return { gymId, clock, session, ids, enqueue, service, actor, revision, bookings };
}

type Fixture = Awaited<ReturnType<typeof cancelledDate>>;
type Change = 'erase' | 'delete' | 'none' | 'check-in' | { remark: string };

/**
 * Holds a row while a notifying restore runs, checks the restore waits for it, then lets the holder finish. Member A is
 * held `for update` (erasure's and check-in's first lock); a `remark` holds the session instead and marks that booking.
 */
async function restoreWhileHeld(f: Fixture, change: Change) {
  const revision = await f.revision();
  const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
  const holder = db.forGym(f.gymId, async tx => {
    // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
    const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
    const lockSession = async () => (await tx.select({ status: classSessions.status }).from(classSessions)
      .where(eq(classSessions.id, f.session.id)).for('update'))[0]!.status;
    if (typeof change === 'object') await lockSession();
    // Erasure's own order: the member row first, then its anonymization.
    else await tx.select({ id: members.id }).from(members).where(eq(members.id, f.ids.A)).for('update');
    if (change === 'erase') await tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.ids.A));
    if (change === 'delete') {
      await tx.delete(classBookings).where(eq(classBookings.memberId, f.ids.A));
      await tx.delete(members).where(eq(members.id, f.ids.A));
    }
    locked.resolve(pid);
    await release.promise;
    // A class check-in's order: the member, then the session, which it refuses once it reads it cancelled.
    if (change === 'check-in') return lockSession();
    // A cancellation under the session lock that marks a booking the restore's first read didn't see.
    if (typeof change === 'object') await tx.update(classBookings).set({ sessionCancelStatus: 'booked' }).where(eq(classBookings.id, change.remark));
    return undefined;
  });
  // A holder that fails before it holds its lock shows its own error rather than a timeout.
  const pid = await Promise.race([locked.promise, holder.then(() => -1)]);
  if (pid < 0) throw new Error('The holder finished before it held its lock');
  let finished = false;
  const restoring = f.service.restoreSession(f.actor, f.session.id, { revision, notify: true, channels: ['email'] })
    .finally(() => { finished = true; });
  // Handled here so a refusal while the probe runs isn't reported as unhandled; the caller still sees it.
  restoring.catch(() => {});
  try {
    let sawWait = false;
    const deadline = Date.now() + 5000;
    while (!sawWait && !finished && Date.now() < deadline) {
      // eslint-disable-next-line database/system-tables -- The lock-wait probe.
      sawWait = (await db.system.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
      if (!sawWait) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(sawWait).toBe(true);
    expect(finished).toBe(false);
  } finally {
    release.resolve();
  }
  const held = await holder;
  return { held, restored: await restoring };
}

describe('restoring a cancelled date while a marked member is being erased', () => {
  it('waits for the erasure, then leaves the erased member cancelled and out of the notice', async () => {
    const f = await cancelledDate();
    expect((await restoreWhileHeld(f, 'erase')).restored).toMatchObject({ status: 'scheduled', restoredBookings: 1 });
    const rows = await f.bookings();
    expect(rows.A).toMatchObject({ status: 'cancelled', sessionCancelStatus: null, sessionCancelPosition: null });
    expect(rows.B).toMatchObject({ status: 'booked', cancelledAt: null, sessionCancelStatus: null, sessionCancelPosition: null });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0]![1]).toEqual({ sessionId: f.session.id, memberIds: [f.ids.B], channels: ['email'], round: 1 });
  });

  it('waits for a transaction that only locks the member, then restores everyone', async () => {
    const f = await cancelledDate();
    expect((await restoreWhileHeld(f, 'none')).restored).toMatchObject({ status: 'scheduled', restoredBookings: 2 });
    const rows = await f.bookings();
    expect(rows.A).toMatchObject({ status: 'booked', cancelledAt: null, sessionCancelStatus: null });
    expect(rows.B).toMatchObject({ status: 'booked', cancelledAt: null, sessionCancelStatus: null });
    expect(f.enqueue.mock.calls[0]![1]).toEqual({ sessionId: f.session.id, memberIds: [f.ids.A, f.ids.B].sort(), channels: ['email'], round: 1 });
  });

  it('waits for a member deleted with their bookings, then restores the others', async () => {
    const f = await cancelledDate();
    expect((await restoreWhileHeld(f, 'delete')).restored).toMatchObject({ status: 'scheduled', restoredBookings: 1 });
    const rows = await f.bookings();
    expect(rows.A).toBeUndefined();
    expect(rows.B).toMatchObject({ status: 'booked', cancelledAt: null, sessionCancelStatus: null });
    expect(f.enqueue.mock.calls[0]![1]).toEqual({ sessionId: f.session.id, memberIds: [f.ids.B], channels: ['email'], round: 1 });
  });

  it('lets a check-in holding a marked member lock the session first, without a deadlock', async () => {
    const f = await cancelledDate();
    // The check-in reads the session still cancelled (and refuses there); the restore then runs as usual.
    const { held, restored } = await restoreWhileHeld(f, 'check-in');
    expect(held).toBe('cancelled');
    expect(restored).toMatchObject({ status: 'scheduled', restoredBookings: 2 });
    const rows = await f.bookings();
    expect(rows.A).toMatchObject({ status: 'booked', sessionCancelStatus: null });
    expect(rows.B).toMatchObject({ status: 'booked', sessionCancelStatus: null });
  });

  it('refuses when the session marks a member its locks missed while the restore waited', async () => {
    const f = await cancelledDate();
    const c = await factory('members', f.gymId, { firstName: 'C' });
    const user = f.actor.actor.userId;
    const late = await factory('classBookings', f.gymId, { sessionId: f.session.id, memberId: c.id, bookedBy: user, status: 'cancelled',
      cancelledAt: new Date('2026-02-25T12:00:00Z') });
    await expect(restoreWhileHeld(f, { remark: late.id })).rejects.toMatchObject({ code: 'conflict' });
    const [session] = await db.forGym(f.gymId, tx => tx.select().from(classSessions).where(eq(classSessions.id, f.session.id)));
    expect(session!.status).toBe('cancelled');
    const rows = await f.bookings();
    expect(rows.A).toMatchObject({ status: 'cancelled', sessionCancelStatus: 'booked' });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
