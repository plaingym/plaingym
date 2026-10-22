// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, gymDomains, kioskDevices, programs, ranks, householdUsers, staffRoles, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories, factoryTableNames } from '@plaingym/db/testing/factories';
import { staffRoles as roleNames, type StaffRole, createTranslator } from '@plaingym/shared';
import { runInTransaction } from '@plaingym/shared/transaction';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { registerDemoCleanup } from './demo.jobs.js';
import { createDemoService } from './service.js';
import { demoBootCheck, type DemoConfig } from './config.js';
import { createDemoIdentities, demoEmail } from './identities.js';
import { createDemoRoutes, routes as disabledRoutes } from './demo.routes.js';
import { createOutboxQuery } from './outbox.js';
import { demoUploads } from './uploads.js';
import { createUploadPrefixCleaner } from './storage.js';
import { createSeedCommand } from './seed-cli.js';
import { runSeeds } from './seed/index.js';
import { foundationSeed } from './seed/foundation.js';
import { verifyDemoStoredKeys } from './runtime.js';
import { createGymDeleteService } from '../areas/settings/gym-delete.js';
import { createGymDeleteRoutes } from '../areas/settings/gym-delete.routes.js';
import { OutboxEmail } from '../infra/email/outbox.js';
import { SmtpEmail } from '../infra/email/index.js';
import { FakeBackupObjectStore, FakeUploads } from '../infra/storage/index.js';
import { createAccountService } from '../infra/auth/accounts.js';
import { createAuthService } from '../infra/auth/service.js';
import { authConfig } from '../infra/auth/config.js';
import { authorize } from '../areas/staff/auth.permissions.js';
import { TestClock } from '../core/clock.js';
import { createServerRegistry, type RouteRegistration } from '../core/registry.js';
import type { RequestEnvironment } from '../core/context.js';
import { errorHandler } from '../core/errors.js';
import { csrf } from '../core/csrf.js';
import { parseEncryptionKey, encryptSecret } from '../core/secrets.js';
import { emailContract, infraContractGyms } from '../core/registry-infra-contracts.js';
import { renderDemoLogin } from '../emails/demo/demo.js';

const db = useTestDatabase(), factory = createFactories(db);
const key = parseEncryptionKey('ab'.repeat(32));
const config: DemoConfig = { enabled: true, domain: 'demo.example.test', maxSandboxes: 50 };
const authentication = authConfig({ AUTH_SECRET: 'demo-test-secret-with-more-than-32-characters', TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off', NODE_ENV: 'production' }, true);
const accounts = () => createAccountService(authentication, () => db.system.db);
const authFactory: typeof createAuthService = (options) => createAuthService({ ...options, database: () => db.system.db });
const clock = () => new TestClock('2026-10-22T16:00:00Z');
function fixture(settings: Partial<DemoConfig> = {}) {
  const time = clock(), mode = { ...config, ...settings }, cleaned = vi.fn(async (_gymId: string) => {});
  const deletion = createGymDeleteService({ clock: time, scope: db.forGym, system: db.forSystem, removeUploads: cleaned });
  const identities = createDemoIdentities({ config: mode, authConfig: authentication, clock: time, accounts: accounts(), scope: db.forGym, authFactory });
  const seed = (context: Parameters<typeof runSeeds>[0]) => runSeeds(context, [foundationSeed({ scope: db.forGym, clock: time })]);
  const service = createDemoService({ config: mode, key, clock: time, scope: db.forGym, system: db.forSystem, identities, seed, deletion });
  return { service, deletion, identities, seed, time, cleaned };
}
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
function appFor(routes: readonly RouteRegistration[], gymId: string, role: StaffRole | 'anonymous' = 'owner', origin = 'https://demo.example.test', ip = '192.0.2.1') {
  const app = new OpenAPIHono<RequestEnvironment>(), time = clock();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal: role === 'anonymous' ? { kind: 'anonymous' } : { kind: 'staff', gymId, userId: gymId, roles: [role] }, clock: time, requestId: 'demo-test' });
    await next();
  });
  app.onError(errorHandler); app.use('*', csrf(origin));
  createServerRegistry({ routes }).mount(app, authorize, new Set());
  return { app, time, ip };
}
const post = (app: ReturnType<typeof appFor>['app'], path: string, body: unknown = {}, headers = {}) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

