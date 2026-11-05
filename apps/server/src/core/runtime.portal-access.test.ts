// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { householdUsers, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { requestPortalConfirmation } from '../areas/members/household-users.js';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { clock } from './clock.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db);
const origin = 'https://gym.example.test', gymId = uuidv7();
let runtime: Runtime | undefined, directory: string | undefined, accounts: ReturnType<typeof createAccountService>;
beforeAll(async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-portal-access-runtime-'));
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'cd'.repeat(32),
    AUTH_SECRET: 'runtime-portal-access-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on', TENANCY: 'single',
    PUBLIC_ORIGIN: origin, NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') };
  await factory('gyms', gymId, { billingEnabled: true });
  accounts = createAccountService(authConfig(env), () => db.system.db);
  runtime = await startRuntime(env);
});
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const headers = (cookie = '') => ({ host: 'gym.example.test', origin, 'content-type': 'application/json', cookie });
async function signIn(email: string, password: string) {
  const response = await runtime!.app.request(origin + '/api/auth/sign-in/email', { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
it('keeps a signed-in session without staff roles or household links, so the admin can explain the missing access', async () => {
  const unlinked = await accounts.createPasswordUser(gymId, 'unlinked@example.test', 'Unlinked', 'unlinked-user-password', clock);
  const member = await accounts.createPasswordUser(gymId, 'member@example.test', 'Member', 'linked-member-password', clock);
  const login = await factory('householdUsers', gymId, { userId: member.userId, scope: 'payer', memberId: null });
  const bootstrap = async (cookie: string) => (await (await runtime!.app.request(origin + '/api/auth/bootstrap', { headers: headers(cookie) })).json()).data.session;
  const get = async (path: string, cookie: string) => (await runtime!.app.request(origin + path, { headers: headers(cookie) })).status;

  const unlinkedCookie = await signIn('unlinked@example.test', 'unlinked-user-password');
  expect(await bootstrap(unlinkedCookie)).toEqual({ userId: unlinked.userId, displayName: 'Unlinked', roles: [], member: false });
  expect(await get('/api/members', unlinkedCookie)).toBe(403);
  expect(await get('/api/portal/context', unlinkedCookie)).toBe(404);

  // A revoked household login keeps its session but loses access, rather than looping back to login.
  const memberCookie = await signIn('member@example.test', 'linked-member-password');
  expect(await bootstrap(memberCookie)).toEqual({ userId: member.userId, displayName: 'Member', roles: [], member: true });
  expect(await get('/api/portal/context', memberCookie)).toBe(200);
  await db.forGym(gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.id, login.id)));
  expect(await bootstrap(memberCookie)).toEqual({ userId: member.userId, displayName: 'Member', roles: [], member: false });
  expect(await get('/api/portal/context', memberCookie)).toBe(404);
  expect(await get('/api/members', memberCookie)).toBe(403);

  // A login with several households keeps its session and is offered the picker, never the first household.
  const first = await factory('households', gymId, { name: 'First household' }), second = await factory('households', gymId, { name: 'Second household' });
  for (const household of [first, second]) await factory('householdUsers', gymId, { householdId: household.id, userId: member.userId, scope: 'payer', memberId: null });
  expect(await bootstrap(memberCookie)).toEqual({ userId: member.userId, displayName: 'Member', roles: [], member: true });
  expect(await get('/api/portal/context', memberCookie)).toBe(404);
  const choices = await (await runtime!.app.request(origin + '/api/portal/households', { headers: headers(memberCookie) })).json();
  expect(choices).toEqual({ data: { current: null, households: [
    { householdId: first.id, name: 'First household', role: 'payer' }, { householdId: second.id, name: 'Second household', role: 'payer' }] } });

  // The choice is stored with the session and read back by the real principal loader on the next request.
  const choose = (householdId: string) => runtime!.app.request(origin + '/api/portal/households/current',
    { method: 'POST', headers: headers(memberCookie), body: JSON.stringify({ householdId }) });
  const context = async () => (await runtime!.app.request(origin + '/api/portal/context', { headers: headers(memberCookie) })).json();
  const unlinkedHousehold = await factory('households', gymId);
  expect((await choose(unlinkedHousehold.id)).status).toBe(404);
  expect(await get('/api/portal/context', memberCookie)).toBe(404);
  expect((await choose(second.id)).status).toBe(200);
  expect(await context()).toEqual({ data: { role: 'payer', memberId: null }, householdId: second.id });
  expect((await choose(first.id)).status).toBe(200);
  expect(await context()).toEqual({ data: { role: 'payer', memberId: null }, householdId: first.id });
  // A revoked choice is never honored: with one link left, the session opens that household.
  await db.forGym(gymId, tx => tx.delete(householdUsers).where(and(eq(householdUsers.householdId, first.id), eq(householdUsers.userId, member.userId))));
  expect(await context()).toEqual({ data: { role: 'payer', memberId: null }, householdId: second.id });
});
it('names a portal login by the member it is linked to in the open household, else by its own name, never another gym\'s', async () => {
  const user = await accounts.createPasswordUser(gymId, 'named@example.test', 'Login Name', 'named-user-password', clock);
  const first = await factory('households', gymId, { name: 'Named first' }), second = await factory('households', gymId, { name: 'Named second' });
  const mia = await factory('members', gymId, { householdId: first.id, firstName: 'Mia', lastName: 'First' });
  const noa = await factory('members', gymId, { householdId: second.id, firstName: 'Noa', lastName: 'Second' });
  await factory('householdUsers', gymId, { userId: user.userId, householdId: first.id, scope: 'member', memberId: mia.id });
  await factory('householdUsers', gymId, { userId: user.userId, householdId: second.id, scope: 'member', memberId: noa.id });
  const cookie = await signIn('named@example.test', 'named-user-password');
  const name = async () => (await (await runtime!.app.request(origin + '/api/auth/bootstrap', { headers: headers(cookie) })).json()).data.session.displayName;
  const choose = (householdId: string) => runtime!.app.request(origin + '/api/portal/households/current', { method: 'POST', headers: headers(cookie), body: JSON.stringify({ householdId }) });
  // Before choosing, no household is open: the earliest link names the person; once one is open, its member does.
  expect(['Mia First', 'Noa Second']).toContain(await name());
  expect((await choose(second.id)).status).toBe(200);
  expect(await name()).toBe('Noa Second');
  expect((await choose(first.id)).status).toBe(200);
  expect(await name()).toBe('Mia First');
  // With no linked member left, the login's own name is used.
  await db.forGym(gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.userId, user.userId)));
  expect(await name()).toBe('Login Name');
});
it('shows the owner, never a coach, the households awaiting portal confirmation on the dashboard', async () => {
  const owner = await accounts.createPasswordUser(gymId, 'owner@example.test', 'Owner', 'owner-user-password', clock);
  const coach = await accounts.createPasswordUser(gymId, 'coach@example.test', 'Coach', 'coach-user-password', clock);
  await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
  await factory('staffRoles', gymId, { userId: coach.userId, role: 'coach' });
  // A password-mode join leaves its household awaiting staff confirmation.
  const home = await factory('households', gymId, { name: 'Waiting household', email: 'waiting@example.test' });
  const person = await factory('members', gymId, { householdId: home.id });
  await db.forGym(gymId, tx => requestPortalConfirmation(tx, gymId, home.id, clock));
  const widgets = async (cookie: string) => {
    const response = await runtime!.app.request(origin + '/api/dashboard', { headers: headers(cookie) });
    expect(response.status).toBe(200);
    return (await response.json()).data.widgets as { id: string }[];
  };
  expect(await widgets(await signIn('owner@example.test', 'owner-user-password'))).toEqual(expect.arrayContaining([expect.objectContaining({
    id: 'members.portal-confirmations', kind: 'count', count: 1,
    items: [{ label: 'Waiting household', href: `/admin/members/${person.id}#memberTabs.portal-access` }] })]));
  expect((await widgets(await signIn('coach@example.test', 'coach-user-password'))).map(widget => widget.id)).not.toContain('members.portal-confirmations');
});
it('lists due cycle invoices below the card minimum on the billing staff dashboard, never a coach', async () => {
  const home = await factory('households', gymId, { name: 'Skipped household' });
  const invoice = await factory('invoices', gymId, { householdId: home.id, status: 'open', number: 7301, kind: 'cycle',
    periodStartsOn: '2020-01-01', periodEndsOn: '2020-02-01', dueOn: '2020-01-31', amountCents: 32 });
  const widgets = async (cookie: string) => {
    const response = await runtime!.app.request(origin + '/api/dashboard', { headers: headers(cookie) });
    expect(response.status).toBe(200);
    return (await response.json()).data.widgets as { id: string }[];
  };
  const ownerWidgets = await widgets(await signIn('owner@example.test', 'owner-user-password'));
  expect(ownerWidgets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'billing.skipped-collections', kind: 'count', count: 1,
    items: [expect.objectContaining({ href: `/admin/billing/invoices/${invoice.id}` })] })]));
  expect((await widgets(await signIn('coach@example.test', 'coach-user-password'))).map(widget => widget.id)).not.toContain('billing.skipped-collections');
});
