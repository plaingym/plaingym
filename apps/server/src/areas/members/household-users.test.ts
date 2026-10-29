// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { householdUsers, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { FakeMemberHouseholdContext } from '../../core/interfaces/member-household.js';
import { createMemberHouseholdContext, createPortalPrincipalLoader } from './household-users.context.js';
import { createHouseholdUsersService } from './household-users.js';
import { createPortalAccessRoutes } from '../portal/access.routes.js';
import { createPortalAuthRoutes } from '../portal/auth.routes.js';
import { createPortalAuthorization } from '../portal/auth.permissions.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler, respondError } from '../../core/errors.js';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { householdContextContract } from './household-users.contract.js';
import { createPortalInvitationStore } from '../../infra/auth/portal-invitations.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-28T12:00:00Z');
const gym = uuidv7(), otherGym = uuidv7(), context = createMemberHouseholdContext(db.forGym), service = createHouseholdUsersService({ scope: db.forGym, clock, loginEmails: createPortalInvitationStore(() => db.system.db).loginEmails });
let staffUser: string;
beforeAll(async () => { await factory('gyms', gym); await factory('gyms', otherGym); staffUser = (await factory('authUser', gym)).id; });
async function fixture() {
  const household = await factory('households', gym), otherHousehold = await factory('households', gym);
  const member = await factory('members', gym, { householdId: household.id }), sibling = await factory('members', gym, { householdId: household.id }), foreign = await factory('members', gym, { householdId: otherHousehold.id });
  const payer = await factory('householdUsers', gym, { householdId: household.id, scope: 'payer', memberId: null });
  const adult = await factory('householdUsers', gym, { householdId: household.id, scope: 'member', memberId: member.id });
  return { household, otherHousehold, member, sibling, foreign, payer, adult };
}
householdContextContract('database household context', async () => {
  const f = await fixture();
  const erased = await factory('members', gym, { householdId: f.household.id, anonymizedAt: clock.now() });
  const erasedAdult = await factory('householdUsers', gym, { householdId: f.household.id, scope: 'member', memberId: erased.id });
  return { context, payer: f.payer, adult: f.adult, erased: erased.id, erasedAdult, member: f.member.id, sibling: f.sibling.id, foreign: f.foreign.id, otherGym, otherHousehold: f.otherHousehold.id,
    revoke: async () => { await db.forGym(gym, tx => tx.delete(householdUsers).where(eq(householdUsers.id, f.payer.id))); } };
});
householdContextContract('fake household context', async () => {
  const householdId = uuidv7(), otherHousehold = uuidv7(), member = uuidv7(), sibling = uuidv7(), foreign = uuidv7(), erased = uuidv7();
  const payer = { gymId: gym, householdId, userId: uuidv7(), role: 'payer' as const, memberId: null }, adult = { ...payer, userId: uuidv7(), role: 'member' as const, memberId: member };
  const erasedAdult = { ...adult, userId: uuidv7(), memberId: erased };
  const fake = new FakeMemberHouseholdContext([{ gymId: gym, householdId, id: member }, { gymId: gym, householdId, id: sibling }, { gymId: gym, householdId: otherHousehold, id: foreign }, { gymId: gym, householdId, id: erased, anonymizedAt: clock.now() }], [payer, adult, erasedAdult]);
  return { context: fake, payer, adult, erased, erasedAdult, member, sibling, foreign, otherGym, otherHousehold, revoke: async () => fake.revoke(payer) };
});
function app(principal: Principal, gymId = gym) {
  const app = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, ctx) => { if (!result.success) return respondError(ctx, result.error); } });
  app.use('*', async (ctx, next) => { ctx.set('context', { principal, gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'household-test' }); await next(); });
  app.onError(errorHandler); createServerRegistry({ routes: [...createPortalAccessRoutes(service), ...createPortalAuthRoutes(context)] }).mount(app, createPortalAuthorization(context), new Set()); return app;
}
const staff = (role: StaffRole, gymId = gym): Principal => ({ kind: 'staff', userId: staffUser, gymId, roles: [role] });
const send = (server: ReturnType<typeof app>, path: string, method = 'GET', body?: unknown) => server.request(path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
describe('household login routes', () => {
  it('requires an adult birth date before granting a member-only login', async () => {
    const home = await factory('households', gym), actor = { gymId: gym, actor: { kind: 'system' as const } };
    for (const dateOfBirth of [null, '2015-01-01']) {
      const person = await factory('members', gym, { householdId: home.id, dateOfBirth }), user = await factory('authUser', gym);
      await expect(service.create(actor, home.id, { userId: user.id, scope: 'member', memberId: person.id })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    const adult = await factory('members', gym, { householdId: home.id, dateOfBirth: '1990-01-01' }), user = await factory('authUser', gym);
    await expect(service.create(actor, home.id, { userId: user.id, scope: 'member', memberId: adult.id })).resolves.toMatchObject({ scope: 'member' });
  });
  it.each(staffRoles)('allows and denies every management route for %s', async role => {
    const f = await fixture(), user = await factory('authUser', gym), server = app(staff(role)), base = `/api/households/${f.household.id}/users`, allowed = role !== 'coach';
    expect((await send(server, base)).status).toBe(allowed ? 200 : 403);
    expect((await send(server, `/api/households/${f.household.id}/portal-logins`)).status).toBe(allowed ? 200 : 403);
    expect((await send(server, base, 'POST', { userId: user.id, scope: 'payer' })).status).toBe(allowed ? 200 : 403);
    expect((await send(server, base + '/' + f.adult.id, 'DELETE')).status).toBe(allowed ? 200 : 403);
  });
  it('rejects cross-gym household and cross-household member/link IDs on all management routes', async () => {
    const f = await fixture(), server = app(staff('owner', otherGym), otherGym), base = `/api/households/${f.household.id}/users`;
    expect((await send(server, base)).status).toBe(404);
    expect((await send(server, `/api/households/${f.household.id}/portal-logins`)).status).toBe(404);
    expect((await send(server, base, 'POST', { userId: f.adult.userId, scope: 'member', memberId: f.member.id })).status).toBe(404);
    expect((await send(server, base + '/' + f.adult.id, 'DELETE')).status).toBe(404);
    expect((await send(app(staff('owner')), base, 'POST', { userId: f.adult.userId, scope: 'member', memberId: f.foreign.id })).status).toBe(404);
    expect((await send(app(staff('owner')), `/api/households/${f.otherHousehold.id}/users/${f.adult.id}`, 'DELETE')).status).toBe(404);
  });
  it('separates staff and member routes, reloads scope and immediately denies revoked logins', async () => {
    const f = await fixture(), loader = createPortalPrincipalLoader(db.forGym), principal = await loader(gym, f.adult.userId), server = app(principal);
    expect((await send(server, '/api/portal/context')).status).toBe(200);
    expect((await send(server, `/api/households/${f.otherHousehold.id}/users`)).status).toBe(403);
    expect((await send(app(staff('owner')), '/api/portal/context')).status).toBe(404);
    expect((await send(app(principal, otherGym), '/api/portal/context')).status).toBe(404);
    await db.forGym(gym, tx => tx.update(householdUsers).set({ scope: 'payer' }).where(eq(householdUsers.id, f.adult.id)));
    expect(await (await send(server, '/api/portal/context')).json()).toMatchObject({ data: { role: 'payer' } });
    await service.revoke({ gymId: gym, actor: { kind: 'system' } }, f.household.id, f.adult.id);
    expect((await send(server, '/api/portal/context')).status).toBe(404);
    expect(await loader(gym, f.adult.userId)).toEqual({ kind: 'anonymous' });
    expect((await db.forGym(gym, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.adult.id)))).at(-1)?.action).toBe('household_user.revoked');
  });
  it('keeps members, invoices, waivers and bookings inside forHousehold, including adult-only data', async () => {
    const f = await fixture();
    const ownInvoice = await factory('invoices', gym, { householdId: f.household.id }), otherInvoice = await factory('invoices', gym, { householdId: f.otherHousehold.id });
    const ownBooking = await factory('classBookings', gym, { memberId: f.member.id }), siblingBooking = await factory('classBookings', gym, { memberId: f.sibling.id });
    await factory('classBookings', gym, { memberId: f.foreign.id });
    await factory('waiverSignatures', gym, { memberId: f.member.id }); await factory('waiverSignatures', gym, { memberId: f.foreign.id });
    await db.forHousehold({ kind: 'user', ...f.payer }, async q => {
      expect(await q.member(f.foreign.id)).toEqual([]); expect(await q.invoice(otherInvoice.id)).toEqual([]);
      expect((await q.invoices()).map(row => row.id)).toContain(ownInvoice.id);
      expect((await q.bookings()).map(row => row.id).sort()).toEqual([ownBooking.id, siblingBooking.id].sort());
      expect((await q.waivers()).every(row => row.memberId === f.member.id)).toBe(true);
    });
    await db.forHousehold({ kind: 'user', ...f.adult }, async q => {
      expect((await q.members()).map(row => row.id)).toEqual([f.member.id]); expect(await q.member(f.sibling.id)).toEqual([]);
      expect((await q.bookings()).map(row => row.id)).toEqual([ownBooking.id]); await expect(q.invoices()).rejects.toThrow('Payer access required');
    });
  });
});
