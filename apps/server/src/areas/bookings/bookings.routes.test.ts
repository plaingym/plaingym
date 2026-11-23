// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, classBookings, classCreditEntries, householdUsers, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the real registrations' app-role pools in the isolated composition test; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { bookingsContracts } from '@plaingym/shared/contracts';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { areaContributions } from '../../core/registry-areas.js';
import { FakeMemberHouseholdContext } from '../../core/interfaces/member-household.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { rememberPortalApp, portalTestHeaders } from '../portal/household.fixture.js';
import { createPortalAuthorization } from '../portal/auth.permissions.js';
import { createMembersService } from '../members/members.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createMembersRoutes } from '../members/members.routes.js';
import { createBookingService, promoteWaitlist } from './bookings.js';
import { configureBookingRoutes, createBookingRoutes } from './bookings.routes.js';
import { configureBookingJobs } from './bookings.jobs.js';
import { createBookingDelivery, noticeJob, promotionJob, type BookingDelivery } from './bookings.delivery.js';
import { cancelNoticeJob } from './bookings.cancel-notice.js';
import { FakeEmail } from '../../infra/email/index.js';
import { createPortalBookingService } from '../portal/bookings.js';
import { createPortalBookingRoutes } from '../portal/bookings.routes.js';
import { setLogSink } from '../../core/log.js';

