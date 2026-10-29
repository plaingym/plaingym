// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, householdUsers, memberships } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the default app-role pools for the production registrations; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { portalContracts as contracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createMembersService } from '../members/members.js';
import { createPortalHouseholdService } from './household.js';
import { createPortalHouseholdProfileRoutes } from './household.routes.js';
import { adultPrincipal, otherPayerPrincipal, outsidePrincipals, payerPrincipal, portalApp, portalFixture, send, type PortalFixture } from './household.fixture.js';
import type { Principal } from '../../core/context.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-29T16:00:00Z');
beforeAll(() => initializeDatabase(db.appUrl));
afterAll(closeDatabase);
function app(f: PortalFixture, principal: Principal, production = false) {
  const service = createPortalHouseholdService({ households: createMemberHouseholdContext(db.forGym), householdScope: db.forHousehold,
    members: createMembersService({ scope: db.forGym, clock }), clock });
  return portalApp(db, f, principal, production ? areaContributions.routes ?? [] : createPortalHouseholdProfileRoutes(service), clock);
}
const json = async <T>(response: Response, schema: { parse(value: unknown): T }) => { expect(response.status).toBe(200); return schema.parse(await response.json()); };
/** Every household route for a member ID, with a valid body, so a denial cannot be a validation error. */
function memberRoutes(memberId: string, revision = 1) {
  return [['GET', `/api/portal/members/${memberId}`], ['GET', `/api/portal/members/${memberId}/memberships`],
    ['PATCH', `/api/portal/members/${memberId}`, { firstName: 'Changed', revision }]] as const;
}