beforeAll(async () => { await factory('gyms', infraContractGyms.a); await factory('gyms', infraContractGyms.b); });
emailContract('Postgres demo outbox', async () => new OutboxEmail(infraContractGyms.a, clock(), db.forGym));

describe('demo boundaries and sandbox lifecycle', () => {
  it('refuses live keys and invalid tenancy before constructing providers', () => {
    expect(demoBootCheck({})).toMatchObject({ enabled: false });
    expect(() => demoBootCheck({ DEMO_MODE: 'true', TENANCY: 'single' })).toThrow(/multi/);
    for (const token of ['sk_live_secret', 'rk_live_restricted', 'pk_live_public']) expect(() => demoBootCheck({ DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: config.domain, STRIPE_KEY: token })).toThrow(/live/);
    expect(demoBootCheck({ DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: config.domain, STRIPE_KEY: 'sk_test_123' })).toEqual(config);
    for (const value of ['0', '-1', '1.5', '1001', 'NaN']) expect(() => demoBootCheck({ DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: config.domain, DEMO_MAX_SANDBOXES: value })).toThrow();
  });
  it('enforces the cap under concurrent requests, including an empty sandbox pool', async () => {
    const f = fixture({ maxSandboxes: 2 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => f.service.create()));
    const created = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    expect(created).toHaveLength(2);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4);
    for (const sandbox of created) await f.deletion.remove(sandbox.gymId, 1);
  });
  it('creates random domains, owner/coach/student accounts, hashed kiosk tokens, and rank colors', async () => {
    const f = fixture(), sandbox = await f.service.create();
    expect(sandbox.origin).toMatch(/^https:\/\/[a-f0-9]{32}\.demo\.example\.test$/);
    expect(sandbox.expiresAt).toBe('2026-10-23T16:00:00.000Z');
    const rows = await db.forGym(sandbox.gymId, async (tx) => ({
      gym: (await tx.select().from(gyms))[0], devices: await tx.select().from(kioskDevices),
      programs: await tx.select().from(programs), ranks: await tx.select().from(ranks), roles: await tx.select().from(staffRoles), users: await tx.select().from(householdUsers),
    }));
    expect(rows.gym?.settings).not.toHaveProperty('bootstrapOwnerEmail');
    expect(rows.gym?.settings).toMatchObject({ setupComplete: true, demo: { ready: true } });
    expect(rows.gym).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false, smtpConfig: null });
    expect(rows.devices).toHaveLength(1); expect(rows.devices[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(sandbox.kioskToken);
    expect(rows.programs.length).toBeGreaterThan(0); expect(rows.ranks.some((rank) => rank.color !== null)).toBe(true);
    expect(rows.roles.map((row) => row.role).sort()).toEqual(['coach', 'owner']); expect(rows.users).toHaveLength(1);
    await f.seed({ gymId: sandbox.gymId, timezone: 'UTC', enabledModules: new Set() });
    expect((await db.forGym(sandbox.gymId, (tx) => tx.select().from(programs))).length).toBe(rows.programs.length);
  });
  it('uses the real auth service for host-only sessions that fail on the other sandbox', async () => {
    const f = fixture(), a = await f.service.create(), b = await f.service.create();
    for (const role of ['owner', 'coach', 'student'] as const) {
      const response = await f.service.login(a.gymId, role, '192.0.2.50');
      expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(role === 'student' ? '/portal' : '/admin');
      const cookie = response.headers.get('set-cookie')!;
      expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).not.toMatch(/domain=/i);
      const auth = authFactory({ config: authentication, sendMagicLink: async () => {} });
      const user = await accounts().findUserByEmail(demoEmail(a.gymId, role));
      const request = new Request(new URL('/api/auth/get-session', a.origin), { headers: { cookie: cookies(response) } });
      expect(await auth.bind({ gymId: a.gymId, origin: a.origin, clientIp: '192.0.2.50' }).getSession(request)).toEqual({ userId: user!.id });
      expect(await auth.bind({ gymId: b.gymId, origin: b.origin, clientIp: '192.0.2.50' }).getSession(request)).toBeNull();
    }
  });
  it('returns 404 on creation and one-click login outside demo mode, before validation', async () => {
    const { app } = appFor(disabledRoutes, infraContractGyms.a, 'anonymous');
    expect((await post(app, '/api/demo/sandboxes')).status).toBe(404);
    expect((await post(app, '/api/demo/login', { arbitrary: true })).status).toBe(404);
    await expect(fixture({ enabled: false }).service.create()).rejects.toMatchObject({ code: 'not_found' });
  });
  it('limits creation per trusted client address and does not trust spoofed forwarding headers', async () => {
    const f = fixture(), create = vi.spyOn(f.service, 'create').mockResolvedValue({ gymId: infraContractGyms.a, origin: 'https://one.demo.example.test', expiresAt: '2026-10-23T16:00:00.000Z', kioskToken: 'once' });
    const routes = createDemoRoutes(f.service, { installOrigin: 'https://demo.example.test', clientIp: { peerAddress: () => '192.0.2.10' } });
    const { app } = appFor(routes, infraContractGyms.a, 'anonymous');
    for (let i = 0; i < 3; i++) expect((await post(app, '/api/demo/sandboxes', {}, { 'x-forwarded-for': '192.0.2.' + i })).status).toBe(201);
    expect((await post(app, '/api/demo/sandboxes')).status).toBe(429); expect(create).toHaveBeenCalledTimes(3);
  });
  it('does not expire a fresh sandbox or an ordinary gym; expires a sandbox at exactly 24 hours', async () => {
    const f = fixture(), sandbox = await f.service.create();
    await f.service.expire(infraContractGyms.a); await f.service.expire(sandbox.gymId); expect(f.cleaned).not.toHaveBeenCalled();
    f.time.advance(24 * 60 * 60 * 1000);
    await expect(f.service.status(sandbox.gymId)).rejects.toMatchObject({ code: 'not_found' });
    await f.service.expire(sandbox.gymId); expect(f.cleaned).toHaveBeenCalledWith(sandbox.gymId);
    expect(await db.forSystem((tx) => tx.select().from(gyms).where(eq(gyms.id, sandbox.gymId)))).toEqual([]);
    await f.service.expire(sandbox.gymId);
  });
  it('removes every gym-owned row, including system rows, without touching the other gym', async () => {
    const f = fixture(), a = await f.service.create(), b = await f.service.create();
    const excluded = new Set(['gyms', 'authUser', 'authAccount', 'authVerification', 'authRateLimit', 'backupRuns']);
    for (const name of factoryTableNames) if (!excluded.has(name)) await factory(name, a.gymId);
    await f.deletion.remove(a.gymId, 1);
    const tables = await db.app.sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'gym_id'`;
    await db.system.sql.begin(async (query) => {
      // System context reaches system rows; gym context reaches tenant rows.
      // Both are needed for a complete deletion check with the restricted app role.
      await query`select set_config('app.gym_id', ${a.gymId}, true)`;
      for (const table of tables) {
        const rows = await query`select 1 from ${query(String(table.table_name))} where gym_id = ${a.gymId}`;
        expect(rows, String(table.table_name)).toHaveLength(0);
      }
    });
    expect(await f.service.status(b.gymId)).toHaveProperty('expiresAt');
    expect(await db.forSystem((tx) => tx.select().from(gymDomains).where(eq(gymDomains.gymId, a.gymId)))).toHaveLength(0);
  });
  it('suspends before storage deletion and permits retry after a storage failure', async () => {
    const f = fixture(), a = await f.service.create();
    const removeUploads = vi.fn(async () => { expect((await db.forGym(a.gymId, (tx) => tx.select().from(gyms)))[0]!.status).toBe('suspended'); throw new Error('storage down'); });
    const deletion = createGymDeleteService({ scope: db.forGym, system: db.forSystem, clock: f.time, removeUploads });
    await expect(deletion.remove(a.gymId, 1)).rejects.toThrow('storage down');
    await expect(f.service.status(a.gymId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.deletion.remove(a.gymId, 1)).rejects.toHaveProperty('name', 'RevisionConflictError');
    await f.deletion.remove(a.gymId, 2);
  });
  it('refuses encrypted live keys already stored in a gym', async () => {
    const id = uuidv7(); await factory('gyms', id, { stripeConfig: encryptSecret(key, 'stripe_config', JSON.stringify({ secretKey: 'rk_live_private' })) });
    await expect(verifyDemoStoredKeys(key, db.forSystem)).rejects.toThrow(/live/);
    await db.forGym(id, (tx) => tx.update(gyms).set({ stripeConfig: null }).where(eq(gyms.id, id)));
  });
});

describe('outbox isolation, permissions, and external boundaries', () => {
  it('writes messages and audits in the same gym and never calls SMTP, even if it is configured', async () => {
    const smtp = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockRejectedValue(new Error('SMTP must not be called'));
    const id = infraContractGyms.b;
    await db.forGym(infraContractGyms.a, (tx) => tx.update(gyms).set({ smtpConfig: encryptSecret(key, 'smtp_config', JSON.stringify({ host: 'smtp.example.test', password: 'secret' })) }).where(eq(gyms.id, infraContractGyms.a)));
    await factory('emailOutbox', id, { subject: 'Other gym private message' });
    const mail = new OutboxEmail(infraContractGyms.a, clock(), db.forGym);
    const result = await mail.sendEmail({ to: 'member@example.test', subject: 'Only local', html: '<p>local</p>', text: 'local' });
    expect(result.status).toBe('sent'); expect(smtp).not.toHaveBeenCalled(); smtp.mockRestore();
    const rows = await createOutboxQuery(db.forGym).list(infraContractGyms.a, {});
    expect(rows.data.some((row) => row.subject === 'Only local')).toBe(true);
    expect(rows.data.some((row) => row.subject === 'Other gym private message')).toBe(false);
    expect((await db.forGym(infraContractGyms.a, (tx) => tx.select().from(auditEvents))).some((audit) => audit.action === 'demo.email_captured')).toBe(true);
    await expect(runInTransaction(() => mail.sendEmail({ to: 'x', subject: 'x', html: 'x', text: 'x' }))).rejects.toThrow(/transaction/i);
  });
  it.each(roleNames)('checks the outbox allow/deny policy for %s on list and detail', async (role) => {
    const f = fixture(), a = await f.service.create();
    const mail = await factory('emailOutbox', a.gymId);
    const { app } = appFor(createDemoRoutes(f.service, { installOrigin: 'https://demo.example.test', outbox: createOutboxQuery(db.forGym) }), a.gymId, role);
    for (const path of ['/api/demo/outbox', '/api/demo/outbox/' + mail.id]) expect((await app.request(path)).status).toBe(role === 'owner' || role === 'admin' ? 200 : 403);
  });
  it('never returns the other sandbox’s message and rejects anonymous outbox access', async () => {
    const f = fixture(), a = await f.service.create(), b = await f.service.create(), secret = await factory('emailOutbox', b.gymId);
    const routes = createDemoRoutes(f.service, { installOrigin: 'https://demo.example.test', outbox: createOutboxQuery(db.forGym) });
    const { app } = appFor(routes, a.gymId);
    expect((await app.request('/api/demo/outbox/' + secret.id)).status).toBe(404);
    expect(JSON.stringify(await (await app.request('/api/demo/outbox')).json())).not.toContain(secret.id);
    expect((await appFor(routes, a.gymId, 'anonymous').app.request('/api/demo/outbox')).status).toBe(401);
    expect((await post(app, '/api/demo/login', { role: 'owner', gymId: b.gymId })).status).toBe(400);
  });
  it('blocks uploads before touching storage and clears only the chosen gym prefix', async () => {
    const store = new FakeBackupObjectStore(clock()), a = infraContractGyms.a, b = infraContractGyms.b;
    const uploads = new FakeUploads(a), put = vi.spyOn(uploads, 'put');
    await expect(demoUploads(uploads).put(a + '/photo', new Uint8Array([1]), 'image/png')).rejects.toMatchObject({ code: 'forbidden' });
    expect(put).not.toHaveBeenCalled();
    const bytes = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
    await store.putObject(a + '/photo', bytes()); await store.putObject(b + '/photo', bytes());
    await createUploadPrefixCleaner(store)(a);
    expect(await store.headObject(a + '/photo')).toBeNull(); expect(await store.headObject(b + '/photo')).not.toBeNull();
  });
  it('renders demo email with escaped link markup', async () => {
    const output = await renderDemoLogin('https://demo.example.test/?x="<script>', createTranslator({ 'demo/demo': { loginSubject: 'Sign in', loginLink: 'Open' } }));
    expect(output.html).not.toContain('<script>'); expect(output.subject).toBe('Sign in');
  });
});

it.each(roleNames)('restricts gym deletion to the owner for %s', async (role) => {
  const f = fixture(), a = await f.service.create(), remove = vi.fn(async () => {});
  const { app } = appFor(createGymDeleteRoutes({ remove }), a.gymId, role);
  const response = await app.request('/api/settings/gym', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, confirmation: 'DELETE' }) });
  expect(response.status).toBe(role === 'owner' ? 200 : 403); expect(remove).toHaveBeenCalledTimes(role === 'owner' ? 1 : 0);
});
it('exposes an idempotent seed command and rejects missing gym IDs', async () => {
  const f = fixture(), a = await f.service.create(), command = createSeedCommand(db.forGym, f.seed), io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await command.run([], io)).toBe(2); expect(await command.run([a.gymId], io)).toBe(0); expect(await command.run([a.gymId], io)).toBe(0);
});

it('runs cleanup as a deduplicated install job, including suspended and unfinished reservations', async () => {
  const f = fixture(), sandbox = await f.service.create();
  await db.forGym(sandbox.gymId, (tx) => tx.update(gyms).set({ status: 'suspended' }).where(eq(gyms.id, sandbox.gymId)));
  const expire = vi.spyOn(f.service, 'expire').mockResolvedValue();
  const queue = new PostgresJobs({ database: db, clock: f.time });
  const cleanup = registerDemoCleanup(queue, { config, service: f.service, clock: f.time, system: db.forSystem });
  await cleanup.scheduleDue(); await cleanup.scheduleDue();
  expect(await queue.runNext()).toBe(true); expect(await queue.runNext()).toBe(false);
  expect(expire).toHaveBeenCalledWith(sandbox.gymId); expect(expire).not.toHaveBeenCalledWith(infraContractGyms.a);
});
it('preserves a different gym when a deletion request tries to inject its ID', async () => {
  const f = fixture(), a = await f.service.create(), b = await f.service.create(), remove = vi.fn(async () => {});
  const { app } = appFor(createGymDeleteRoutes({ remove }), a.gymId);
  expect((await app.request('/api/settings/gym', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, confirmation: 'DELETE', gymId: b.gymId }) })).status).toBe(400);
  expect(remove).not.toHaveBeenCalled(); expect(await f.service.status(b.gymId)).toHaveProperty('expiresAt');
});
it('returns the session cookie through the registered login route and rejects cookie-based cross-origin login', async () => {
  const f = fixture(), a = await f.service.create();
  const routes = createDemoRoutes(f.service, { installOrigin: a.origin, clientIp: { peerAddress: () => '192.0.2.70' } });
  const { app } = appFor(routes, a.gymId, 'anonymous', a.origin);
  const response = await post(app, '/api/demo/login', { role: 'owner' });
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('HttpOnly'); expect(await response.json()).toEqual({ data: { redirect: '/admin' } });
  expect((await post(app, '/api/demo/login', { role: 'coach' }, { cookie: cookies(response), origin: 'https://evil.example.test' })).status).toBe(403);
});
it('rolls back failed sandbox provisioning and reuses its capacity slot', async () => {
  const f = fixture(), seed = vi.fn(async () => { throw new Error('seed failed'); });
  const failing = createDemoService({ config, key, clock: f.time, deletion: f.deletion, identities: f.identities, scope: db.forGym, system: db.forSystem, seed });
  await expect(failing.create()).rejects.toThrow('seed failed'); expect(f.cleaned).toHaveBeenCalledTimes(1);
  expect(await f.service.create()).toHaveProperty('gymId');
});
