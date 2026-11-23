// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { auditEvents, classBookings, classSessions, members as memberRows, uuidv7 } from '@plaingym/db';
import { bookingRosterQuerySchema } from '@plaingym/shared/contracts';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createAttendanceService } from '../attendance/attendance.js';
import { createBookingService, promoteWaitlist } from './bookings.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createMembersService } from '../members/members.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createSettingsService } from '../settings/settings.js';

const db = useTestDatabase(), factory = createFactories(db), page = { limit: 50, offset: 0 };
async function fixture(capacity: number | null = 1) {
  const gymId = uuidv7(), clock = new TestClock('2026-10-29T16:00:00Z');
  await factory('gyms', gymId, { timezone: 'America/Vancouver', bookingWindowDays: 7, cancellationCutoffMinutes: 60, memberEmailsEnabled: true });
  const user = await factory('authUser', gymId), member = await factory('members', gymId), other = await factory('members', gymId);
  const session = await factory('classSessions', gymId, { startsAt: new Date('2026-10-30T18:00:00Z'), endsAt: new Date('2026-10-30T19:00:00Z'), capacity });
  const program = await factory('programs', gymId);
  await factory('classSessionPrograms', gymId, { sessionId: session.id, programId: program.id });
  const actor = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const options = { scope: db.forGym, clock }, service = createBookingService(options);
  const book = async (memberId = member.id, allowWaitlist = true) => (await service.book(actor, { sessionId: session.id, memberId, allowWaitlist })).booking;
  return { gymId, clock, user, member, other, session, actor, options, service, book };
}

/**
 * A scope whose transaction runs `mutation`, committed on a connection of its own, right after its `at`-th select statement
 * finishes. `finish` runs the mutation afterwards when the service issued fewer statements, and waits for it. `rows` records
 * how many rows each select statement returned, in order.
 */
function interleaved(at: number, mutation: () => Promise<unknown> = async () => undefined) {
  let go!: () => void, statements = 0;
  const rows: number[] = [];
  // Chained here, outside the service's scope, so the mutation opens a transaction of its own.
  const done = new Promise<void>(resolve => { go = resolve; }).then(mutation);
  type Query = PromiseLike<unknown> & Record<string, unknown>;
  type Select = (...args: unknown[]) => { from: (...from: unknown[]) => Query };
  const pause = (query: Query) => {
    const then = query.then.bind(query);
    query.then = ((ok, fail) => then(async result => {
      rows.push((result as unknown[]).length);
      if (++statements === at) { go(); await done; }
      return result;
    }).then(ok, fail)) as Query['then'];
    return query;
  };
  const paused = (select: Select): Select => (...args) => {
    const builder = select(...args), from = builder.from.bind(builder);
    builder.from = (...table) => pause(from(...table));
    return builder;
  };
  const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, tx => fn(new Proxy(tx, { get(target, key) {
    const value = Reflect.get(target, key) as unknown;
    if (typeof value !== 'function') return value;
    if (key === 'select') return paused(value.bind(target) as Select);
    // A statement that starts with common table expressions: tx.with(...).select(...).from(...).
    if (key === 'with') return (...args: unknown[]) => {
      const builder = (value as (...with_: unknown[]) => { select: Select }).apply(target, args);
      builder.select = paused(builder.select.bind(builder));
      return builder;
    };
    return value.bind(target) as unknown;
  } })));
  return { scope, rows, finish: async () => { go(); await done; } };
}

