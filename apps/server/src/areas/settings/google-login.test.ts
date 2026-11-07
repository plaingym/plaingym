// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { googleLoginResponseSchema } from '@plaingym/shared/contracts';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from '../staff/auth.permissions.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { setLogSink } from '../../core/log.js';
import { authConfig } from '../../infra/auth/config.js';
import { createAuthService } from '../../infra/auth/service.js';
import { createGoogleAuthExtension } from '../../infra/auth/google.js';
import { createIntegrationsService, type IntegrationsOptions } from './integrations.js';
import { createIntegrationsRoutes } from './integrations.routes.js';
import { createGoogleClientResolver, encryptGoogleConfig, readGoogleConfig } from './google-login.js';
import { encryptSmtpConfig } from './smtp.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-11-04T12:00:00Z');
const key = Buffer.alloc(32, 9);
const env = { AUTH_SECRET: 'google-settings-secret-with-32-characters!', TENANCY: 'single', AUTH_PASSWORD_LOGIN: 'auto' };
const installGoogle = { GOOGLE_CLIENT_ID: 'install-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'install-secret-never-shown' };
const clientId = 'gym-client.apps.googleusercontent.com', clientSecret = 'gym-secret-never-shown';
const withPassword = new Set<string>();
const base: IntegrationsOptions = { key, env, config: authConfig(env, false), origin: async () => 'https://gym.invalid',
  hasPassword: async (userId) => withPassword.has(userId), clock, scope: database.forGym };
const service = createIntegrationsService(base);
const gymA = uuidv7(), gymB = uuidv7();
let owner: string, ownerB: string;
/** Every response body the tests saw, checked for the secret at the end. */
const seen: string[] = [];
const logs: string[] = [];
let previousSink: ReturnType<typeof setLogSink>;
beforeAll(async () => {
  previousSink = setLogSink((line) => logs.push(line));
  await factory('gyms', gymA, { name: 'Gym A' });
  await factory('gyms', gymB, { name: 'Gym B' });
  owner = (await factory('authUser', gymA)).id;
  ownerB = (await factory('authUser', gymB)).id;
});
afterAll(() => { setLogSink(previousSink); });

function server(options: { role?: StaffRole; gymId?: string; principalGym?: string; userId?: string; routesService?: ReturnType<typeof createIntegrationsService> } = {}) {
  const { role = 'owner', gymId = gymA, principalGym = gymId, userId = gymId === gymB ? ownerB : owner } = options;
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId: principalGym, userId, roles: [role] }, clock, requestId: 'test' }); await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createIntegrationsRoutes(options.routesService ?? service) }).mount(app, authorize, new Set());
  return app;
}
async function call(app: ReturnType<typeof server>, method: string, body?: unknown) {
  const response = await app.request('/api/settings/integrations/google', { method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await response.text();
  seen.push(text);
  return { status: response.status, json: text ? JSON.parse(text) as { data: never; error?: { details?: Record<string, string[]> } } : null };
}
const read = async (app = server()) => googleLoginResponseSchema.parse((await call(app, 'GET')).json).data;
const save = async (app: ReturnType<typeof server>, revision: number, id = clientId, secret = clientSecret) =>
  call(app, 'PUT', { revision, clientId: id, clientSecret: secret });
const row = async (gymId = gymA) => (await database.forGym(gymId, (tx) => tx.select().from(gyms)))[0]!;
const setStored = (gymId: string, value: string | null) => database.forGym(gymId, (tx) => tx.update(gyms).set({ googleConfig: value }).where(eq(gyms.id, gymId)));

describe('Google sign-in settings permissions', () => {
  it.each(staffRoles)('lets only owners read and change Google sign-in (%s)', async (role) => {
    const app = server({ role }), allowed = role === 'owner';
    expect((await call(app, 'GET')).status).toBe(allowed ? 200 : 403);
    for (const method of ['PUT', 'DELETE']) expect((await call(app, method, {})).status, method).toBe(allowed ? 400 : 403);
  });
  it('denies an owner of another gym and leaves that gym untouched', async () => {
    const app = server({ gymId: gymB, principalGym: gymA, userId: owner }), before = await row(gymB);
    expect((await call(app, 'GET')).status).toBe(403);
    expect((await save(app, before.revision)).status).toBe(403);
    expect((await call(app, 'DELETE', { revision: before.revision })).status).toBe(403);
    expect(await row(gymB)).toEqual(before);
  });
});

describe('Settings → Google sign-in', () => {
  it('stores the gym’s client encrypted, audited without either value, and returns only the client ID', async () => {
    const before = await read();
    expect(before).toEqual({ source: 'none', editable: true, unreadable: false, clientId: null, clientSecretSet: false, removeBlocked: false, revision: before.revision });
    for (const bad of [{ clientId: 'has space', clientSecret }, { clientId, clientSecret: '' }, { clientId, clientSecret: 'x'.repeat(513) }])
      expect((await call(server(), 'PUT', { revision: before.revision, ...bad })).status).toBe(400);
    const saved = googleLoginResponseSchema.parse((await save(server(), before.revision, ' ' + clientId + ' ')).json).data;
    // No email anywhere and no password of the owner's own: Google is now their only way in.
    expect(saved).toEqual({ source: 'gym', editable: true, unreadable: false, clientId, clientSecretSet: true, removeBlocked: true, revision: before.revision + 1 });
    expect(JSON.parse(decryptSecret(key, { secretClass: 'google_config', owner: gymA }, (await row()).googleConfig!))).toEqual({ clientId, clientSecret });
    expect(await read()).toEqual(saved);
    const [audit] = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'integrations.google_saved')));
    expect(audit).toMatchObject({ actorUserId: owner, targetId: gymA, before: { source: 'none' }, after: { source: 'gym', revision: saved.revision } });
  });
  it('refuses a stale revision and replaces both values on a new save', async () => {
    const current = await read();
    expect((await save(server(), current.revision - 1, 'stale-client')).status).toBe(409);
    const replaced = googleLoginResponseSchema.parse((await save(server(), current.revision, 'second-client', 'second-secret-never-shown')).json).data;
    expect(replaced).toMatchObject({ clientId: 'second-client', clientSecretSet: true, revision: current.revision + 1 });
    expect(JSON.parse(decryptSecret(key, { secretClass: 'google_config', owner: gymA }, (await row()).googleConfig!))).toEqual({ clientId: 'second-client', clientSecret: 'second-secret-never-shown' });
  });
  it('refuses to remove the client while Google is the owner’s only way to sign in, then removes it', async () => {
    // No email anywhere and password login off: the owner signs in only with Google.
    const offEnv = { ...env, AUTH_PASSWORD_LOGIN: 'off' };
    const app = server({ routesService: createIntegrationsService({ ...base, env: offEnv, config: authConfig(offEnv, false) }) });
    const current = await read(app);
    expect(current).toMatchObject({ source: 'gym', removeBlocked: true });
    const refused = await call(app, 'DELETE', { revision: current.revision });
    expect(refused.status).toBe(409);
    expect(refused.json?.error?.details).toEqual({ google: ['only_sign_in'] });
    expect((await row()).googleConfig).not.toBeNull();
    // A password of their own counts only where password login is on.
    withPassword.add(owner);
    expect((await read(app)).removeBlocked).toBe(true);
    expect((await read()).removeBlocked).toBe(false);
    const removed = googleLoginResponseSchema.parse((await call(server(), 'DELETE', { revision: current.revision })).json).data;
    expect(removed).toEqual({ source: 'none', editable: true, unreadable: false, clientId: null, clientSecretSet: false, removeBlocked: false, revision: current.revision + 1 });
    expect((await row()).googleConfig).toBeNull();
    const again = await call(server(), 'DELETE', { revision: removed.revision });
    expect(again.json?.error?.details).toEqual({ google: ['not_configured'] });
    const [audit] = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'integrations.google_removed')));
    expect(audit).toMatchObject({ before: { source: 'gym' }, after: { source: 'none', revision: removed.revision } });
    withPassword.delete(owner);
  });
  it('offers no form when the install’s configuration sets Google, which wins over a stored client', async () => {
    const installEnv = { ...env, ...installGoogle };
    const app = server({ routesService: createIntegrationsService({ ...base, env: installEnv }) });
    await setStored(gymA, encryptGoogleConfig(key, gymA, { clientId, clientSecret }));
    const status = await read(app);
    expect(status).toMatchObject({ source: 'install', editable: false, clientId: null, clientSecretSet: false, removeBlocked: false });
    const refused = await save(app, status.revision);
    expect(refused.status).toBe(409);
    expect(refused.json?.error?.details).toEqual({ google: ['install_configured'] });
    expect((await call(app, 'DELETE', { revision: status.revision })).json?.error?.details).toEqual({ google: ['install_configured'] });
    const resolver = createGoogleClientResolver({ key, env: installEnv, tenancy: 'single', scope: database.forGym });
    expect(await resolver.credentials(gymA)).toEqual({ clientId: installGoogle.GOOGLE_CLIENT_ID, clientSecret: installGoogle.GOOGLE_CLIENT_SECRET });
    await setStored(gymA, null);
  });
  it('ignores the stored column in multi-gym mode and offers no form there', async () => {
    const multiEnv = { ...env, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' };
    const multi = createIntegrationsService({ ...base, env: multiEnv, config: authConfig(multiEnv, true) });
    await setStored(gymB, encryptGoogleConfig(key, gymB, { clientId, clientSecret }));
    const app = server({ gymId: gymB, routesService: multi });
    const status = await read(app);
    expect(status).toMatchObject({ source: 'none', editable: false, clientId: null, clientSecretSet: false });
    expect((await save(app, status.revision)).status).toBe(404);
    expect((await call(app, 'DELETE', { revision: status.revision })).status).toBe(404);
    expect(await createGoogleClientResolver({ key, env: multiEnv, tenancy: 'multi', scope: database.forGym }).credentials(gymB)).toBeNull();
    // The install's own client still applies to every gym in multi-gym mode.
    const withInstall = createGoogleClientResolver({ key, env: { ...multiEnv, ...installGoogle }, tenancy: 'multi', scope: database.forGym });
    expect((await withInstall.credentials(gymB))?.clientId).toBe(installGoogle.GOOGLE_CLIENT_ID);
    const installStatus = await read(server({ gymId: gymB, routesService: createIntegrationsService({ ...base, env: { ...multiEnv, ...installGoogle }, config: authConfig(multiEnv, true) }) }));
    expect(installStatus).toMatchObject({ source: 'install', editable: false });
    await setStored(gymB, null);
  });
  it('has no stored client in demo mode or a sandbox', async () => {
    const demoEnv = { ...env, DEMO_MODE: 'true', ...installGoogle };
    await setStored(gymB, encryptGoogleConfig(key, gymB, { clientId, clientSecret }));
    expect(await createGoogleClientResolver({ key, env: demoEnv, tenancy: 'single', scope: database.forGym }).credentials(gymB)).toBeNull();
    const sandbox = server({ gymId: gymB, routesService: createIntegrationsService({ ...base, sandbox: true }) });
    const status = await read(sandbox);
    expect(status).toMatchObject({ source: 'none', editable: false });
    expect((await save(sandbox, status.revision)).status).toBe(404);
    await setStored(gymB, null);
  });
  it('reads a stored client a newer release added a key to, and still refuses an unknown key on a save', () => {
    const value = encryptSecret(key, { secretClass: 'google_config', owner: gymB }, JSON.stringify({ clientId, clientSecret, newerKey: true }));
    expect(readGoogleConfig(key, value, gymB)).toEqual({ clientId, clientSecret });
    expect(() => encryptGoogleConfig(key, gymB, { clientId, clientSecret, newerKey: true } as { clientId: string; clientSecret: string })).toThrow();
  });
  it('reports an unreadable client as off, does not count it as a way in, and logs once per value', async () => {
    const corrupt = () => encryptSecret(Buffer.alloc(32, 1), { secretClass: 'google_config', owner: gymB }, JSON.stringify({ clientId, clientSecret }));
    const value = corrupt();
    await setStored(gymB, value);
    const resolver = createGoogleClientResolver({ key, env, tenancy: 'single', scope: database.forGym });
    const app = server({ gymId: gymB, userId: ownerB });
    const start = logs.length;
    for (let i = 0; i < 3; i++) {
      expect(await resolver.credentials(gymB)).toBeNull();
      expect(await read(app)).toMatchObject({ source: 'none', unreadable: true, editable: true, clientId: null, clientSecretSet: false, removeBlocked: false });
    }
    await database.forGym(gymB, (tx) => tx.update(gyms).set({ smtpConfig: encryptSmtpConfig(key, gymB,
      { host: 'smtp.gym.invalid', port: 465, security: 'tls', from: 'desk@gym.invalid', username: 'user', password: 'secret' }) }).where(eq(gyms.id, gymB)));
    const integrations = await (await app.request('/api/settings/integrations')).json() as { data: { email: { removeBlocked: boolean } } };
    expect(integrations.data.email.removeBlocked).toBe(true);
    expect(logs.slice(start).filter((line) => line.includes('settings.google_config_unreadable'))).toHaveLength(1);
    expect(logs.slice(start).join('')).not.toContain(value);
    await setStored(gymB, corrupt());
    expect(await resolver.credentials(gymB)).toBeNull();
    expect(logs.slice(start).filter((line) => line.includes('settings.google_config_unreadable'))).toHaveLength(2);
    const unreadable = await read(app);
    expect((await call(app, 'DELETE', { revision: unreadable.revision })).status).toBe(200);
    expect(await read(app)).toMatchObject({ source: 'none', unreadable: false });
    await setStored(gymB, corrupt());
    const current = await read(app);
    expect((await save(app, current.revision)).status).toBe(200);
    expect(await resolver.credentials(gymB)).toEqual({ clientId, clientSecret });
    expect(await read(app)).toMatchObject({ source: 'gym', clientSecretSet: true });
    await database.forGym(gymB, (tx) => tx.update(gyms).set({ smtpConfig: null }).where(eq(gyms.id, gymB)));
    await setStored(gymB, null);
  });
  it('counts a stored or install Google client as a way in when the owner removes the gym’s email settings', async () => {
    const smtp = encryptSmtpConfig(key, gymB, { host: 'smtp.gym.invalid', port: 465, security: 'tls', from: 'desk@gym.invalid', username: 'gym-user', password: 'smtp-secret-never-shown' });
    const gym = (gymId: string, values: Partial<typeof gyms.$inferInsert>) => database.forGym(gymId, (tx) => tx.update(gyms).set(values).where(eq(gyms.id, gymId)));
    await gym(gymB, { smtpConfig: smtp });
    // No password and no other email: removing the gym's email would leave the owner no way in.
    const withoutGoogle = server({ gymId: gymB });
    const emailRemove = (app: ReturnType<typeof server>, revision: number) => app.request('/api/settings/integrations/email', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision }) });
    const integrations = async (app: ReturnType<typeof server>) => (await (await app.request('/api/settings/integrations')).json() as { data: { email: { removeBlocked: boolean }; revision: number } }).data;
    let current = await integrations(withoutGoogle);
    expect(current.email.removeBlocked).toBe(true);
    expect((await emailRemove(withoutGoogle, current.revision)).status).toBe(409);
    expect((await row(gymB)).smtpConfig).not.toBeNull();
    // A client the owner stored counts, so they can remove the email settings and still sign in with Google.
    await setStored(gymB, encryptGoogleConfig(key, gymB, { clientId, clientSecret }));
    current = await integrations(withoutGoogle);
    expect(current.email.removeBlocked).toBe(false);
    expect((await emailRemove(withoutGoogle, current.revision)).status).toBe(200);
    expect((await row(gymB)).smtpConfig).toBeNull();
    // So does the install's own client, which the stored one never overrides.
    await setStored(gymB, null);
    await gym(gymB, { smtpConfig: smtp });
    const installEnv = { ...env, ...installGoogle };
    const withInstall = server({ gymId: gymB, routesService: createIntegrationsService({ ...base, env: installEnv }) });
    current = await integrations(withInstall);
    expect(current.email.removeBlocked).toBe(false);
    expect((await emailRemove(withInstall, current.revision)).status).toBe(200);
    expect((await row(gymB)).smtpConfig).toBeNull();
  });
});

