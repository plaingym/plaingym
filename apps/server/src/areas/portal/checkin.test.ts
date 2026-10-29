// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { portalContracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { checkinCodePattern } from '../members/checkin-code.js';
import { portalFixture, portalServices, post, type PortalFixture } from './schedule.testing.js';

const db = useTestDatabase(), factory = createFactories(db);
const clock = new TestClock('2026-10-29T16:00:00Z');
const services = portalServices(db, clock);
const path = (memberId: string) => `/api/portal/members/${memberId}/checkin-code`;
async function read(f: PortalFixture, principal: Principal, memberId: string) {
  const response = await services.app(f.gymId, principal).request(path(memberId));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return portalContracts.checkinCode.response.parse(await response.json()).data;
}
async function regenerate(f: PortalFixture, principal: Principal, memberId: string, revision: number) {
  const response = await post(services.app(f.gymId, principal), path(memberId), { revision });
  expect(response.status).toBe(200);
  return portalContracts.regenerateCheckin.response.parse(await response.json()).data;
}
const version = async (f: PortalFixture, memberId: string) => (await services.codes.read(f.gymId, memberId)).version;

describe('portal check-in codes', () => {
  it('a parent creates, shows and replaces a child code; replaced codes stop resolving', async () => {
    const f = await portalFixture(factory), payer = f.principal('payer');
    const initial = await read(f, payer, f.child.id);
    expect(initial).toMatchObject({ memberId: f.child.id, code: null });
    const first = await regenerate(f, payer, f.child.id, initial.revision);
    expect(first.code).toMatch(checkinCodePattern);
    expect(await read(f, payer, f.child.id)).toEqual(first);
    expect(await services.codes.resolve(f.gymId, first.code)).toBe(f.child.id);
    const second = await regenerate(f, payer, f.child.id, first.revision);
    expect(second.version).toBe(first.version + 1);
    expect(await services.codes.resolve(f.gymId, first.code)).toBeNull();
    expect(await services.codes.resolve(f.gymId, second.code)).toBe(f.child.id);
    // Another gym never resolves this gym's code.
    const foreign = await portalFixture(factory);
    expect(await services.codes.resolve(foreign.gymId, second.code)).toBeNull();
  });
  it('a staff-revoked code reads as no active code until the member regenerates it', async () => {
    const f = await portalFixture(factory), adult = f.principal('adult');
    const issued = await regenerate(f, adult, f.grown.id, (await read(f, adult, f.grown.id)).revision);
    const revoked = await services.codes.revoke({ gymId: f.gymId, actor: { kind: 'user', userId: f.staff.id } }, f.grown.id, { revision: issued.revision });
    expect(await read(f, adult, f.grown.id)).toMatchObject({ code: null, version: revoked.version });
    expect(await services.codes.resolve(f.gymId, issued.code)).toBeNull();
    const renewed = await regenerate(f, adult, f.grown.id, revoked.revision);
    expect(await services.codes.resolve(f.gymId, renewed.code)).toBe(f.grown.id);
  });
  it('rejects a stale revision without changing the code', async () => {
    const f = await portalFixture(factory), payer = f.principal('payer');
    const current = await read(f, payer, f.parent.id);
    await regenerate(f, payer, f.parent.id, current.revision);
    const before = await version(f, f.parent.id);
    expect((await post(services.app(f.gymId, payer), path(f.parent.id), { revision: current.revision })).status).toBe(409);
    expect(await version(f, f.parent.id)).toBe(before);
  });
  it('an adult non-payer manages only their own code', async () => {
    const f = await portalFixture(factory), server = services.app(f.gymId, f.principal('adult'));
    await read(f, f.principal('adult'), f.grown.id);
    for (const memberId of [f.parent.id, f.child.id, f.cancelled.id]) {
      const before = await version(f, memberId);
      expect((await server.request(path(memberId))).status).toBe(404);
      expect((await post(server, path(memberId), { revision: 1 })).status).toBe(404);
      expect(await version(f, memberId)).toBe(before);
    }
  });
  it('keeps other households, other gyms and erased members out of both routes', async () => {
    const f = await portalFixture(factory), foreign = await portalFixture(factory), server = services.app(f.gymId, f.principal('payer'));
    for (const memberId of [f.other.id, foreign.child.id, f.erased.id, uuidv7()]) {
      expect((await server.request(path(memberId))).status).toBe(404);
      expect((await post(server, path(memberId), { revision: 1 })).status).toBe(404);
    }
    expect(await version(f, f.other.id)).toBe(1);
    expect(await version(foreign, foreign.child.id)).toBe(1);
    // The other gym's login is refused on this gym, even for its own member ID.
    const crossGym = services.app(f.gymId, foreign.principal('payer'));
    expect((await crossGym.request(path(foreign.parent.id))).status).toBe(404);
    expect((await post(crossGym, path(foreign.parent.id), { revision: 1 })).status).toBe(404);
  });
  it('denies anonymous, staff and kiosk principals and reports an unconfigured key as unavailable', async () => {
    const f = await portalFixture(factory);
    for (const principal of [{ kind: 'anonymous' }, { kind: 'staff', gymId: f.gymId, userId: f.staff.id, roles: ['owner'] },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }] as Principal[]) {
      const server = services.app(f.gymId, principal);
      expect([401, 403, 404]).toContain((await server.request(path(f.parent.id))).status);
      expect([401, 403, 404]).toContain((await post(server, path(f.parent.id), { revision: 1 })).status);
    }
    const unconfigured = portalServices(db, clock, { configured: false }).app(f.gymId, f.principal('payer'));
    expect((await unconfigured.request(path(f.parent.id))).status).toBe(503);
  });
});