const db = useTestDatabase(), factory = createFactories(db);
beforeAll(() => initializeDatabase(db.appUrl));
afterAll(closeDatabase);
const clock = new TestClock('2026-10-29T16:00:00Z');
const service = createBookingService({ scope: db.forGym, clock });
async function fixture(gym: { memberEmailsEnabled?: boolean } = {}) {
  const gymId = uuidv7(); await factory('gyms', gymId, { bookingWindowDays: 7, cancellationCutoffMinutes: 60, ...gym });
  const staff = await factory('authUser', gymId), payer = await factory('authUser', gymId), adult = await factory('authUser', gymId);
  const member = await factory('members', gymId), sibling = await factory('members', gymId, { householdId: member.householdId });
  const outsider = await factory('members', gymId);
  const session = await factory('classSessions', gymId, { capacity: 5, startsAt: new Date('2026-10-30T18:00:00Z'), endsAt: new Date('2026-10-30T19:00:00Z') });
  await factory('householdUsers', gymId, { householdId: member.householdId, userId: payer.id, memberId: member.id, scope: 'payer' });
  await factory('householdUsers', gymId, { householdId: member.householdId, userId: adult.id, memberId: sibling.id, scope: 'member' });
  const identity = { gymId, householdId: member.householdId, userId: payer.id };
  const actor = { gymId, actor: { kind: 'user' as const, userId: staff.id } };
  const fake = new FakeMemberHouseholdContext([member, sibling, outsider], [
    { ...identity, role: 'payer', memberId: member.id }, { ...identity, userId: adult.id, role: 'member', memberId: sibling.id },
  ]);
  return { gymId, staff, payer, adult, member, sibling, outsider, session, identity, actor, fake };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const staffPrincipal = (f: Fixture, role: StaffRole = 'owner'): Principal => ({ kind: 'staff', gymId: f.gymId, userId: f.staff.id, roles: [role] });
const memberPrincipal = (f: Fixture, adult = false): Principal => ({ kind: 'member', userId: adult ? f.adult.id : f.payer.id,
  scope: adult ? { gymId: f.gymId, householdId: f.member.householdId, memberId: f.sibling.id, role: 'member' }
    : { gymId: f.gymId, householdId: f.member.householdId, memberId: f.member.id, role: 'payer' } });
function app(f: Fixture, principal: Principal, fake = false, production = false, delivery?: BookingDelivery) {
  const households = fake ? f.fake : createMemberHouseholdContext(db.forGym);
  const portal = createPortalBookingService({ households, householdScope: db.forHousehold, bookings: service, delivery: () => delivery });
  return rememberPortalApp(createApp({ clock, skipSetup: true, origin: 'http://localhost',
    contributions: production ? areaContributions : { routes: [...createMembersRoutes(createMembersService({ scope: db.forGym, clock }), undefined, { clock, jobs: new FakeJobs(clock) }), ...createBookingRoutes(service, () => delivery), ...createPortalBookingRoutes(portal)] },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
    authorize: createPortalAuthorization(households),
  }), principal);
}
const post = (server: ReturnType<typeof app>, path: string, body?: unknown) => server.request(path, { method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost', ...portalTestHeaders(server) }, body: JSON.stringify(body ?? {}) });
const book = async (f: Fixture, memberId = f.member.id) => (await service.book(f.actor, { memberId, sessionId: f.session.id, allowWaitlist: true })).booking;

describe('portal class-credit eligibility', () => {
  it.each(['staff', 'portal'] as const)('allows a direct %s booking while every queued member lacks credits', async source => {
    const f = await fixture(), localClock = new TestClock(clock.now());
    const bookings = createBookingService({ scope: db.forGym, clock: localClock });
    const portal = createPortalBookingService({ households: createMemberHouseholdContext(db.forGym), householdScope: db.forHousehold, bookings });
    const confirmed = [];
    for (let n = 0; n < 5; n++) confirmed.push((await bookings.book(f.actor, { memberId: (await factory('members', f.gymId)).id, sessionId: f.session.id, allowWaitlist: false })).booking);
    const lot = await factory('classCreditEntries', f.gymId, { memberId: f.member.id, credits: 1 });
    expect(await portal.book(f.identity, { sessionId: f.session.id, allowWaitlist: true })).toMatchObject({ status: 'waitlisted' });
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, lotId: lot.id, credits: -1 });
    await bookings.cancel(f.actor, confirmed[0]!.id);
    expect((await bookings.openPlaces(f.gymId, [f.session.id])).get(f.session.id)).toBe(1);
    const input = { sessionId: f.session.id, allowWaitlist: false };
    const row = source === 'portal' ? await portal.book(f.identity, input, f.sibling.id)
      : (await bookings.book(f.actor, { ...input, memberId: f.sibling.id })).booking;
    expect(row.status).toBe('booked');
    expect((await bookings.openPlaces(f.gymId, [f.session.id])).get(f.session.id)).toBe(0);
    expect((await bookings.list(f.gymId, { limit: 50, offset: 0, status: 'waitlisted' })).data).toMatchObject([{ memberId: f.member.id }]);
  });
  it.each(['self', 'household'] as const)('refuses a new %s booking, then allows it after a grant without reserving credits', async target => {
    const f = await fixture(), server = app(f, memberPrincipal(f));
    const member = target === 'self' ? f.member : f.sibling;
    const path = target === 'self' ? '/api/portal/bookings' : `/api/portal/members/${member.id}/bookings`;
    await factory('classCreditEntries', f.gymId, { memberId: member.id, credits: 1, expiresAt: clock.now() });
    // Household credits do not cover another member.
    await factory('classCreditEntries', f.gymId, { memberId: target === 'self' ? f.sibling.id : f.member.id, credits: 10 });
    const before = await db.forGym(f.gymId, tx => tx.select().from(classCreditEntries));
    const denied = await post(server, path, { sessionId: f.session.id });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { code: 'conflict',
      message: 'You need an unexpired class credit or an active or trial membership to book or join the waitlist. Please contact the front desk.' } });
    expect(await db.forGym(f.gymId, tx => tx.select().from(classBookings))).toHaveLength(0);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).toHaveLength(0);
    expect(await db.forGym(f.gymId, tx => tx.select().from(classCreditEntries))).toEqual(before);
    const grant = await factory('classCreditEntries', f.gymId, { memberId: member.id, credits: 1 });
    const first = await post(server, path, { sessionId: f.session.id });
    expect(first.status).toBe(200);
    expect((await first.json()).data.status).toBe('booked');
    const other = await factory('classSessions', f.gymId, { capacity: 1, startsAt: f.session.startsAt, endsAt: f.session.endsAt });
    expect((await post(server, path, { sessionId: other.id })).status).toBe(200);
    expect(await db.forGym(f.gymId, tx => tx.select().from(classCreditEntries))).toHaveLength(before.length + 1);
    // Replaying a successful booking still works after the member's balance runs out.
    await factory('classCreditEntries', f.gymId, { memberId: member.id, lotId: grant.id, credits: -1 });
    expect((await post(server, path, { sessionId: f.session.id })).status).toBe(200);
  });

  it('applies the same check before a waitlist insert', async () => {
    const f = await fixture(), server = app(f, memberPrincipal(f));
    for (let n = 0; n < 5; n++) await book(f, (await factory('members', f.gymId)).id);
    const lot = await factory('classCreditEntries', f.gymId, { memberId: f.member.id, credits: 1 });
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, lotId: lot.id, credits: -1 });
    const input = { sessionId: f.session.id, allowWaitlist: true };
    expect((await post(server, '/api/portal/bookings', input)).status).toBe(409);
    expect(await db.forGym(f.gymId, tx => tx.select().from(classBookings))).toHaveLength(5);
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, credits: 1 });
    const response = await post(server, '/api/portal/bookings', input);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ status: 'waitlisted', queueRank: 1 });
  });

  it('skips a portal-waitlisted pack holder whose credit ran out when a place opens, keeping their place in the queue', async () => {
    const f = await fixture(), server = app(f, memberPrincipal(f));
    const booked = [];
    for (let n = 0; n < 5; n++) booked.push(await book(f, (await factory('members', f.gymId)).id));
    const lot = await factory('classCreditEntries', f.gymId, { memberId: f.member.id, credits: 1 });
    const queued = await post(server, '/api/portal/bookings', { sessionId: f.session.id, allowWaitlist: true });
    expect((await queued.json()).data).toMatchObject({ status: 'waitlisted', queueRank: 1 });
    // A staff-made waitlist entry for another member, behind the portal one.
    const next = await book(f, f.outsider.id);
    expect(next).toMatchObject({ status: 'waitlisted' });
    // The member's last credit is spent elsewhere before the place opens.
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, lotId: lot.id, credits: -1 });
    await service.cancel(f.actor, booked[0]!.id);
    // Cancellation queues the promotion; run it as its job does.
    await promoteWaitlist(f.gymId, f.session.id, { scope: db.forGym, clock });
    const rows = await db.forGym(f.gymId, tx => tx.select().from(classBookings));
    expect(rows.find(row => row.memberId === f.member.id)).toMatchObject({ status: 'waitlisted' });
    expect(rows.find(row => row.memberId === f.outsider.id)).toMatchObject({ status: 'booked', waitlistPosition: null });
  });

  it.each(['active', 'trial', 'frozen', 'cancelled', 'pending'] as const)('uses %s membership eligibility for a pack holder', async status => {
    const f = await fixture(), server = app(f, memberPrincipal(f));
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, expiresAt: clock.now() });
    await factory('memberships', f.gymId, { memberId: f.member.id, householdId: f.member.householdId, status });
    expect((await post(server, '/api/portal/bookings', { sessionId: f.session.id })).status).toBe(status === 'active' || status === 'trial' ? 200 : 409);
  });

  it('accepts an unexpired credit even when it expires before class starts', async () => {
    const f = await fixture(), server = app(f, memberPrincipal(f));
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, credits: 1, expiresAt: new Date(clock.now().getTime() + 1) });
    expect((await post(server, '/api/portal/bookings', { sessionId: f.session.id })).status).toBe(200);
  });

  it('keeps never-held members eligible in both portal booking paths without memberships', async () => {
    const f = await fixture(), server = app(f, memberPrincipal(f));
    expect((await post(server, '/api/portal/bookings', { sessionId: f.session.id })).status).toBe(200);
    expect((await post(server, `/api/portal/members/${f.sibling.id}/bookings`, { sessionId: f.session.id })).status).toBe(200);
    expect(await db.forGym(f.gymId, tx => tx.select().from(classCreditEntries))).toEqual([]);
  });

  it('leaves staff bookings and waitlisting unchecked for an expired pack', async () => {
    const f = await fixture(), server = app(f, staffPrincipal(f));
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, expiresAt: clock.now() });
    for (let n = 0; n < 5; n++) await book(f, (await factory('members', f.gymId)).id);
    const response = await post(server, '/api/bookings', { memberId: f.member.id, sessionId: f.session.id, allowWaitlist: true });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ status: 'waitlisted', bookedByKind: 'staff' });
  });

  it('checks household and gym access before returning any credit conflict', async () => {
    const f = await fixture(), foreign = await fixture(), server = app(f, memberPrincipal(f));
    for (const [gymId, member] of [[f.gymId, f.outsider], [foreign.gymId, foreign.member]] as const) {
      await factory('classCreditEntries', gymId, { memberId: member.id, expiresAt: clock.now() });
      expect((await post(server, `/api/portal/members/${member.id}/bookings`, { sessionId: f.session.id })).status).toBe(404);
    }
    await factory('classCreditEntries', f.gymId, { memberId: f.member.id, expiresAt: clock.now() });
    expect((await post(app(f, memberPrincipal(f, true)), `/api/portal/members/${f.member.id}/bookings`, { sessionId: f.session.id })).status).toBe(404);
    expect(await db.forGym(f.gymId, tx => tx.select().from(classBookings))).toHaveLength(0);
  });
});

