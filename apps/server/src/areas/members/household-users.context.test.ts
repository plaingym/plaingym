// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The composition test inspects where the session stores its chosen household.
import { auditEvents, authSession, householdUsers, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the real registrations' app-role pools in the isolated composition test; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createApp } from '../../core/app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { TestClock } from '../../core/clock.js';
import { authConfig } from '../../infra/auth/config.js';
import { createAuthService } from '../../infra/auth/service.js';
import { sessionMiddleware } from '../../infra/auth/middleware.js';
import { passwordAdapter } from '../../infra/auth/password.js';
import { createPortalAuthorization } from '../portal/auth.permissions.js';
import { createMemberHouseholdContext, createPortalPrincipalLoader } from './household-users.context.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-29T12:00:00Z');
const config = authConfig({ AUTH_SECRET: 'portal-selection-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false);
const password = 'household-selection-password';
let hash: string, ip = 1;
beforeAll(async () => { await initializeDatabase(db.appUrl); hash = await passwordAdapter.hash(password); });
afterAll(() => closeDatabase());

async function fixture() {
  const gymId = uuidv7(), otherGymId = uuidv7(); await factory('gyms', gymId); await factory('gyms', otherGymId);
  const origin = `https://${gymId}.example.test`, otherOrigin = `https://${otherGymId}.example.test`, clientIp = `192.0.2.${ip++}`;
  const user = await factory('authUser', gymId);
  await factory('authAccount', gymId, { userId: user.id, accountId: user.id, password: hash });
  const first = await factory('households', gymId, { name: 'Alder household' }), second = await factory('households', gymId, { name: 'Birch household' });
  const unrelated = await factory('households', gymId, { name: 'Cedar household' }), foreign = await factory('households', otherGymId, { name: 'Foreign household' });
  const adult = await factory('members', gymId, { householdId: second.id, dateOfBirth: '1990-01-01' });
  const payerLogin = await factory('householdUsers', gymId, { householdId: first.id, userId: user.id, scope: 'payer', memberId: null });
  const memberLogin = await factory('householdUsers', gymId, { householdId: second.id, userId: user.id, scope: 'member', memberId: adult.id });
  // The same identity in another gym is a separate grant there and never selectable here.
  await factory('householdUsers', otherGymId, { householdId: foreign.id, userId: user.id, scope: 'payer', memberId: null });
  const auth = createAuthService({ config, database: () => db.system.db, sendMagicLink: async () => undefined });
  const loader = createPortalPrincipalLoader(db.forGym);
  const server = (id = gymId, at = origin) => createApp({ clock, contributions: areaContributions, authorize: createPortalAuthorization(createMemberHouseholdContext(db.forGym)), origin: at,
    resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: id, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: sessionMiddleware({ auth, resolve: () => ({ gymId: id, origin: at, clientIp }), principal: (userId, ctx, session) => loader(ctx.get('context').gym.gymId, userId, session) }),
  });
  const signIn = async (id = gymId, at = origin) => {
    const response = await auth.bind({ gymId: id, origin: at, clientIp }).handler(new Request(at + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: at, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }));
    expect(response.status).toBe(200);
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  };
  const call = async (cookie: string, path: string, method = 'GET', body?: unknown, id = gymId, at = origin) => {
    const response = await server(id, at).request(at + path, { method, headers: { cookie, origin: at, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() as { data: Record<string, unknown> } : null };
  };
  return { gymId, otherGymId, origin, otherOrigin, user, first, second, unrelated, foreign, adult, payerLogin, memberLogin, signIn, call };
}
const select = (householdId: string) => ({ householdId });

describe('multiple households per login', () => {
  it('asks a login with several households to pick one, then scopes every request to the stored choice', async () => {
    const f = await fixture(), cookie = await f.signIn();
    expect((await f.call(cookie, '/api/portal/context')).status).toBe(404);
    expect((await f.call(cookie, '/api/portal/households')).body).toEqual({ data: { current: null, households: [
      { householdId: f.first.id, name: 'Alder household', role: 'payer' }, { householdId: f.second.id, name: 'Birch household', role: 'member' }] } });
    expect((await f.call(cookie, '/api/portal/households/current', 'POST', select(f.second.id))).status).toBe(200);
    expect((await f.call(cookie, '/api/portal/context')).body).toEqual({ data: { role: 'member', householdId: f.second.id, memberId: f.adult.id } });
    expect((await f.call(cookie, '/api/portal/households')).body?.data.current).toBe(f.second.id);
    // Switching replaces the scope; the request itself never names a household.
    expect((await f.call(cookie, '/api/portal/households/current', 'POST', select(f.first.id))).status).toBe(200);
    expect((await f.call(cookie, '/api/portal/context')).body).toEqual({ data: { role: 'payer', householdId: f.first.id, memberId: null } });
    const [stored] = await db.system.db.select({ householdId: authSession.householdId }).from(authSession).where(and(eq(authSession.userId, f.user.id), eq(authSession.gymId, f.gymId)));
    expect(stored?.householdId).toBe(f.first.id);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, 'portal.household_selected')))).toBe(2);
  });
  it('keeps each session\'s choice separate', async () => {
    const f = await fixture(), phone = await f.signIn(), laptop = await f.signIn();
    await f.call(phone, '/api/portal/households/current', 'POST', select(f.first.id));
    await f.call(laptop, '/api/portal/households/current', 'POST', select(f.second.id));
    expect((await f.call(phone, '/api/portal/context')).body?.data.householdId).toBe(f.first.id);
    expect((await f.call(laptop, '/api/portal/context')).body?.data.householdId).toBe(f.second.id);
  });
  it('refuses households from another gym or without this login, and requires a session', async () => {
    const f = await fixture(), cookie = await f.signIn();
    for (const id of [f.unrelated.id, f.foreign.id, uuidv7()]) expect((await f.call(cookie, '/api/portal/households/current', 'POST', select(id))).status).toBe(404);
    expect((await f.call(cookie, '/api/portal/households/current', 'POST', { householdId: f.first.id, extra: true })).status).toBe(400);
    expect((await f.call(cookie, '/api/portal/context')).status).toBe(404);
    expect((await f.call('', '/api/portal/households')).status).toBe(401);
    expect((await f.call('', '/api/portal/households/current', 'POST', select(f.first.id))).status).toBe(401);
    // A session issued by gym A is refused by gym B before any household is considered.
    expect((await f.call(cookie, '/api/portal/households/current', 'POST', select(f.foreign.id), f.otherGymId, f.otherOrigin)).status).toBe(403);
    const other = await f.signIn(f.otherGymId, f.otherOrigin);
    expect((await f.call(other, '/api/portal/households', 'GET', undefined, f.otherGymId, f.otherOrigin)).body?.data).toEqual({ current: f.foreign.id, households: [{ householdId: f.foreign.id, name: 'Foreign household', role: 'payer' }] });
    expect((await f.call(other, '/api/portal/households/current', 'POST', select(f.first.id), f.otherGymId, f.otherOrigin)).status).toBe(404);
  });
  it('rechecks the stored choice on every request: a revoked link returns to the picker, and one link goes straight in', async () => {
    const f = await fixture(), cookie = await f.signIn();
    await f.call(cookie, '/api/portal/households/current', 'POST', select(f.first.id));
    const third = await factory('households', f.gymId, { name: 'Douglas household' });
    await factory('householdUsers', f.gymId, { householdId: third.id, userId: f.user.id, scope: 'payer', memberId: null });
    await db.forGym(f.gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.id, f.payerLogin.id)));
    expect((await f.call(cookie, '/api/portal/context')).status).toBe(404);
    expect((await f.call(cookie, '/api/portal/households')).body?.data.current).toBeNull();
    await db.forGym(f.gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.householdId, third.id)));
    expect((await f.call(cookie, '/api/portal/context')).body?.data).toEqual({ role: 'member', householdId: f.second.id, memberId: f.adult.id });
  });
  it('keeps staff identities out of the portal even with household links', async () => {
    const f = await fixture(), cookie = await f.signIn();
    await factory('staffRoles', f.gymId, { userId: f.user.id, role: 'front_desk' });
    expect((await f.call(cookie, '/api/portal/households')).body?.data).toEqual({ current: null, households: [] });
    expect((await f.call(cookie, '/api/portal/households/current', 'POST', select(f.first.id))).status).toBe(404);
    expect((await f.call(cookie, '/api/portal/context')).status).toBe(404);
  });
  it('never trusts a stored choice the loader is not given, and never shows two households at once', async () => {
    const f = await fixture(), loader = createPortalPrincipalLoader(db.forGym);
    expect(await loader(f.gymId, f.user.id)).toEqual({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [] });
    expect(await loader(f.gymId, f.user.id, { householdId: f.unrelated.id })).toEqual({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [] });
    expect(await loader(f.gymId, f.user.id, { householdId: f.foreign.id })).toEqual({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [] });
    expect(await loader(f.gymId, f.user.id, { householdId: f.second.id })).toEqual({ kind: 'member', userId: f.user.id, scope: { gymId: f.gymId, householdId: f.second.id, role: 'member', memberId: f.adult.id } });
  });
});
