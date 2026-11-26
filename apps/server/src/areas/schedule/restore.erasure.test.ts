// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- The holder reads its backend PID for the lock-wait probe.
import { eq, sql } from 'drizzle-orm';
import { classBookings, classSessions, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import type { RestoreNotice } from '../announcements/restored.js';
import { promoteWaitlist } from '../bookings/bookings.js';
import { createMembersService } from '../members/members.js';
import { createScheduleService } from './schedule.js';

// A restore reads every marked member `for share` before it locks the session, so an erasure that commits while the
// restore runs is either read as erased or waits for the restore, and a check-in (member, then session) can't deadlock
// with it. The test database allows two app connections: the holder and the restore, or (with the holder on the
// system connection) the restore and the erasure.
const db = useTestDatabase(), factory = createFactories(db);

/** A cancelled session with A and B booked; `waitlist` makes it full at 2 with C first on its waitlist. */
async function cancelledDate({ waitlist = false } = {}) {
  const gymId = uuidv7(), clock = new TestClock('2026-03-01T00:00:00Z');
  await factory('gyms', gymId, { timezone: 'America/New_York' });
  const user = await factory('authUser', gymId);
  await factory('staffRoles', gymId, { userId: user.id, role: 'owner' });
  const coach = await factory('staffProfiles', gymId, {});
  const session = await factory('classSessions', gymId, { name: 'Restore lock test', coachId: coach.id, capacity: waitlist ? 2 : 3,
    startsAt: new Date('2026-03-02T18:00:00Z'), endsAt: new Date('2026-03-02T19:00:00Z') });
  await factory('classSessionPrograms', gymId, { sessionId: session.id });
  const ids: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
  const people = [['A', 1], ['B', 2], ...(waitlist ? [['C', 3]] as const : [])] as const;
  for (const [name, minute] of people) {
    const member = await factory('members', gymId, { firstName: name });
    ids[name] = member.id;
    await factory('classBookings', gymId, { sessionId: session.id, memberId: member.id, bookedBy: user.id,
      ...(name === 'C' ? { status: 'waitlisted', waitlistPosition: 1 } : { status: 'booked' }),
      createdAt: new Date(Date.UTC(2026, 1, 20, 12, minute)) });
  }
  const enqueue = vi.fn<RestoreNotice['enqueue']>(async () => {});
  const service = createScheduleService({ scope: db.forGym, clock, restore: { enqueue } });
  const actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const revision = async () => (await db.forGym(gymId, tx => tx.select().from(classSessions).where(eq(classSessions.id, session.id))))[0]!.revision;
  await service.changeSession(actor, session.id, 'cancel', { revision: await revision() });
  const bookings = async () => Object.fromEntries((await db.forGym(gymId, tx => tx.select().from(classBookings)
    .where(eq(classBookings.sessionId, session.id)))).map(row => [(['A', 'B', 'C'] as const).find(name => ids[name] === row.memberId) ?? row.memberId, row]));
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

/**
 * Runs the real erasure or deletion of member A while a notifying restore already holds A `for share`. A holder on the
 * system connection locks the session, so the restore stops right after its member locks; the erasure then waits for
 * the restore. After both commit, the freed places go to the waitlist, as the members routes do after commit.
 */
async function eraseDuringRestore(f: Fixture, change: 'erase' | 'delete') {
  const revision = await f.revision();
  const [member] = await db.forGym(f.gymId, tx => tx.select({ revision: members.revision }).from(members).where(eq(members.id, f.ids.A)));
  const service = createMembersService({ scope: db.forGym, clock: f.clock });
  const context = { gymId: f.gymId, actor: { kind: 'system' as const } };
  const cleanup = { jobs: new FakeJobs(f.clock), timezone: 'America/New_York' };
  let restoring: ReturnType<Fixture['service']['restoreSession']> | undefined;
  let erasing: Promise<{ freedSessionIds: string[] }> | undefined;
  type Waits = { onHolder: number; onRestore: number; waiting: number };
  const seen: Waits[] = [];
  // Until the backends waiting on a lock in this database are the expected ones, or 5 s pass. `onRestore` counts the
  // backends blocked by one that the holder blocks: the restore, paused before its session lock.
  const waitFor = async (tx: { execute: typeof db.system.db.execute }, expected: Waits) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      // eslint-disable-next-line database/system-tables -- The lock-wait probe, run by the holder.
      const [row] = await tx.execute<Waits>(sql`select
        (count(*) filter (where pg_backend_pid() = any(pg_blocking_pids(a.pid))))::int as "onHolder",
        (count(*) filter (where exists (select 1 from pg_stat_activity r where pg_backend_pid() = any(pg_blocking_pids(r.pid))
          and r.pid = any(pg_blocking_pids(a.pid)))))::int as "onRestore",
        (count(*) filter (where a.wait_event_type = 'Lock'))::int as waiting
        from pg_stat_activity a where a.datname = current_database()`);
      if (row!.onHolder === expected.onHolder && row!.onRestore === expected.onRestore && row!.waiting === expected.waiting) {
        seen.push(row!); return;
      }
      if (Date.now() > deadline) throw new Error(`Expected lock waits ${JSON.stringify(expected)}, saw ${JSON.stringify(row)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  // The holder is on the system connection: the app pool's two connections run the restore and the erasure.
  const holder = db.system.db.transaction(async tx => {
    // System context sees no gym rows; the gym setting lets the holder find and lock this gym's session.
    // eslint-disable-next-line database/system-tables -- The holder scopes its system connection to this gym.
    await tx.execute(sql`select set_config('app.gym_id', ${f.gymId}, true)`);
    expect(await tx.select({ id: classSessions.id }).from(classSessions).where(eq(classSessions.id, f.session.id)).for('update')).toHaveLength(1);
    restoring = f.service.restoreSession(f.actor, f.session.id, { revision, notify: true, channels: ['email'] });
    // Handled here so a refusal while the probe runs isn't reported as unhandled; the caller still sees it.
    restoring.catch(() => {});
    // The restore has its member share locks and waits for the session.
    await waitFor(tx, { onHolder: 1, onRestore: 0, waiting: 1 });
    erasing = change === 'erase' ? service.eraseMember(context, f.ids.A, { revision: member!.revision }, cleanup)
      : service.deleteMember(context, f.ids.A, member!.revision, cleanup);
    erasing.catch(() => {});
    // The erasure waits too, and not on the holder: on the restore, whose only row locks are its member share locks.
    await waitFor(tx, { onHolder: 1, onRestore: 1, waiting: 2 });
  });
  // The holder commits (or rolls back on a failed probe) and so releases the session; both calls then finish.
  try { await holder; } finally { await Promise.allSettled([restoring, erasing]); }
  const restored = await restoring!, { freedSessionIds } = await erasing!;
  for (const sessionId of freedSessionIds) await promoteWaitlist(f.gymId, sessionId, { scope: db.forGym, clock: f.clock });
  return { restored, freedSessionIds, seen };
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

describe('erasing or deleting a marked member while a restore already holds the marked members', () => {
  it('waits for the restore, then frees the erased member’s restored place for the waitlist', async () => {
    const f = await cancelledDate({ waitlist: true });
    const { restored, freedSessionIds, seen } = await eraseDuringRestore(f, 'erase');
    expect(seen).toEqual([{ onHolder: 1, onRestore: 0, waiting: 1 }, { onHolder: 1, onRestore: 1, waiting: 2 }]);
    // Everyone came back (A and B booked, C waitlisted) before the erasure ran.
    expect(restored).toMatchObject({ status: 'scheduled', restoredBookings: 3 });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0]![1]).toEqual({ sessionId: f.session.id, memberIds: [f.ids.A, f.ids.B, f.ids.C].sort(), channels: ['email'], round: 1 });
    expect(freedSessionIds).toEqual([f.session.id]);
    const rows = await f.bookings();
    expect(rows.A).toMatchObject({ status: 'cancelled', cancelledAt: f.clock.now(), waitlistPosition: null, sessionCancelStatus: null });
    expect(rows.B).toMatchObject({ status: 'booked', cancelledAt: null, sessionCancelStatus: null });
    expect(rows.C).toMatchObject({ status: 'booked', cancelledAt: null, waitlistPosition: null, sessionCancelStatus: null });
    const [erased] = await db.forGym(f.gymId, tx => tx.select({ anonymizedAt: members.anonymizedAt }).from(members).where(eq(members.id, f.ids.A)));
    expect(erased!.anonymizedAt).toEqual(f.clock.now());
  });

  it('waits for the restore, then deletes the member with the restored booking and promotes the waitlist', async () => {
    const f = await cancelledDate({ waitlist: true });
    const { restored, freedSessionIds, seen } = await eraseDuringRestore(f, 'delete');
    expect(seen).toEqual([{ onHolder: 1, onRestore: 0, waiting: 1 }, { onHolder: 1, onRestore: 1, waiting: 2 }]);
    expect(restored).toMatchObject({ status: 'scheduled', restoredBookings: 3 });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0]![1]).toEqual({ sessionId: f.session.id, memberIds: [f.ids.A, f.ids.B, f.ids.C].sort(), channels: ['email'], round: 1 });
    expect(freedSessionIds).toEqual([f.session.id]);
    const rows = await f.bookings();
    expect(rows.A).toBeUndefined();
    expect(rows.B).toMatchObject({ status: 'booked', cancelledAt: null, sessionCancelStatus: null });
    expect(rows.C).toMatchObject({ status: 'booked', cancelledAt: null, waitlistPosition: null, sessionCancelStatus: null });
    expect(await db.forGym(f.gymId, tx => tx.select({ id: members.id }).from(members).where(eq(members.id, f.ids.A)))).toEqual([]);
  });
});