describe('booking transactions', () => {
  it('serializes two members racing for the last spot: exactly one booked and one waitlisted', async () => {
    const f = await fixture();
    const result = await Promise.all([f.book(), f.book(f.other.id)]);
    expect(result.map(row => row.status).sort()).toEqual(['booked', 'waitlisted']);
    expect(result.find(row => row.status === 'waitlisted')).toMatchObject({ waitlistPosition: 1, queueRank: 1 });
    expect(await db.forGym(f.gymId, tx => tx.$count(classBookings))).toBe(2);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(2);
  });
  it('replaying and racing the same booking returns one place and one audit', async () => {
    const f = await fixture();
    const rows = await Promise.all([f.book(), f.book(), f.book()]);
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents))).toBe(1);
  });
  it('rejects a full class when waitlisting is not allowed', async () => {
    const f = await fixture(); await f.book();
    await expect(f.book(f.other.id, false)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['full'] } });
    expect((await f.service.list(f.gymId, page)).data).toHaveLength(1);
  });
  it('keeps allocation gaps, ranks the live queue, and never lets a newcomer jump the waitlist', async () => {
    const f = await fixture(); const first = await f.book(), one = await f.book(f.other.id);
    const m2 = await factory('members', f.gymId), m3 = await factory('members', f.gymId), m4 = await factory('members', f.gymId);
    const two = await f.book(m2.id), three = await f.book(m3.id);
    await f.service.cancel(f.actor, two.id); await f.service.cancel(f.actor, first.id);
    const four = await f.book(m4.id);
    expect(four).toMatchObject({ status: 'waitlisted', waitlistPosition: 4, queueRank: 2 });
    await f.service.promote(f.gymId, f.session.id);
    const rows = (await f.service.list(f.gymId, page)).data;
    expect(rows.find(row => row.id === one.id)).toMatchObject({ status: 'booked', waitlistPosition: null });
    expect(rows.find(row => row.id === three.id)).toMatchObject({ waitlistPosition: 3, queueRank: 1 });
    expect(rows.find(row => row.id === four.id)).toMatchObject({ waitlistPosition: 4, queueRank: 2 });
  });
  it('promotion is idempotent under concurrent and repeated calls', async () => {
    const f = await fixture(), booked = await f.book(), waiting = await f.book(f.other.id);
    await f.service.cancel(f.actor, booked.id);
    const promoted = await Promise.all([f.service.promote(f.gymId, f.session.id), f.service.promote(f.gymId, f.session.id)]);
    expect(promoted.flat().map(row => row.id)).toEqual([waiting.id]);
    expect(await f.service.promote(f.gymId, f.session.id)).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.promoted')))).toBe(1);
  });
  it('uses the current cancellation cutoff; the boundary is allowed and a millisecond later is rejected', async () => {
    const f = await fixture(2), first = await f.book(), second = await f.book(f.other.id);
    f.clock.set('2026-10-30T17:00:00Z');
    await f.service.cancel(f.actor, first.id);
    f.clock.advance(1);
    await expect(f.service.cancel(f.actor, second.id)).rejects.toMatchObject({ code: 'conflict' });
    // A lost success response remains retryable after the cutoff, with no additional audit.
    expect((await f.service.cancel(f.actor, first.id)).status).toBe('cancelled');
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.cancelled')))).toBe(1);
  });
  it('rejects late waitlist cancellation too and reloads changed gym rules', async () => {
    const f = await fixture(), booked = await f.book(), waiting = await f.book(f.other.id);
    const settings = createSettingsService(f.options);
    await settings.update(f.actor, 'booking', { revision: (await settings.get(f.gymId)).revision, cancellationCutoffMinutes: 180 });
    f.clock.set('2026-10-30T16:00:00Z');
    for (const row of [booked, waiting]) await expect(f.service.cancel(f.actor, row.id)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('enforces the gym-local booking window, cancelled/started classes and no-reservation classes', async () => {
    const f = await fixture();
    f.clock.set('2026-10-23T06:59:59.999Z');
    await expect(f.book()).rejects.toMatchObject({ code: 'conflict' });
    f.clock.advance(1); expect((await f.book()).status).toBe('booked');
    f.clock.set(f.session.startsAt); await expect(f.book(f.other.id)).rejects.toMatchObject({ code: 'conflict' });
    const noBooking = await fixture(null); await expect(noBooking.book()).rejects.toMatchObject({ code: 'conflict' });
    const cancelled = await fixture();
    await db.forGym(cancelled.gymId, tx => tx.update(classSessions).set({ status: 'cancelled' }).where(eq(classSessions.id, cancelled.session.id)));
    await expect(cancelled.book()).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rolls back a booking when the audit cannot be written', async () => {
    const f = await fixture();
    await expect(f.service.book({ gymId: f.gymId, actor: { kind: 'user', userId: uuidv7() } }, { memberId: f.member.id, sessionId: f.session.id, allowWaitlist: true })).rejects.toThrow();
    expect((await f.service.list(f.gymId, page)).data).toEqual([]);
  });
  it('rejects cross-gym resources for book, cancel, list filters, roster and promotion', async () => {
    const f = await fixture(), other = await fixture(), foreign = await other.book();
    for (const work of [
      () => f.book(other.member.id),
      () => f.service.book(f.actor, { memberId: f.member.id, sessionId: other.session.id, allowWaitlist: true }),
      () => f.service.cancel(f.actor, foreign.id),
      () => f.service.list(f.gymId, { ...page, memberId: other.member.id }),
      () => f.service.list(f.gymId, { ...page, sessionId: other.session.id }),
      () => f.service.roster(f.gymId, other.session.id, page),
      () => f.service.promote(f.gymId, other.session.id),
    ]) await expect(work()).rejects.toMatchObject({ code: 'not_found' });
  });
  it('reports booked vs checked-in members and walk-ins once, with pagination', async () => {
    const f = await fixture(), booked = await f.book();
    await factory('attendances', f.gymId, { memberId: f.member.id, sessionId: f.session.id });
    await factory('attendances', f.gymId, { memberId: f.other.id, sessionId: f.session.id });
    const roster = await f.service.roster(f.gymId, f.session.id, page);
    expect(roster.data).toHaveLength(2);
    expect(roster.data.find(row => row.booking?.id === booked.id)?.displayName).toBe(`${f.member.firstName} ${f.member.lastName}`);
    expect(roster.data.find(row => row.booking === null)?.displayName).toBe(`${f.other.firstName} ${f.other.lastName}`);
    expect(roster.data.find(row => row.booking?.id === booked.id)?.attendance?.memberId).toBe(f.member.id);
    expect(roster.data.find(row => row.booking === null)?.attendance?.memberId).toBe(f.other.id);
    expect(await f.service.roster(f.gymId, f.session.id, { limit: 1, offset: 1 })).toMatchObject({ pagination: { total: 2 } });
  });
  it('lists only eligible members on request: booked, then the waitlist in queue order, then walk-ins, across pages', async () => {
    const f = await fixture(3), foreign = await fixture(3);
    const [erased, cancelled, firstWait, secondWait, walkIn, erasedWalkIn] = await Promise.all([1, 2, 3, 4, 5, 6].map(() => factory('members', f.gymId)));
    await f.book(); await f.book(erased!.id); await f.book(cancelled!.id);
    const first = await f.book(firstWait!.id), second = await f.book(secondWait!.id);
    expect([first.status, second.status]).toEqual(['waitlisted', 'waitlisted']);
    await factory('attendances', f.gymId, { memberId: walkIn!.id, sessionId: f.session.id });
    await factory('attendances', f.gymId, { memberId: erasedWalkIn!.id, sessionId: f.session.id });
    // Rows written before the member was erased or Cancelled stay in the session; the eligible roster leaves them out.
    await db.forGym(f.gymId, tx => tx.update(memberRows).set({ anonymizedAt: f.clock.now() }).where(inArray(memberRows.id, [erased!.id, erasedWalkIn!.id])));
    await db.forGym(f.gymId, tx => tx.update(memberRows).set({ status: 'cancelled' }).where(eq(memberRows.id, cancelled!.id)));
    await foreign.book(); await factory('attendances', foreign.gymId, { memberId: foreign.other.id, sessionId: foreign.session.id });
    const eligible = { ...page, checkInEligible: true };
    const roster = await f.service.roster(f.gymId, f.session.id, eligible);
    const order = [f.member.id, firstWait!.id, secondWait!.id, walkIn!.id];
    expect(roster.data.map(row => row.booking?.memberId ?? row.attendance?.memberId)).toEqual(order);
    expect(roster.data.map(row => row.booking?.queueRank ?? null)).toEqual([null, 1, 2, null]);
    expect(roster.pagination).toEqual({ ...page, total: 4 });
    expect(roster.counts).toEqual({ booked: 1, waitlisted: 2, checkedIn: 1 });
    // Every page keeps the same order, total and whole-session counts.
    for (const [offset, memberId] of order.entries()) {
      const single = await f.service.roster(f.gymId, f.session.id, { limit: 1, offset, checkInEligible: true });
      expect(single.data.map(row => row.booking?.memberId ?? row.attendance?.memberId)).toEqual([memberId]);
      expect(single.pagination.total).toBe(4); expect(single.counts).toEqual(roster.counts);
    }
    expect((await f.service.roster(f.gymId, f.session.id, { limit: 1, offset: 4, checkInEligible: true })).data).toEqual([]);
    // Omitted or false keeps every member, ordered by ID, with the unfiltered counts.
    for (const query of [page, { ...page, checkInEligible: false }]) {
      const all = await f.service.roster(f.gymId, f.session.id, query);
      expect(all.data.map(row => row.booking?.memberId ?? row.attendance?.memberId))
        .toEqual([f.member.id, erased!.id, cancelled!.id, firstWait!.id, secondWait!.id, walkIn!.id, erasedWalkIn!.id].sort());
      expect(all.counts).toEqual({ booked: 3, waitlisted: 2, checkedIn: 2 });
    }
    // Cancelling the first waitlist booking moves the other to first place; a check-in leaves the booking waitlisted.
    await f.service.cancel(f.actor, first.id);
    const attendance = await createAttendanceService(f.options).record(f.actor, { memberId: secondWait!.id, sessionId: f.session.id, programId: null });
    const after = await f.service.roster(f.gymId, f.session.id, eligible);
    expect(after.data.map(row => row.booking?.memberId ?? row.attendance?.memberId)).toEqual([f.member.id, secondWait!.id, walkIn!.id]);
    expect(after.data[1]).toMatchObject({ booking: { id: second.id, status: 'waitlisted', queueRank: 1, waitlistPosition: second.waitlistPosition },
      attendance: { id: attendance.id, memberId: secondWait!.id } });
    expect(after.counts).toEqual({ booked: 1, waitlisted: 1, checkedIn: 2 });
    // The route's parsed query parses again in the service, and another gym's session is not found.
    expect((await f.service.roster(f.gymId, f.session.id, bookingRosterQuerySchema.parse({ checkInEligible: 'true' }))).pagination.total).toBe(3);
    await expect(f.service.roster(f.gymId, foreign.session.id, eligible)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('describes one moment in the roster while a check-in or a promotion commits between its statements', async () => {
    const mutations = {
      checkIn: (f: Awaited<ReturnType<typeof fixture>>) => createAttendanceService(f.options).record(f.actor, { memberId: f.member.id, sessionId: f.session.id, programId: null }),
      promote: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db.forGym(f.gymId, tx => tx.update(classSessions).set({ capacity: 2 }).where(eq(classSessions.id, f.session.id)));
        await promoteWaitlist(f.gymId, f.session.id, f.options);
      },
    };
    for (const [name, mutate] of Object.entries(mutations)) for (const query of [{ ...page, checkInEligible: true }, { limit: 1, offset: 1, checkInEligible: true }, page]) {
      for (const at of [1, 2, 3, 4, 5, 6]) {
        const f = await fixture(1);
        await f.book(); expect((await f.book(f.other.id)).status).toBe('waitlisted');
        const before = await f.service.roster(f.gymId, f.session.id, query);
        const run = interleaved(at, () => mutate(f));
        const during = await createBookingService({ ...f.options, scope: run.scope }).roster(f.gymId, f.session.id, query);
        await run.finish();
        const after = await f.service.roster(f.gymId, f.session.id, query);
        expect(after, `${name} changes the roster`).not.toEqual(before);
        expect([before, after], `${name} after statement ${at} of ${JSON.stringify(query)}`).toContainEqual(during);
      }
    }
  });
  it('reads full records for the requested roster page only, with whole-session totals, counts and places in line', async () => {
    const f = await fixture(2), empty = await fixture(2);
    const [erased, firstWait, secondWait, walkIn] = await Promise.all([1, 2, 3, 4].map(() => factory('members', f.gymId)));
    await f.book(); await f.book(erased!.id);
    expect([(await f.book(firstWait!.id)).status, (await f.book(secondWait!.id)).status]).toEqual(['waitlisted', 'waitlisted']);
    await factory('attendances', f.gymId, { memberId: walkIn!.id, sessionId: f.session.id });
    await db.forGym(f.gymId, tx => tx.update(memberRows).set({ anonymizedAt: f.clock.now() }).where(eq(memberRows.id, erased!.id)));
    const modes = [
      { query: { checkInEligible: true }, order: [f.member.id, firstWait!.id, secondWait!.id, walkIn!.id], counts: { booked: 1, waitlisted: 2, checkedIn: 1 } },
      { query: {}, order: [f.member.id, erased!.id, firstWait!.id, secondWait!.id, walkIn!.id].sort(), counts: { booked: 2, waitlisted: 2, checkedIn: 1 } },
      { query: { checkInEligible: false }, order: [f.member.id, erased!.id, firstWait!.id, secondWait!.id, walkIn!.id].sort(), counts: { booked: 2, waitlisted: 2, checkedIn: 1 } },
    ];
    const rank = new Map([[firstWait!.id, 1], [secondWait!.id, 2]]);
    const read = async (gymId: string, sessionId: string, query: Parameters<typeof f.service.roster>[2]) => {
      const run = interleaved(Infinity);
      const roster = await createBookingService({ ...f.options, scope: run.scope }).roster(gymId, sessionId, query);
      // The session check, then the roster statement.
      expect(run.rows).toHaveLength(2);
      return { roster, transferred: run.rows[1] };
    };
    for (const { query, order, counts } of modes) {
      const whole = await read(f.gymId, f.session.id, { ...page, ...query });
      expect(whole.roster.data.map(row => row.booking?.memberId ?? row.attendance?.memberId)).toEqual(order);
      expect(whole.transferred).toBe(order.length);
      for (const [offset, memberId] of order.entries()) {
        const single = await read(f.gymId, f.session.id, { limit: 1, offset, ...query });
        expect(single.roster.data.map(row => row.booking?.memberId ?? row.attendance?.memberId)).toEqual([memberId]);
        expect(single.roster.data[0]!.booking?.queueRank ?? null).toBe(rank.get(memberId) ?? null);
        expect(single.roster.pagination).toEqual({ limit: 1, offset, total: order.length });
        expect(single.roster.counts).toEqual(counts);
        // One participant's booking and attendance records, beside the session's totals.
        expect(single.transferred).toBe(1);
      }
      // Past the last page: no rows, the same total and counts, and only the totals row read.
      for (const offset of [order.length, order.length + 10]) {
        const beyond = await read(f.gymId, f.session.id, { limit: 1, offset, ...query });
        expect(beyond.roster).toEqual({ data: [], pagination: { limit: 1, offset, total: order.length }, counts });
        expect(beyond.transferred).toBe(1);
      }
      // A session nobody booked or attended.
      expect((await read(empty.gymId, empty.session.id, { ...page, ...query })).roster)
        .toEqual({ data: [], pagination: { ...page, total: 0 }, counts: { booked: 0, waitlisted: 0, checkedIn: 0 } });
    }
  });
  it('counts the whole session in the roster: booked, waitlisted and checked in, without cancelled or another gym', async () => {
    const f = await fixture(2), foreign = await fixture(2);
    const members = await Promise.all([1, 2, 3, 4].map(() => factory('members', f.gymId)));
    const first = await f.book(), second = await f.book(f.other.id);
    await f.book(members[0]!.id); await f.book(members[1]!.id); const gone = await f.book(members[2]!.id);
    await f.service.cancel(f.actor, gone.id);
    await foreign.book(); await foreign.book(foreign.other.id); await foreign.book(await factory('members', foreign.gymId).then(row => row.id));
    for (const member of [first.memberId, members[3]!.id]) await factory('attendances', f.gymId, { memberId: member, sessionId: f.session.id });
    await factory('attendances', foreign.gymId, { memberId: foreign.member.id, sessionId: foreign.session.id });
    const expected = { booked: 2, waitlisted: 2, checkedIn: 2 };
    expect((await f.service.roster(f.gymId, f.session.id, page)).counts).toEqual(expected);
    // A short or later page still reports the whole session.
    const small = await f.service.roster(f.gymId, f.session.id, { limit: 1, offset: 3 });
    expect(small.data).toHaveLength(1); expect(small.counts).toEqual(expected);
    await f.service.cancel(f.actor, second.id); await f.service.promote(f.gymId, f.session.id);
    expect((await f.service.roster(f.gymId, f.session.id, page)).counts).toEqual({ booked: 2, waitlisted: 1, checkedIn: 2 });
    expect((await foreign.service.roster(foreign.gymId, foreign.session.id, page)).counts).toEqual({ booked: 2, waitlisted: 1, checkedIn: 1 });
  });
  it('exports promotion for each session freed by erasure and does not book an erased member again', async () => {
    const f = await fixture(), booked = await f.book(), waiting = await f.book(f.other.id);
    const memberService = createMembersService(f.options);
    const erased = await memberService.eraseMember(f.actor, f.member.id, { revision: f.member.revision }, { jobs: new FakeJobs(f.clock), timezone: 'UTC' });
    expect(erased.freedSessionIds).toEqual([f.session.id]);
    const before = (await f.service.list(f.gymId, page)).data;
    expect(before.find(row => row.id === booked.id)?.status).toBe('cancelled');
    // This is the after-commit call the erasure route will make for each freed session.
    expect((await promoteWaitlist(f.gymId, f.session.id, f.options)).map(row => row.id)).toEqual([waiting.id]);
    expect(await promoteWaitlist(f.gymId, f.session.id, f.options)).toEqual([]);
    await expect(f.book()).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['patch', 'replace'] as const)('%s capacity edits reject below booked, preserve revision on rejection, and promote on an increase', async kind => {
    const f = await fixture(2), schedule = createScheduleService(f.options);
    await f.book(); await f.book(f.other.id);
    const third = await factory('members', f.gymId), waiting = await f.book(third.id);
    const program = await factory('programs', f.gymId);
    const change = async (capacity: number | null, revision: number) => kind === 'patch'
      ? schedule.changeSession(f.actor, f.session.id, 'capacity', { capacity, revision })
      : schedule.updateSession(f.actor, f.session.id, { name: f.session.name, startsAt: f.session.startsAt.toISOString(), endsAt: f.session.endsAt.toISOString(),
        capacity, revision, coachId: null, notes: null, kind: 'class', programIds: [program.id], tagIds: [] });
    await expect(change(1, 1)).rejects.toMatchObject({ code: 'conflict' });
    expect(await schedule.getSession(f.gymId, f.session.id)).toMatchObject({ capacity: 2, revision: 1 });
    expect((await change(3, 1)).capacity).toBe(3);
    expect((await f.service.list(f.gymId, page)).data.find(row => row.id === waiting.id)?.status).toBe('booked');
    await expect(change(4, 1)).rejects.toMatchObject({ name: 'RevisionConflictError' });
    const fourth = await factory('members', f.gymId); await f.book(fourth.id);
    await change(null, 2);
    expect((await f.service.list(f.gymId, { ...page, status: 'waitlisted' })).data).toEqual([]);
  });
  it('a capacity edit racing bookings never overbooks the updated capacity', async () => {
    const f = await fixture(2), schedule = createScheduleService(f.options);
    const results = await Promise.allSettled([f.book(), f.book(f.other.id), schedule.changeSession(f.actor, f.session.id, 'capacity', { capacity: 1, revision: 1 })]);
    expect(results.filter(row => row.status === 'fulfilled').length).toBeGreaterThanOrEqual(2);
    const session = await schedule.getSession(f.gymId, f.session.id);
    const count = await db.forGym(f.gymId, tx => tx.$count(classBookings, and(eq(classBookings.sessionId, session.id), eq(classBookings.status, 'booked'))));
    expect(count).toBeLessThanOrEqual(session.capacity!);
  });
  it('promotes at the exact cancellation cutoff, under the session lock, and freezes the waitlist a millisecond later', async () => {
    const f = await fixture(), first = await f.book(), waiting = await f.book(f.other.id);
    const third = await factory('members', f.gymId), last = await f.book(third.id);
    // Cutoff is 60 minutes before the 18:00 start; cancelling at exactly 17:00 is allowed, so promotion is too.
    f.clock.set('2026-10-30T17:00:00Z');
    await f.service.cancel(f.actor, first.id);
    const racing = await Promise.all([f.service.promote(f.gymId, f.session.id), f.service.promote(f.gymId, f.session.id)]);
    expect(racing.flat().map(row => row.id)).toEqual([waiting.id]);
    // The promoted member can still cancel at the same instant; the freed place is not refilled after the cutoff.
    await f.service.cancel(f.actor, waiting.id);
    f.clock.advance(1);
    expect(await f.service.promote(f.gymId, f.session.id)).toEqual([]);
    expect((await f.service.list(f.gymId, page)).data.find(row => row.id === last.id)).toMatchObject({ status: 'waitlisted' });
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.promoted')))).toBe(1);
  });
  it.each(['increase', 'remove'] as const)('a capacity %s after the cutoff saves the capacity and keeps the waitlist frozen', async change => {
    const f = await fixture(), schedule = createScheduleService(f.options);
    await f.book(); const waiting = await f.book(f.other.id);
    f.clock.set('2026-10-30T17:00:00.001Z');
    expect((await schedule.changeSession(f.actor, f.session.id, 'capacity', { capacity: change === 'increase' ? 3 : null, revision: 1 })).revision).toBe(2);
    expect((await f.service.list(f.gymId, page)).data.find(row => row.id === waiting.id)).toMatchObject({ status: 'waitlisted' });
  });
  it('reads the current cutoff under the lock, so raising it freezes promotion immediately', async () => {
    const f = await fixture(), first = await f.book(), waiting = await f.book(f.other.id);
    await f.service.cancel(f.actor, first.id);
    const settings = createSettingsService(f.options);
    await settings.update(f.actor, 'booking', { revision: (await settings.get(f.gymId)).revision, cancellationCutoffMinutes: 27 * 60 });
    expect(await f.service.promote(f.gymId, f.session.id)).toEqual([]);
    await settings.update(f.actor, 'booking', { revision: (await settings.get(f.gymId)).revision, cancellationCutoffMinutes: 0 });
    expect((await f.service.promote(f.gymId, f.session.id)).map(row => row.id)).toEqual([waiting.id]);
  });
  it('erasure after the cutoff frees the place without promoting the waitlist', async () => {
    const f = await fixture(); await f.book(); const waiting = await f.book(f.other.id);
    f.clock.set('2026-10-30T17:30:00Z');
    const erased = await createMembersService(f.options).eraseMember(f.actor, f.member.id, { revision: f.member.revision }, { jobs: new FakeJobs(f.clock), timezone: 'UTC' });
    expect(erased.freedSessionIds).toEqual([f.session.id]);
    expect(await promoteWaitlist(f.gymId, f.session.id, f.options)).toEqual([]);
    expect((await f.service.list(f.gymId, page)).data.find(row => row.id === waiting.id)).toMatchObject({ status: 'waitlisted' });
  });
  it('does not promote into a cancelled or started session', async () => {
    const f = await fixture(), first = await f.book(); await f.book(f.other.id); await f.service.cancel(f.actor, first.id);
    f.clock.set(f.session.startsAt); expect(await f.service.promote(f.gymId, f.session.id)).toEqual([]);
    f.clock.set('2026-10-29T16:00:00Z');
    await db.forGym(f.gymId, tx => tx.update(classSessions).set({ status: 'cancelled' }).where(eq(classSessions.id, f.session.id)));
    expect(await f.service.promote(f.gymId, f.session.id)).toEqual([]);
  });
  it.each(['cancel', 'capacity', 'erasure'] as const)('offers a place freed by %s after the cutoff to staff without moving the frozen queue', async cause => {
    const f = await fixture(), booked = await f.book(), waiting = await f.book(f.other.id);
    if (cause === 'cancel') {
      f.clock.set('2026-10-30T17:00:00Z');
      await f.service.cancel(f.actor, booked.id);
    }
    f.clock.set('2026-10-30T17:00:00.001Z');
    if (cause === 'capacity') await createScheduleService(f.options).changeSession(f.actor, f.session.id, 'capacity', { capacity: 2, revision: 1 });
    if (cause === 'erasure') await createMembersService(f.options).eraseMember(f.actor, f.member.id, { revision: f.member.revision }, { jobs: new FakeJobs(f.clock), timezone: 'UTC' });
    expect((await f.service.openPlaces(f.gymId, [f.session.id])).get(f.session.id)).toBe(1);
    const newcomer = await factory('members', f.gymId);
    expect(await f.book(newcomer.id, false)).toMatchObject({ status: 'booked' });
    expect((await f.service.openPlaces(f.gymId, [f.session.id])).get(f.session.id)).toBe(0);
    expect((await f.service.list(f.gymId, page)).data.find(row => row.id === waiting.id)).toMatchObject({ status: 'waitlisted' });
    const late = await factory('members', f.gymId);
    await expect(f.book(late.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['waitlistClosed'] } });
  });
  it('reserves only promotable places in counts and reconciles the queue before a direct booking', async () => {
    const f = await fixture(), booked = await f.book(), waiting = await f.book(f.other.id);
    await f.service.cancel(f.actor, booked.id);
    // Simulate an available capacity change before the recovery job gets its lock.
    await db.forGym(f.gymId, async tx => {
      await tx.select().from(classSessions).where(eq(classSessions.id, f.session.id)).for('update');
      await tx.update(classSessions).set({ capacity: 2 }).where(eq(classSessions.id, f.session.id));
    });
    expect((await f.service.openPlaces(f.gymId, [f.session.id])).get(f.session.id)).toBe(1);
    const newcomer = await factory('members', f.gymId);
    expect(await f.book(newcomer.id, false)).toMatchObject({ status: 'booked' });
    expect((await f.service.list(f.gymId, page)).data.find(row => row.id === waiting.id)).toMatchObject({ status: 'booked' });
    expect((await f.service.openPlaces(f.gymId, [f.session.id])).get(f.session.id)).toBe(0);
  });
  it('cancels active bookings with the session and refuses every repeated cancel without more audits', async () => {
    const f = await fixture(), booked = await f.book(), waiting = await f.book(f.other.id);
    const other = await fixture(); await other.book();
    const schedule = createScheduleService(f.options);
    expect(await schedule.changeSession(f.actor, f.session.id, 'cancel', { revision: 1 })).toMatchObject({ revision: 2, status: 'cancelled' });
    const rows = (await f.service.list(f.gymId, page)).data;
    for (const id of [booked.id, waiting.id]) expect(rows.find(row => row.id === id)).toMatchObject({ status: 'cancelled', waitlistPosition: null, cancelledAt: f.clock.now().toISOString() });
    expect((await f.service.list(f.gymId, { ...page, status: 'booked' })).data).toEqual([]);
    expect((await f.service.list(f.gymId, { ...page, status: 'waitlisted' })).data).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'booking.cancelled')))).toBe(2);
    for (const notify of [false, true]) await expect(schedule.changeSession(f.actor, f.session.id, 'cancel', { revision: 2, notify }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: ['already_cancelled'] } });
    expect(await schedule.getSession(f.gymId, f.session.id)).toMatchObject({ revision: 2 });
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'schedule.session.cancel')))).toBe(1);
    expect((await other.service.list(other.gymId, page)).data[0]).toMatchObject({ status: 'booked' });
  });
});