describe('booking route permissions and production composition', () => {
  it.each(['staff', 'self', 'household'] as const)('returns the committed %s booking when notice enqueue fails and the sweep recovers it', async source => {
    const f = await fixture(), jobs = new FakeJobs(clock), email = new FakeEmail();
    const delivery = createBookingDelivery({ scope: db.forGym, clock, jobs, mailer: async () => email });
    const confirmed = [];
    for (let n = 0; n < 5; n++) confirmed.push(await book(f, (await factory('members', f.gymId)).id));
    const waiting = await book(f, f.outsider.id);
    await service.cancel(f.actor, confirmed[0]!.id);
    const enqueue = vi.spyOn(jobs, 'enqueue').mockRejectedValue(new Error('Unavailable'));
    const server = app(f, source === 'staff' ? staffPrincipal(f, 'front_desk') : memberPrincipal(f), false, false, delivery);
    const path = source === 'staff' ? '/api/bookings' : source === 'self' ? '/api/portal/bookings' : `/api/portal/members/${f.sibling.id}/bookings`;
    const input = { sessionId: f.session.id, allowWaitlist: true, ...(source === 'staff' ? { memberId: f.member.id } : {}) };
    const logs: string[] = [], previous = setLogSink(line => logs.push(line));
    try {
      const response = await post(server, path, input);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toMatchObject({ status: 'waitlisted', memberId: source === 'household' ? f.sibling.id : f.member.id });
      expect(enqueue).toHaveBeenCalledWith(noticeJob, { bookingId: waiting.id }, expect.objectContaining({ gymId: f.gymId }));
      expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
        event: 'bookings.notice_enqueue_failed', gymId: f.gymId, bookingId: waiting.id,
      }));
      expect((await service.list(f.gymId, { limit: 50, offset: 0 })).data).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: body.data.id, status: 'waitlisted' }), expect.objectContaining({ id: waiting.id, status: 'booked' }),
      ]));
      expect((await (await post(server, path, input)).json()).data.id).toBe(body.data.id);
    } finally { enqueue.mockRestore(); setLogSink(previous); }
    await delivery.sweep(f.gymId);
    expect(jobs.jobs).toMatchObject([{ name: noticeJob, payload: { bookingId: waiting.id } }]);
  });
  it.each(['staff', 'self', 'household'] as const)('returns the committed %s cancellation when promotion enqueue fails and the sweep recovers the waitlist', async source => {
    const f = await fixture(), jobs = new FakeJobs(clock), email = new FakeEmail();
    const delivery = createBookingDelivery({ scope: db.forGym, clock, jobs, mailer: async () => email });
    const session = await factory('classSessions', f.gymId, { capacity: 1,
      startsAt: new Date('2026-10-30T20:00:00Z'), endsAt: new Date('2026-10-30T21:00:00Z') });
    const memberId = source === 'household' ? f.sibling.id : f.member.id;
    const booked = (await service.book(f.actor, { memberId, sessionId: session.id, allowWaitlist: true })).booking;
    const waiting = (await service.book(f.actor, { memberId: f.outsider.id, sessionId: session.id, allowWaitlist: true })).booking;
    expect(booked.status).toBe('booked'); expect(waiting.status).toBe('waitlisted');
    const server = app(f, source === 'staff' ? staffPrincipal(f, 'front_desk') : memberPrincipal(f), false, false, delivery);
    const path = source === 'staff' ? `/api/bookings/${booked.id}/cancel`
      : source === 'self' ? `/api/portal/bookings/${booked.id}/cancel`
        : `/api/portal/members/${f.sibling.id}/bookings/${booked.id}/cancel`;
    const logs: string[] = [], previous = setLogSink(line => logs.push(line));
    const enqueue = vi.spyOn(jobs, 'enqueue').mockRejectedValue(new Error('Unavailable'));
    try {
      const response = await post(server, path);
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({ id: booked.id, status: 'cancelled' });
      expect(enqueue).toHaveBeenCalledWith(promotionJob, { sessionId: session.id }, expect.objectContaining({
        gymId: f.gymId, idempotencyKey: `booking-cancelled:${booked.id}` }));
      expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
        event: 'bookings.promotion_enqueue_failed', gymId: f.gymId, sessionId: session.id, cancellationId: booked.id }));
      expect((await service.list(f.gymId, { limit: 50, offset: 0 })).data.find(row => row.id === booked.id)?.status).toBe('cancelled');
    } finally { enqueue.mockRestore(); setLogSink(previous); }
    await delivery.sweep(f.gymId);
    expect(jobs.jobs).toMatchObject([{ name: noticeJob, payload: { bookingId: waiting.id } }]);
    expect((await service.list(f.gymId, { limit: 50, offset: 0 })).data.find(row => row.id === waiting.id)?.status).toBe('booked');
  });
  it.each(['staff', 'self', 'household'] as const)('enqueues inline promotions after the %s booking commits and audits the system actor', async source => {
    const f = await fixture(), jobs = new FakeJobs(clock), email = new FakeEmail();
    const delivery = createBookingDelivery({ scope: db.forGym, clock, jobs, mailer: async () => email });
    const confirmed = [];
    for (let n = 0; n < 5; n++) confirmed.push(await book(f, (await factory('members', f.gymId)).id));
    const waiting = await book(f, f.outsider.id);
    await service.cancel(f.actor, confirmed[0]!.id);
    const server = app(f, source === 'staff' ? staffPrincipal(f, 'front_desk') : memberPrincipal(f), false, false, delivery);
    const path = source === 'staff' ? '/api/bookings' : source === 'self' ? '/api/portal/bookings' : `/api/portal/members/${f.sibling.id}/bookings`;
    const input = { sessionId: f.session.id, allowWaitlist: true, ...(source === 'staff' ? { memberId: f.member.id } : {}) };
    const response = await post(server, path, input);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ status: 'waitlisted', memberId: source === 'household' ? f.sibling.id : f.member.id });
    expect(body.data).not.toHaveProperty('promoted'); expect(body).not.toHaveProperty('promoted');
    // FakeJobs asserts that enqueue runs outside a transaction; no sweep or promotion job has run.
    expect(jobs.jobs).toMatchObject([{ name: noticeJob, payload: { bookingId: waiting.id }, options: { gymId: f.gymId } }]);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, waiting.id)));
    expect(audits.find(row => row.action === 'booking.promoted')).toMatchObject({ actorKind: 'system', actorUserId: null });
    expect((await service.list(f.gymId, { limit: 50, offset: 0 })).data.find(row => row.id === waiting.id)?.status).toBe('booked');
    // Replaying the caller's booking adds no promotion work or duplicate notice.
    expect((await post(server, path, input)).status).toBe(200);
    expect(jobs.jobs).toHaveLength(1);
  });
  it('promotes the waiting member after erasure commits through the member route', async () => {
    const f = await fixture(), server = app(f, staffPrincipal(f));
    const erased = await book(f);
    for (let n = 0; n < 4; n++) await book(f, (await factory('members', f.gymId)).id);
    const waiting = await book(f, f.outsider.id);
    expect(waiting.status).toBe('waitlisted');
    const response = await post(server, `/api/members/${f.member.id}/anonymize`, { revision: f.member.revision });
    expect(response.status).toBe(200);
    const rows = (await service.list(f.gymId, { limit: 50, offset: 0 })).data;
    expect(rows.find(row => row.id === erased.id)?.status).toBe('cancelled');
    expect(rows.find(row => row.id === waiting.id)?.status).toBe('booked');
    expect(await service.promote(f.gymId, f.session.id)).toEqual([]);
  });
  it.each(staffRoles)('allows %s on all four staff booking endpoints', async role => {
    const f = await fixture(), server = app(f, staffPrincipal(f, role));
    const created = await post(server, '/api/bookings', { memberId: f.member.id, sessionId: f.session.id });
    expect(created.status).toBe(200);
    const row = bookingsContracts.create.response.parse(await created.json()).data;
    expect(row.bookedByKind).toBe('staff');
    expect((await server.request('/api/bookings')).status).toBe(200);
    const roster = await server.request(`/api/bookings/sessions/${f.session.id}/roster`);
    expect(roster.status).toBe(200);
    const parsed = bookingsContracts.roster.response.parse(await roster.json());
    expect(parsed.data).toHaveLength(1); expect(parsed.counts).toEqual({ booked: 1, waitlisted: 0, checkedIn: 0 });
    expect(parsed.data[0]?.displayName).toBe(`${f.member.firstName} ${f.member.lastName}`);
    expect(Object.keys(parsed.data[0]!).sort()).toEqual(['attendance', 'booking', 'displayName']);
    expect((await post(server, `/api/bookings/${row.id}/cancel`)).status).toBe(200);
  });
  it('denies anonymous, member, device and cross-gym staff principals on every staff endpoint', async () => {
    const f = await fixture(), booking = await book(f);
    const principals: Principal[] = [{ kind: 'anonymous' }, memberPrincipal(f), { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
      { kind: 'staff', gymId: uuidv7(), userId: f.staff.id, roles: ['owner'] }];
    for (const principal of principals) {
      const server = app(f, principal);
      for (const response of [await server.request('/api/bookings'), await server.request(`/api/bookings/sessions/${f.session.id}/roster`),
        await post(server, '/api/bookings', { memberId: f.member.id, sessionId: f.session.id }), await post(server, `/api/bookings/${booking.id}/cancel`)])
        expect([401, 403]).toContain(response.status);
    }
  });
  it('returns 404 for foreign resources on every staff endpoint', async () => {
    const f = await fixture(), foreign = await fixture(), booking = await book(foreign), server = app(f, staffPrincipal(f));
    for (const response of [await server.request(`/api/bookings?memberId=${foreign.member.id}`),
      await server.request(`/api/bookings?sessionId=${foreign.session.id}`), await server.request(`/api/bookings/sessions/${foreign.session.id}/roster`),
      await post(server, '/api/bookings', { memberId: foreign.member.id, sessionId: f.session.id }),
      await post(server, '/api/bookings', { memberId: f.member.id, sessionId: foreign.session.id }), await post(server, `/api/bookings/${booking.id}/cancel`)]) expect(response.status).toBe(404);
  });
  it.each([false, true])('serves self and household routes against the %s fake context with scoped projections', async fake => {
    const f = await fixture(), server = app(f, memberPrincipal(f), fake);
    const self = await post(server, '/api/portal/bookings', { sessionId: f.session.id });
    expect(self.status).toBe(200);
    const row = bookingsContracts.createSelf.response.parse(await self.json()).data;
    expect(row.memberId).toBe(f.member.id); expect(row).not.toHaveProperty('bookedBy');
    const path = `/api/portal/members/${f.sibling.id}/bookings`;
    const child = await post(server, path, { sessionId: f.session.id }); expect(child.status).toBe(200);
    const childBooking = bookingsContracts.createHouseholdMember.response.parse(await child.json()).data;
    const selfList = await server.request('/api/portal/bookings'), familyList = await server.request(path);
    expect(selfList.headers.get('Cache-Control')).toBe('no-store');
    expect(bookingsContracts.listSelf.response.parse(await selfList.json()).data.map(row => row.memberId)).toEqual([f.member.id]);
    expect(bookingsContracts.listHouseholdMember.response.parse(await familyList.json()).data.map(row => row.memberId)).toEqual([f.sibling.id]);
    expect((await post(server, `/api/portal/bookings/${childBooking.id}/cancel`)).status).toBe(404);
    expect((await post(server, `/api/portal/bookings/${row.id}/cancel`)).status).toBe(200);
    expect((await post(server, `${path}/${childBooking.id}/cancel`)).status).toBe(200);
  });
  it('an adult non-payer sees and changes only their own bookings', async () => {
    const f = await fixture(), server = app(f, memberPrincipal(f, true)), other = await book(f);
    expect((await post(server, '/api/portal/bookings', { sessionId: f.session.id })).status).toBe(200);
    const response = await server.request('/api/portal/bookings');
    const rows = bookingsContracts.listSelf.response.parse(await response.json()).data;
    expect(rows.map(row => row.memberId)).toEqual([f.sibling.id]);
    expect((await post(server, `/api/portal/bookings/${other.id}/cancel`)).status).toBe(404);
    for (const memberId of [f.member.id, f.sibling.id, f.outsider.id]) {
      const path = `/api/portal/members/${memberId}/bookings`;
      expect((await server.request(path)).status).toBe(404);
      expect((await post(server, path, { sessionId: f.session.id })).status).toBe(404);
      expect((await post(server, `${path}/${other.id}/cancel`)).status).toBe(404);
    }
    expect((await post(server, `/api/portal/bookings/${rows[0]!.id}/cancel`)).status).toBe(200);
  });
  it('all portal endpoints reject foreign gyms and households, including forged body member IDs', async () => {
    const f = await fixture(), foreign = await fixture(), server = app(f, memberPrincipal(f));
    const outsider = await book(f, f.outsider.id), otherGym = await book(foreign);
    for (const [memberId, bookingId] of [[f.outsider.id, outsider.id], [foreign.member.id, otherGym.id]]) {
      const path = `/api/portal/members/${memberId}/bookings`;
      expect((await server.request(path)).status).toBe(404);
      expect((await post(server, path, { sessionId: f.session.id })).status).toBe(404);
      expect((await post(server, `${path}/${bookingId}/cancel`)).status).toBe(404);
      expect((await post(server, `/api/portal/bookings/${bookingId}/cancel`)).status).toBe(404);
    }
    expect((await server.request(`/api/portal/bookings?sessionId=${foreign.session.id}`)).status).toBe(404);
    expect((await post(server, '/api/portal/bookings', { sessionId: foreign.session.id })).status).toBe(404);
    expect((await post(server, '/api/portal/bookings', { memberId: f.outsider.id, sessionId: f.session.id })).status).toBe(400);
    const forgedGym = app(f, memberPrincipal(foreign));
    for (const response of [await forgedGym.request('/api/portal/bookings'), await forgedGym.request(`/api/portal/members/${f.member.id}/bookings`),
      await post(forgedGym, '/api/portal/bookings', { sessionId: f.session.id }), await post(forgedGym, `/api/portal/members/${f.member.id}/bookings`, { sessionId: f.session.id }),
      await post(forgedGym, `/api/portal/bookings/${outsider.id}/cancel`), await post(forgedGym, `/api/portal/members/${f.member.id}/bookings/${outsider.id}/cancel`)]) expect(response.status).toBe(404);
  });
  it('staff, anonymous and device sessions cannot reach any portal endpoint', async () => {
    const f = await fixture(), row = await book(f);
    for (const principal of [staffPrincipal(f), { kind: 'anonymous' } as const, { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() } as const]) {
      const server = app(f, principal), path = `/api/portal/members/${f.member.id}/bookings`;
      for (const response of [await server.request('/api/portal/bookings'), await server.request(path), await post(server, '/api/portal/bookings', { sessionId: f.session.id }),
        await post(server, path, { sessionId: f.session.id }), await post(server, `/api/portal/bookings/${row.id}/cancel`), await post(server, `${path}/${row.id}/cancel`)]) expect(response.status).toBe(404);
    }
  });
  it('rechecks revoked logins at the write boundary even with a stale fake context', async () => {
    const f = await fixture(), server = app(f, memberPrincipal(f), true);
    await db.forGym(f.gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.userId, f.payer.id)));
    expect((await post(server, '/api/portal/bookings', { sessionId: f.session.id })).status).toBe(404);
    expect((await service.list(f.gymId, { limit: 50, offset: 0 })).data).toEqual([]);
  });
  it('mounts the real registrations through createApp and serves a book/list/cancel flow', async () => {
    const f = await fixture();
    // Production route factories use the injected app database and the current system clock.
    const future = new Date(); future.setUTCDate(future.getUTCDate() + 1);
    const session = await factory('classSessions', f.gymId, { startsAt: future, endsAt: new Date(future.getTime() + 3_600_000), capacity: 1 });
    const server = app(f, memberPrincipal(f), false, true);
    const response = await post(server, '/api/portal/bookings', { sessionId: session.id }); expect(response.status).toBe(200);
    const row = bookingsContracts.createSelf.response.parse(await response.json()).data;
    expect((await server.request('/api/portal/bookings')).status).toBe(200);
    expect((await post(server, `/api/portal/bookings/${row.id}/cancel`)).status).toBe(200);
  });
});

