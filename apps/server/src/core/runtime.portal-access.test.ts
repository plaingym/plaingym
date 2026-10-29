// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { householdUsers, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { clock } from './clock.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db);
let runtime: Runtime | undefined, directory: string | undefined;
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('keeps a signed-in session without staff roles or household links, so the admin can explain the missing access', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-portal-access-runtime-'));
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'cd'.repeat(32),
    AUTH_SECRET: 'runtime-portal-access-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on', TENANCY: 'single',
    PUBLIC_ORIGIN: 'https://gym.example.test', NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') };
  const gymId = uuidv7(); await factory('gyms', gymId);
  const accounts = createAccountService(authConfig(env), () => db.system.db);
  const unlinked = await accounts.createPasswordUser(gymId, 'unlinked@example.test', 'Unlinked', 'unlinked-user-password', clock);
  const member = await accounts.createPasswordUser(gymId, 'member@example.test', 'Member', 'linked-member-password', clock);
  const login = await factory('householdUsers', gymId, { userId: member.userId, scope: 'payer', memberId: null });
  runtime = await startRuntime(env);
  const headers = (cookie = '') => ({ host: 'gym.example.test', origin: env.PUBLIC_ORIGIN, 'content-type': 'application/json', cookie });
  const signIn = async (email: string, password: string) => {
    const response = await runtime!.app.request(env.PUBLIC_ORIGIN + '/api/auth/sign-in/email', { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) });
    expect(response.status).toBe(200);
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  };
  const bootstrap = async (cookie: string) => (await (await runtime!.app.request(env.PUBLIC_ORIGIN + '/api/auth/bootstrap', { headers: headers(cookie) })).json()).data.session;
  const get = async (path: string, cookie: string) => (await runtime!.app.request(env.PUBLIC_ORIGIN + path, { headers: headers(cookie) })).status;

  const unlinkedCookie = await signIn('unlinked@example.test', 'unlinked-user-password');
  expect(await bootstrap(unlinkedCookie)).toEqual({ userId: unlinked.userId, roles: [], member: false });
  expect(await get('/api/members', unlinkedCookie)).toBe(403);
  expect(await get('/api/portal/context', unlinkedCookie)).toBe(404);

  // A revoked household login keeps its session but loses access, rather than looping back to login.
  const memberCookie = await signIn('member@example.test', 'linked-member-password');
  expect(await bootstrap(memberCookie)).toEqual({ userId: member.userId, roles: [], member: true });
  expect(await get('/api/portal/context', memberCookie)).toBe(200);
  await db.forGym(gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.id, login.id)));
  expect(await bootstrap(memberCookie)).toEqual({ userId: member.userId, roles: [], member: false });
  expect(await get('/api/portal/context', memberCookie)).toBe(404);
  expect(await get('/api/members', memberCookie)).toBe(403);

  // A login with several households keeps its session and is offered the picker, never the first household.
  const first = await factory('households', gymId, { name: 'First household' }), second = await factory('households', gymId, { name: 'Second household' });
  for (const household of [first, second]) await factory('householdUsers', gymId, { householdId: household.id, userId: member.userId, scope: 'payer', memberId: null });
  expect(await bootstrap(memberCookie)).toEqual({ userId: member.userId, roles: [], member: true });
  expect(await get('/api/portal/context', memberCookie)).toBe(404);
  const choices = await (await runtime.app.request(env.PUBLIC_ORIGIN + '/api/portal/households', { headers: headers(memberCookie) })).json();
  expect(choices).toEqual({ data: { current: null, households: [
    { householdId: first.id, name: 'First household', role: 'payer' }, { householdId: second.id, name: 'Second household', role: 'payer' }] } });

  // The choice is stored with the session and read back by the real principal loader on the next request.
  const choose = (householdId: string) => runtime!.app.request(env.PUBLIC_ORIGIN + '/api/portal/households/current',
    { method: 'POST', headers: headers(memberCookie), body: JSON.stringify({ householdId }) });
  const context = async () => (await runtime!.app.request(env.PUBLIC_ORIGIN + '/api/portal/context', { headers: headers(memberCookie) })).json();
  const unlinkedHousehold = await factory('households', gymId);
  expect((await choose(unlinkedHousehold.id)).status).toBe(404);
  expect(await get('/api/portal/context', memberCookie)).toBe(404);
  expect((await choose(second.id)).status).toBe(200);
  expect(await context()).toEqual({ data: { role: 'payer', householdId: second.id, memberId: null } });
  expect((await choose(first.id)).status).toBe(200);
  expect(await context()).toEqual({ data: { role: 'payer', householdId: first.id, memberId: null } });
  // A revoked choice is never honored: with one link left, the session opens that household.
  await db.forGym(gymId, tx => tx.delete(householdUsers).where(and(eq(householdUsers.householdId, first.id), eq(householdUsers.userId, member.userId))));
  expect(await context()).toEqual({ data: { role: 'payer', householdId: second.id, memberId: null } });
});