describe('portal household routes', () => {
  it('lets the payer read the household, its current members, profiles and read-only memberships', async () => {
    const f = await portalFixture(factory), server = app(f, payerPrincipal(f));
    await factory('memberships', f.gymId, { householdId: f.household.id, memberId: f.child.id, status: 'active' });
    const household = await json(await server.request('/api/portal/household'), contracts.household.response);
    expect(household.data).toMatchObject({ id: f.household.id, name: 'Rivera household', billingDay: f.household.billingDay });
    const members = await json(await server.request('/api/portal/members'), contracts.members.response);
    expect(members.data.map(row => row.id).sort()).toEqual([f.payer.id, f.child.id, f.adult.id].sort());
    expect(members.data[0]).not.toHaveProperty('medicalNotes');
    const child = await json(await server.request(`/api/portal/members/${f.child.id}`), contracts.profile.response);
    expect(child.data.emergencyContacts).toEqual([{ name: 'Grandparent', relationship: null, phone: '555-0100' }]);
    const listed = await json(await server.request(`/api/portal/members/${f.child.id}/memberships`), contracts.memberships.response);
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ memberId: f.child.id, status: 'active' });
    expect((await server.request('/api/portal/members?limit=1&offset=1')).status).toBe(200);
  });
  it('lets the payer edit household contacts and children, but never memberships, status, billing or other adults', async () => {
    const f = await portalFixture(factory), server = app(f, payerPrincipal(f));
    const saved = await json(await send(server, 'PATCH', '/api/portal/household', { phone: '555-0199', address: { line1: '1 Main St' }, revision: f.household.revision }), contracts.updateHousehold.response);
    expect(saved.data).toMatchObject({ phone: '555-0199', address: { line1: '1 Main St' }, revision: f.household.revision + 1 });
    expect((await send(server, 'PATCH', '/api/portal/household', { phone: '555-0000', revision: f.household.revision })).status).toBe(409);
    expect((await send(server, 'PATCH', '/api/portal/household', { billingDay: 3, revision: saved.data.revision })).status).toBe(400);
    const child = await json(await send(server, 'PATCH', `/api/portal/members/${f.child.id}`, { firstName: 'Kimberly',
      emergencyContacts: [{ name: 'Grandparent', relationship: null, phone: '555-0101' }, { name: 'Aunt', relationship: 'Aunt', phone: '555-0102', email: 'aunt@example.test' }],
      revision: f.child.revision }), contracts.updateMember.response);
    expect(child.data).toMatchObject({ firstName: 'Kimberly', revision: f.child.revision + 1 });
    expect(child.data.emergencyContacts[1]).toEqual({ name: 'Aunt', relationship: 'Aunt', phone: '555-0102', email: 'aunt@example.test' });
    // A missing relationship round-trips as missing.
    const stored = await createMembersService({ scope: db.forGym, clock }).getMember(f.gymId, f.child.id);
    expect(stored.emergencyContacts[0]).toEqual({ name: 'Grandparent', relationship: null, phone: '555-0101', email: null });
    expect((await send(server, 'PATCH', `/api/portal/members/${f.payer.id}`, { phone: '555-0103', revision: f.payer.revision })).status).toBe(200);
    expect((await send(server, 'PATCH', `/api/portal/members/${f.adult.id}`, { phone: '555-0104', revision: f.adult.revision })).status).toBe(403);
    for (const forbidden of [{ status: 'cancelled' }, { emailOptOut: true }, { medicalNotes: 'x' }, { householdId: f.otherHousehold.id }])
      expect((await send(server, 'PATCH', `/api/portal/members/${f.child.id}`, { ...forbidden, revision: child.data.revision })).status).toBe(400);
    expect((await send(server, 'PATCH', `/api/portal/members/${f.child.id}`, { photoKey: `${f.gymId}/photo.png`, revision: child.data.revision })).status).toBe(400);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'member.updated'), eq(auditEvents.targetId, f.child.id))));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: 'user', actorUserId: f.payerUser.id });
  });
  it('refuses the payer for an adult whose birth date was never recorded', async () => {
    const f = await portalFixture(factory), server = app(f, payerPrincipal(f));
    const unknown = await factory('members', f.gymId, { householdId: f.household.id, firstName: 'Imported', lastName: 'Adult', dateOfBirth: null });
    for (const body of [{ email: 'payer-controlled@example.test' }, { dateOfBirth: '2015-01-01' }, { emergencyContacts: [] }, { phone: '1' }])
      expect((await send(server, 'PATCH', `/api/portal/members/${unknown.id}`, { ...body, revision: unknown.revision })).status).toBe(403);
    const after = await createMembersService({ scope: db.forGym, clock }).getMember(f.gymId, unknown.id);
    expect(after).toMatchObject({ email: null, dateOfBirth: null, revision: unknown.revision });
    // Still readable as a household member; only acting for them is refused.
    expect((await server.request(`/api/portal/members/${unknown.id}`)).status).toBe(200);
  });
  it('has no route that changes a membership', async () => {
    const f = await portalFixture(factory), server = app(f, payerPrincipal(f));
    const row = await factory('memberships', f.gymId, { householdId: f.household.id, memberId: f.child.id, status: 'active' });
    const path = `/api/portal/members/${f.child.id}/memberships`;
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) expect([404, 405]).toContain((await send(server, method, path, { status: 'cancelled' })).status);
    expect((await send(server, 'PATCH', `${path}/${row.id}`, { status: 'cancelled' })).status).toBe(404);
    const [after] = await db.forGym(f.gymId, tx => tx.select().from(memberships).where(eq(memberships.id, row.id)));
    expect(after).toMatchObject({ status: 'active', revision: row.revision });
  });
  it('shows an adult non-payer only their own profile and memberships', async () => {
    const f = await portalFixture(factory), server = app(f, adultPrincipal(f));
    await factory('memberships', f.gymId, { householdId: f.household.id, memberId: f.adult.id });
    await factory('memberships', f.gymId, { householdId: f.household.id, memberId: f.child.id });
    expect((await json(await server.request(`/api/portal/members/${f.adult.id}`), contracts.profile.response)).data.id).toBe(f.adult.id);
    expect((await json(await server.request(`/api/portal/members/${f.adult.id}/memberships`), contracts.memberships.response)).data.map(row => row.memberId)).toEqual([f.adult.id]);
    for (const [method, path, body] of [...memberRoutes(f.payer.id), ...memberRoutes(f.child.id),
      ['GET', '/api/portal/members'], ['GET', '/api/portal/household'], ['PATCH', '/api/portal/household', { phone: '1', revision: 1 }],
      ['PATCH', `/api/portal/members/${f.adult.id}`, { phone: '1', revision: f.adult.revision }]] as const)
      expect((await send(server, method, path, body)).status, `${method} ${path}`).toBe(404);
  });
  it('returns 404 for other households, other gyms and non-member sessions on every route', async () => {
    const f = await portalFixture(factory), foreign = await portalFixture(factory);
    const all = (memberId: string) => [...memberRoutes(memberId), ['GET', '/api/portal/members'], ['GET', '/api/portal/household'],
      ['PATCH', '/api/portal/household', { phone: '1', revision: 1 }]] as const;
    const payer = app(f, payerPrincipal(f));
    for (const memberId of [f.outsider.id, foreign.child.id])
      for (const [method, path, body] of memberRoutes(memberId)) expect((await send(payer, method, path, body)).status, `${method} ${path}`).toBe(404);
    // The other household's payer sees only its own household.
    const other = app(f, otherPayerPrincipal(f));
    expect((await json(await other.request('/api/portal/members'), contracts.members.response)).data.map(row => row.id)).toEqual([f.outsider.id]);
    for (const [method, path, body] of memberRoutes(f.child.id)) expect((await send(other, method, path, body)).status).toBe(404);
    // A principal from another gym never resolves here, even for its own IDs.
    for (const principal of [payerPrincipal(foreign), ...outsidePrincipals(f)]) {
      const server = app(f, principal);
      for (const [method, path, body] of all(f.child.id)) expect([404], `${method} ${path}`).toContain((await send(server, method, path, body)).status);
    }
    const before = await createMembersService({ scope: db.forGym, clock }).getMember(f.gymId, f.child.id);
    expect(before).toMatchObject({ firstName: 'Kim', revision: f.child.revision });
  });
  it('rechecks a revoked payer login on every request', async () => {
    const f = await portalFixture(factory), server = app(f, payerPrincipal(f));
    await db.forGym(f.gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.userId, f.payerUser.id)));
    expect((await server.request('/api/portal/household')).status).toBe(404);
    expect((await send(server, 'PATCH', `/api/portal/members/${f.child.id}`, { firstName: 'X', revision: f.child.revision })).status).toBe(404);
  });
  it('serves the production registrations', async () => {
    const f = await portalFixture(factory), server = app(f, payerPrincipal(f), true);
    expect((await server.request('/api/portal/household')).status).toBe(200);
    expect((await send(server, 'PATCH', `/api/portal/members/${f.child.id}`, { lastName: 'Rivera-Lee', revision: f.child.revision })).status).toBe(200);
  });
});
