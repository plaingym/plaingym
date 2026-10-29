// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { householdUsers, uuidv7 } from '@plaingym/db';
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
import { createPortalAuthorization } from '../portal/auth.permissions.js';
import { createMembersService } from '../members/members.js';
import { createMembersRoutes } from '../members/members.routes.js';
import { createBookingService } from './bookings.js';
import { createBookingRoutes } from './bookings.routes.js';
import { createPortalBookingService } from '../portal/bookings.js';
import { createPortalBookingRoutes } from '../portal/bookings.routes.js';

const db = useTestDatabase(), factory = createFactories(db);
beforeAll(() => initializeDatabase(db.appUrl));
afterAll(closeDatabase);
const clock = new TestClock('2026-10-29T16:00:00Z');
const service = createBookingService({ scope: db.forGym, clock });
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { bookingWindowDays: 7, cancellationCutoffMinutes: 60 });
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
function app(f: Fixture, principal: Principal, fake = false, production = false) {
  const households = fake ? f.fake : createMemberHouseholdContext(db.forGym);
  const portal = createPortalBookingService({ households, householdScope: db.forHousehold, bookings: service });
  return createApp({ clock, skipSetup: true, origin: 'http://localhost',
    contributions: production ? areaContributions : { routes: [...createMembersRoutes(createMembersService({ scope: db.forGym, clock }), undefined, { clock }), ...createBookingRoutes(service), ...createPortalBookingRoutes(portal)] },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
    authorize: createPortalAuthorization(households),
  });
}
const post = (server: ReturnType<typeof app>, path: string, body?: unknown) => server.request(path, { method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body ?? {}) });
const book = (f: Fixture, memberId = f.member.id) => service.book(f.actor, { memberId, sessionId: f.session.id, allowWaitlist: true });

describe('booking route permissions and production composition', () => {
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
    expect(roster.status).toBe(200); expect(bookingsContracts.roster.response.parse(await roster.json()).data).toHaveLength(1);
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