describe('Google sign-in without a restart', () => {
  it('uses a saved, replaced or removed client on the next sign-in', async () => {
    const resolver = createGoogleClientResolver({ key, env, tenancy: 'single', scope: database.forGym });
    const auth = createAuthService({ config: authConfig({ ...env, NODE_ENV: 'production' }, false), database: () => database.system.db,
      google: createGoogleAuthExtension({ credentials: resolver.credentials, database: () => database.system.db }) });
    const origin = 'https://gym-a.example.test';
    const start = () => auth.bind({ gymId: gymA, origin, clientIp: '192.0.2.10' }).handler(new Request(origin + '/api/auth/sign-in/social', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google' }) }));
    const client = async () => {
      const response = await start();
      expect(response.status).toBe(200);
      const url = new URL(((await response.json()) as { url: string }).url);
      expect(url.searchParams.get('redirect_uri')).toBe(origin + '/api/auth/callback/google');
      return url.searchParams.get('client_id');
    };
    expect((await start()).status).toBe(404);
    let { revision } = await read();
    ({ revision } = googleLoginResponseSchema.parse((await save(server(), revision)).json).data);
    expect(await client()).toBe(clientId);
    ({ revision } = googleLoginResponseSchema.parse((await save(server(), revision, 'rotated-client', 'rotated-secret-never-shown')).json).data);
    expect(await client()).toBe('rotated-client');
    withPassword.add(owner);
    expect((await call(server(), 'DELETE', { revision })).status).toBe(200);
    withPassword.delete(owner);
    expect((await start()).status).toBe(404);
    // The other gym never had a client, whatever gym A stored.
    expect(await resolver.credentials(gymB)).toBeNull();
  });
  it('never returned, audited or logged a client secret', async () => {
    const audits = [...await database.forGym(gymA, (tx) => tx.select().from(auditEvents)), ...await database.forGym(gymB, (tx) => tx.select().from(auditEvents))];
    expect(audits.length).toBeGreaterThan(0);
    const text = seen.join('\n') + JSON.stringify(audits) + logs.join('\n');
    for (const secret of [clientSecret, 'second-secret-never-shown', 'rotated-secret-never-shown', installGoogle.GOOGLE_CLIENT_SECRET])
      expect(text, secret).not.toContain(secret);
  });
});