describe('staff cancellation notice choices', () => {
  function noticeApp(f: Fixture, principal: Principal = staffPrincipal(f, 'front_desk')) {
    const jobs = new FakeJobs(clock), delivery = createBookingDelivery({ scope: db.forGym, clock, jobs, mailer: async () => new FakeEmail() });
    return { jobs, server: app(f, principal, false, false, delivery), notices: () => jobs.jobs.filter(job => job.name === cancelNoticeJob) };
  }
  const status = async (f: Fixture, id: string) => (await service.list(f.gymId, { limit: 50, offset: 0 })).data.find(row => row.id === id)?.status;
  it.each([['no body', undefined], ['an empty body', {}], ['notify false', { notify: false }], ['a note alone', { note: 'Hi' }]] as const)(
    'cancels without a notice for %s', async (_label, body) => {
      const f = await fixture(), booking = await book(f), { server, notices } = noticeApp(f);
      const response = body === undefined
        ? await server.request(`/api/bookings/${booking.id}/cancel`, { method: 'POST', headers: { origin: 'http://localhost', ...portalTestHeaders(server) } })
        : await post(server, `/api/bookings/${booking.id}/cancel`, body);
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({ id: booking.id, status: 'cancelled' });
      expect(notices()).toHaveLength(0);
    });
  it.each([
    ['a JSON header', { 'content-type': 'application/json' }], ['a JSON header with a charset', { 'content-type': 'application/json; charset=utf-8' }], ['no header', {}],
    ['a text header', { 'content-type': 'text/plain;charset=UTF-8' }], ['a form header', { 'content-type': 'application/x-www-form-urlencoded' }],
  ] as const)('cancels without a notice for zero bytes with %s', async (_label, headers) => {
    const f = await fixture(), booking = await book(f), { server, notices } = noticeApp(f);
    // A byte array, unlike a string, adds no content type of its own.
    const response = await server.request(`/api/bookings/${booking.id}/cancel`, { method: 'POST',
      headers: { origin: 'http://localhost', ...portalTestHeaders(server), ...headers }, body: new Uint8Array(0) });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id: booking.id, status: 'cancelled' });
    expect(notices()).toHaveLength(0);
  });
  it.each([
    ['application/json', '{"notify":'], ['application/json', ' '], ['application/json', 'null'],
    ['application/json', '\uFEFF'], ['text/plain', '{}'],
  ])('refuses %s with body %j and leaves the booking unchanged', async (type, body) => {
    const f = await fixture(), booking = await book(f), { server, jobs } = noticeApp(f);
    const response = await server.request(`/api/bookings/${booking.id}/cancel`, { method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': type, ...portalTestHeaders(server) }, body });
    expect(response.status).toBe(400);
    expect(await status(f, booking.id)).toBe('booked'); expect(jobs.jobs).toHaveLength(0);
  });
  it.each([
    [{ notify: true }, ['email', 'sms'], ''], [{ notify: true, channels: ['email'], note: 'See you Monday' }, ['email'], 'See you Monday'],
    [{ notify: true, channels: ['sms'], note: 'Email only' }, ['sms'], ''], [{ notify: true, channels: ['sms', 'email'] }, ['sms', 'email'], ''],
  ] as const)('queues one notice for %j', async (body, channels, note) => {
    const f = await fixture(), booking = await book(f), { server, notices } = noticeApp(f);
    expect((await post(server, `/api/bookings/${booking.id}/cancel`, body)).status).toBe(200);
    expect(notices()).toMatchObject([{ payload: { bookingId: booking.id, channels, note },
      options: { gymId: f.gymId, idempotencyKey: `booking-cancel-notice:${booking.id}` } }]);
    // An already-cancelled booking returns its earlier result and queues nothing more.
    const again = await post(server, `/api/bookings/${booking.id}/cancel`, { notify: true });
    expect(again.status).toBe(200); expect((await again.json()).data).toMatchObject({ id: booking.id, status: 'cancelled' });
    expect(notices()).toHaveLength(1);
  });
  it.each([
    { notify: true, channels: [] }, { notify: true, channels: ['email', 'email'] }, { notify: true, channels: ['fax'] },
    { channels: ['email'] }, { notify: false, channels: ['sms'] }, { notify: true, note: 'x'.repeat(1_001) }, { notify: 'yes' }, { notify: true, memberId: uuidv7() },
  ])('refuses %j and leaves the booking unchanged', async body => {
    const f = await fixture(), booking = await book(f), { server, jobs } = noticeApp(f);
    expect((await post(server, `/api/bookings/${booking.id}/cancel`, body)).status).toBe(400);
    expect(await status(f, booking.id)).toBe('booked'); expect(jobs.jobs).toHaveLength(0);
  });
  it('returns 404 for another gym booking and queues nothing', async () => {
    const f = await fixture(), foreign = await fixture(), booking = await book(foreign), { server, jobs } = noticeApp(f, staffPrincipal(f));
    expect((await post(server, `/api/bookings/${booking.id}/cancel`, { notify: true, channels: ['email', 'sms'] })).status).toBe(404);
    expect(await status(foreign, booking.id)).toBe('booked'); expect(jobs.jobs).toHaveLength(0);
  });
  it('keeps portal callers off the staff route and queues no notice for self or household cancellations', async () => {
    const f = await fixture(), { server, notices } = noticeApp(f, memberPrincipal(f));
    const own = await book(f), child = await book(f, f.sibling.id), outsider = await book(f, f.outsider.id);
    expect([401, 403]).toContain((await post(server, `/api/bookings/${own.id}/cancel`, { notify: true })).status);
    expect(await status(f, own.id)).toBe('booked');
    expect((await post(server, `/api/portal/members/${f.outsider.id}/bookings/${outsider.id}/cancel`, { notify: true })).status).toBe(404);
    expect((await post(server, `/api/portal/bookings/${outsider.id}/cancel`, { notify: true })).status).toBe(404);
    expect(await status(f, outsider.id)).toBe('booked');
    expect((await post(server, `/api/portal/bookings/${own.id}/cancel`, { notify: true, channels: ['email'] })).status).toBe(200);
    expect((await post(server, `/api/portal/members/${f.sibling.id}/bookings/${child.id}/cancel`, { notify: true })).status).toBe(200);
    expect(await status(f, own.id)).toBe('cancelled'); expect(await status(f, child.id)).toBe('cancelled');
    expect(notices()).toHaveLength(0);
  });
  // Last in the file: it configures the production booking delivery, as the runtime does.
  it('sends a staff cancellation notice through the production route and job registrations', async () => {
    const f = await fixture({ memberEmailsEnabled: true }), member = await factory('members', f.gymId, { email: 'river@example.test' });
    // Production route factories use the injected app database and the current system clock.
    const future = new Date(); future.setUTCDate(future.getUTCDate() + 1);
    const session = await factory('classSessions', f.gymId, { name: 'Open mat', startsAt: future, endsAt: new Date(future.getTime() + 3_600_000), capacity: 5 });
    const jobs = new FakeJobs(clock), email = new FakeEmail(), delivery = createBookingDelivery({ jobs, mailer: async () => email });
    configureBookingRoutes(delivery); configureBookingJobs(delivery);
    const server = app(f, staffPrincipal(f), false, true);
    const booked = await post(server, '/api/bookings', { memberId: member.id, sessionId: session.id, allowWaitlist: true });
    expect(booked.status).toBe(200);
    const id = bookingsContracts.create.response.parse(await booked.json()).data.id;
    const cancelled = await post(server, `/api/bookings/${id}/cancel`, { notify: true, channels: ['email'], note: 'The mats are being replaced.' });
    expect(cancelled.status).toBe(200);
    const queued = jobs.jobs.filter(job => job.name === cancelNoticeJob);
    expect(queued).toMatchObject([{ payload: { bookingId: id, channels: ['email'], note: 'The mats are being replaced.' },
      options: { gymId: f.gymId, idempotencyKey: `booking-cancel-notice:${id}` } }]);
    const registration = areaContributions.jobs.find(job => job.id === cancelNoticeJob)!;
    await registration.handler(queued[0]!.payload, { gymId: f.gymId, jobId: 'test', timezone: 'UTC', attempt: 1, clock });
    expect(email.messages.map(message => message.to)).toEqual(['river@example.test']);
    for (const value of ['Open mat', 'The mats are being replaced.']) expect(email.messages[0]!.text).toContain(value);
  });
});
