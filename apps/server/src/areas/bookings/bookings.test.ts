// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, classBookings, classSessions, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createBookingService, promoteWaitlist } from './bookings.js';
import { createScheduleService } from '../schedule/schedule.js';
import { createMembersService } from '../members/members.js';
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
  const book = (memberId = member.id, allowWaitlist = true) => service.book(actor, { sessionId: session.id, memberId, allowWaitlist });
  return { gymId, clock, user, member, other, session, actor, options, service, book };
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
    await expect(f.book(f.other.id, false)).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.service.list(f.gymId, page)).data).toHaveLength(1);
  });
  it('keeps allocation gaps, ranks the live queue, and never lets a newcomer jump the waitlist', async () => {
    const f = await fixture(); const first = await f.book(), one = await f.book(f.other.id);
    const m2 = await factory('members', f.gymId), m3 = await factory('members', f.gymId), m4 = await factory('members', f.gymId);
    const two = await f.book(m2.id), three = await f.book(m3.id);
    await f.service.cancel(f.actor, two.id); await f.service.cancel(f.actor, first.id);
    const four = await f.book(m4.id);
    expect(four).toMatchObject({ status: 'waitlisted', waitlistPosition: 4, queueRank: 3 });
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
    expect(roster.data.find(row => row.booking?.id === booked.id)?.attendance?.memberId).toBe(f.member.id);
    expect(roster.data.find(row => row.booking === null)?.attendance?.memberId).toBe(f.other.id);
    expect(await f.service.roster(f.gymId, f.session.id, { limit: 1, offset: 1 })).toMatchObject({ pagination: { total: 2 } });
  });
  it('exports promotion for each session freed by erasure and does not book an erased member again', async () => {
    const f = await fixture(), booked = await f.book(), waiting = await f.book(f.other.id);
    const memberService = createMembersService(f.options);
    const erased = await memberService.eraseMember(f.actor, f.member.id, { revision: f.member.revision });
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
    const erased = await createMembersService(f.options).eraseMember(f.actor, f.member.id, { revision: f.member.revision });
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
});
