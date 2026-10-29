// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { bookingsContracts, portalContracts, portalScheduleContracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { portalFixture, portalServices, post, type PortalFixture } from './schedule.testing.js';

const db = useTestDatabase(), factory = createFactories(db);
const clock = new TestClock('2026-10-29T16:00:00Z');
const services = portalServices(db, clock);
const range = '?from=2026-10-30T00:00:00Z&to=2026-10-31T00:00:00Z';
async function schedule(f: PortalFixture, principal: Principal) {
  const response = await services.app(f.gymId, principal).request('/api/portal/schedule' + range);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return portalContracts.schedule.response.parse(await response.json());
}
async function members(f: PortalFixture, principal: Principal) {
  const response = await services.app(f.gymId, principal).request('/api/portal/schedule/members');
  expect(response.status).toBe(200);
  return portalScheduleContracts.members.response.parse(await response.json()).data;
}
const staffBook = (f: PortalFixture, memberId: string, sessionId = f.session.id) =>
  services.bookings.book({ gymId: f.gymId, actor: { kind: 'user', userId: f.staff.id } }, { memberId, sessionId, allowWaitlist: true });

describe('portal schedule', () => {
  it('a parent books for a child and sees the engine times, open places and the household places only', async () => {
    clock.set('2026-10-29T16:00:00Z');
    const f = await portalFixture(factory), server = services.app(f.gymId, f.principal('payer'));
    const booked = await post(server, `/api/portal/members/${f.child.id}/bookings`, { sessionId: f.session.id });
    expect(booked.status).toBe(200);
    await staffBook(f, f.other.id);
    const page = await schedule(f, f.principal('payer'));
    expect(page.data.map(row => row.name)).toEqual(['Fundamentals', 'Open training']);
    const [session, open] = page.data;
    expect(session).toMatchObject({ bookingOpensAt: '2026-10-23T00:00:00.000Z', cancelBefore: '2026-10-30T17:00:00.000Z', placesLeft: 0, capacity: 2 });
    expect(session!.bookings.map(row => [row.memberId, row.status])).toEqual([[f.child.id, 'booked']]);
    expect(session).not.toHaveProperty('notes');
    expect(JSON.stringify(page)).not.toContain(f.other.id);
    expect(open).toMatchObject({ capacity: null, placesLeft: null, bookings: [] });
    // A full class waitlists the next household member, and the queue rank is shown without other identities.
    const waiting = await post(server, '/api/portal/bookings', { sessionId: f.session.id });
    expect(bookingsContracts.createSelf.response.parse(await waiting.json()).data).toMatchObject({ status: 'waitlisted', queueRank: 1 });
    const after = (await schedule(f, f.principal('payer'))).data[0]!;
    expect(after.bookings.map(row => [row.memberId, row.status, row.queueRank])).toEqual([[f.child.id, 'booked', null], [f.parent.id, 'waitlisted', 1]]);
  });
  it('cancelBefore is the last instant the engine accepts a cancellation', async () => {
    clock.set('2026-10-29T16:00:00Z');
    const f = await portalFixture(factory), server = services.app(f.gymId, f.principal('payer'));
    const first = bookingsContracts.createSelf.response.parse(await (await post(server, '/api/portal/bookings', { sessionId: f.session.id })).json()).data;
    const second = await staffBook(f, f.child.id);
    const { cancelBefore } = (await schedule(f, f.principal('payer'))).data[0]!;
    clock.set(new Date(Date.parse(cancelBefore) + 1));
    expect((await post(server, `/api/portal/members/${f.child.id}/bookings/${second.id}/cancel`)).status).toBe(409);
    clock.set(cancelBefore);
    expect((await post(server, `/api/portal/bookings/${first.id}/cancel`)).status).toBe(200);
    expect((await schedule(f, f.principal('payer'))).data[0]!.bookings.map(row => row.memberId)).toEqual([f.child.id]);
    clock.set('2026-10-29T16:00:00Z');
  });
  it('an adult non-payer sees only their own places and can book only for themself', async () => {
    clock.set('2026-10-29T16:00:00Z');
    const f = await portalFixture(factory), server = services.app(f.gymId, f.principal('adult'));
    await staffBook(f, f.child.id);
    expect((await post(server, `/api/portal/members/${f.child.id}/bookings`, { sessionId: f.session.id })).status).toBe(404);
    expect((await post(server, '/api/portal/bookings', { sessionId: f.session.id })).status).toBe(200);
    const session = (await schedule(f, f.principal('adult'))).data[0]!;
    expect(session.bookings.map(row => row.memberId)).toEqual([f.grown.id]);
    expect(session.placesLeft).toBe(0);
    expect(await members(f, f.principal('adult'))).toEqual([{ id: f.grown.id, name: 'Alex Parent' }]);
  });
  it('lists the payer first, then the household, without cancelled, erased or other households', async () => {
    const f = await portalFixture(factory);
    expect(await members(f, f.principal('payer'))).toEqual([
      { id: f.parent.id, name: 'Pat Parent' }, { id: f.grown.id, name: 'Alex Parent' }, { id: f.child.id, name: 'Casey Parent' }]);
    expect(await members(f, f.principal('neighbour'))).toEqual([{ id: f.other.id, name: 'Olive Other' }]);
  });
  it('keeps other households and gyms out of every schedule route', async () => {
    clock.set('2026-10-29T16:00:00Z');
    const f = await portalFixture(factory), foreign = await portalFixture(factory);
    await staffBook(f, f.child.id); await staffBook(foreign, foreign.child.id);
    const neighbour = (await schedule(f, f.principal('neighbour'))).data[0]!;
    expect(neighbour.bookings).toEqual([]);
    expect(neighbour.placesLeft).toBe(1);
    const own = await schedule(f, f.principal('payer'));
    expect(own.data.map(row => row.id)).toEqual([f.session.id, f.open.id]);
    // A login from another gym gets not-found on this gym's routes, and its sessions never appear here.
    for (const path of ['/api/portal/schedule' + range, '/api/portal/schedule/members'])
      expect((await services.app(f.gymId, foreign.principal('payer')).request(path)).status).toBe(404);
    expect(JSON.stringify(own)).not.toContain(foreign.session.id);
    // A revoked login loses access on the next request; the role is reloaded, never taken from the session.
    const revoked: Principal = { kind: 'member', userId: uuidv7(), scope: { gymId: f.gymId, householdId: f.householdId, role: 'payer' } };
    for (const path of ['/api/portal/schedule' + range, '/api/portal/schedule/members'])
      expect((await services.app(f.gymId, revoked).request(path)).status).toBe(404);
  });
  it('denies anonymous, staff and kiosk principals', async () => {
    const f = await portalFixture(factory);
    for (const principal of [{ kind: 'anonymous' }, { kind: 'staff', gymId: f.gymId, userId: f.staff.id, roles: ['owner'] },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }] as Principal[])
      for (const path of ['/api/portal/schedule' + range, '/api/portal/schedule/members'])
        expect([401, 403, 404]).toContain((await services.app(f.gymId, principal).request(path)).status);
  });
  it('validates the range and pages the gym schedule', async () => {
    const f = await portalFixture(factory), server = services.app(f.gymId, f.principal('payer'));
    expect((await server.request('/api/portal/schedule?from=2026-10-31T00:00:00Z&to=2026-10-30T00:00:00Z')).status).toBe(400);
    const page = portalContracts.schedule.response.parse(await (await server.request('/api/portal/schedule' + range + '&limit=1&offset=1')).json());
    expect(page.pagination).toEqual({ limit: 1, offset: 1, total: 2 });
    expect(page.data.map(row => row.id)).toEqual([f.open.id]);
  });
});
