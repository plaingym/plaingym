// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { integrationsResponseSchema, saveEmailIntegrationResponseSchema } from '@plaingym/shared/contracts';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import type { RequestEnvironment } from '../../core/context.js';
import { gymIntegrationsEditable } from '../../core/tenancy.js';
import { authConfig } from '../../infra/auth/config.js';
import { DeliveryError, SmtpEmail, type EmailMessage, type SmtpConfig } from '../../infra/email/index.js';
import { captureSmtp } from '../../infra/email/test-smtp.js';
import { authorize } from '../staff/auth.permissions.js';
import { createIntegrationsService, type IntegrationsOptions } from './integrations.js';
import { createIntegrationsRoutes } from './integrations.routes.js';
import { createSmtpResolver, encryptSmtpConfig } from './smtp.js';

const database = useTestDatabase(), factory = createFactories(database);
const key = Buffer.alloc(32, 9), origin = 'https://gym.invalid';
const common = { AUTH_SECRET: 'multi-integration-settings-secret-32-characters', SMTP_HOST: 'smtp.install.invalid', SMTP_FROM: 'install@example.test' };
const singleEnv = { ...common, TENANCY: 'single', AUTH_PASSWORD_LOGIN: 'auto' };
const operatorEnv = { ...common, TENANCY: 'multi', AUTH_PASSWORD_LOGIN: 'off' };
const gymEnv = { ...operatorEnv, GYM_INTEGRATIONS: 'gym' };
const gymA = uuidv7(), gymB = uuidv7(), gymC = uuidv7();
const stored = { host: 'smtp.gym.invalid', port: 587, security: 'starttls', from: 'desk@gym.invalid', username: 'gym-user', password: 'gym-password' } as const;
let ownerA: string, ownerB: string;
/** Stands in for a server on the public internet: only this loopback address passes the check. */
const publicHere = '::1';
let reachable: Awaited<ReturnType<typeof captureSmtp>>, internal: Awaited<ReturnType<typeof captureSmtp>>;
let answers: string[];
const lookup = vi.fn(async (_host: string) => answers);
const hostCheck = { lookup, isPublic: vi.fn((address: string) => address === publicHere) };
/** Real delivery through the config the service hands over; only the port and plain capture differ from production. */
const seenConfigs: SmtpConfig[] = [];
const sendTest = async (config: SmtpConfig, message: EmailMessage) => {
  seenConfigs.push(config);
  const email = new SmtpEmail({ ...config, security: 'plain', port: reachable.port }, { hostCheck });
  try { await email.verifyTestSend(message); } finally { email.close(); }
};
const service = (env: NodeJS.ProcessEnv, extra: Partial<IntegrationsOptions> = {}) => createIntegrationsService({ key, env, config: authConfig(env, true), origin: async () => origin,
  hasPassword: async () => false, scope: database.forGym, sendTest, ...extra });

function server(routesService: ReturnType<typeof createIntegrationsService>, options: { role?: StaffRole; gymId?: string; principalGym?: string; userId?: string } = {}) {
  const { role = 'owner', gymId = gymA, principalGym = gymId, userId = gymId === gymB ? ownerB : ownerA } = options;
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal: { kind: 'staff', gymId: principalGym, userId, roles: [role] },
      clock: { now: () => new Date('2026-11-06T12:00:00Z') }, requestId: 'test' } as never);
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createIntegrationsRoutes(routesService) }).mount(app, authorize, new Set());
  return app;
}
async function call(app: ReturnType<typeof server>, method: string, path: string, body?: unknown) {
  const response = await app.request('/api/settings/integrations' + path, { method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as { data: never; error?: { message?: string; details?: Record<string, string[]> } } };
}
const read = async (app: ReturnType<typeof server>) => integrationsResponseSchema.parse((await call(app, 'GET', '')).json).data;
const row = async (gymId = gymA) => (await database.forGym(gymId, (tx) => tx.select().from(gyms)))[0]!;
const email = (revision: number, overrides: Record<string, unknown> = {}) => ({ revision, host: 'mail.gym.example', port: 587, secure: false,
  username: 'gym-user', password: 'gym-password', from: 'desk@gym.invalid', testTo: 'owner@gym.invalid', ...overrides });
const saveEmail = async (app: ReturnType<typeof server>, overrides: Record<string, unknown> = {}) => {
  const result = await call(app, 'PUT', '/email', email((await read(app)).revision, overrides));
  return { status: result.status, test: saveEmailIntegrationResponseSchema.parse(result.json).data.test };
};

beforeAll(async () => {
  await factory('gyms', gymA, { name: 'Gym A' });
  await factory('gyms', gymB, { name: 'Gym B' });
  await factory('gyms', gymC, { name: 'Gym C', smtpConfig: encryptSmtpConfig(key, gymC, stored) });
  ownerA = (await factory('authUser', gymA)).id;
  ownerB = (await factory('authUser', gymB)).id;
  reachable = await captureSmtp(undefined, publicHere);
  internal = await captureSmtp();
});
afterAll(async () => { await reachable?.close(); await internal?.close(); });
beforeEach(async () => {
  answers = [publicHere]; lookup.mockClear(); seenConfigs.length = 0;
  hostCheck.isPublic.mockImplementation((address: string) => address === publicHere);
  await database.forGym(gymA, (tx) => tx.update(gyms).set({ smtpConfig: null, stripeConfig: null }).where(eq(gyms.id, gymA)));
});

describe('gymIntegrationsEditable', () => {
  it('is always true on a single-gym install, whatever the variable says', () => {
    for (const value of [undefined, '', 'operator', 'gym', 'nonsense'])
      expect(gymIntegrationsEditable('single', { GYM_INTEGRATIONS: value })).toBe(true);
  });
  it('defaults to read-only on a multi-gym install, and only `gym` allows changes', () => {
    expect(gymIntegrationsEditable('multi', {})).toBe(false);
    expect(gymIntegrationsEditable('multi', { GYM_INTEGRATIONS: '' })).toBe(false);
    expect(gymIntegrationsEditable('multi', { GYM_INTEGRATIONS: 'operator' })).toBe(false);
    expect(gymIntegrationsEditable('multi', { GYM_INTEGRATIONS: 'gym' })).toBe(true);
  });
  it('refuses to start on an unknown value', () => {
    expect(() => gymIntegrationsEditable('multi', { GYM_INTEGRATIONS: 'true' })).toThrow('Invalid GYM_INTEGRATIONS');
    expect(() => service({ ...operatorEnv, GYM_INTEGRATIONS: 'true' })).toThrow('Invalid GYM_INTEGRATIONS');
  });
});

describe('single-gym mode', () => {
  it('is unchanged: owners edit email, the variable has no effect and no host is checked', async () => {
    const record = async (config: SmtpConfig) => { seenConfigs.push(config); };
    for (const env of [singleEnv, { ...singleEnv, GYM_INTEGRATIONS: 'operator' }]) {
      const app = server(service(env, { sendTest: record }));
      expect((await read(app)).integrationsEditable).toBe(true);
      expect(await saveEmail(app)).toEqual({ status: 200, test: 'sent' });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(seenConfigs).toHaveLength(2);
    expect(seenConfigs.every((config) => !('publicHostOnly' in config))).toBe(true);
  });
});

describe('multi-gym mode, read-only (the default)', () => {
  const app = () => server(service(operatorEnv));
  it('reports the sections as read-only, keeping what they show', async () => {
    const status = await read(server(service(operatorEnv), { gymId: gymB }));
    expect(status).toMatchObject({ integrationsEditable: false, sandbox: false, backups: null, email: { source: 'install', host: null }, payments: { configured: false } });
  });
  it('refuses every email and payments change with a plain 403, and neither connects nor saves', async () => {
    const audits = () => database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, gymA)));
    const before = await row(), revision = before.revision, audited = await audits();
    for (const [method, path, body] of [['PUT', '/email', email(revision)], ['DELETE', '/email', { revision }],
      ['PUT', '/stripe', { revision, restrictedKey: 'rk_test_readonly' }]] as const) {
      const result = await call(app(), method, path, body);
      expect(result.status, method + ' ' + path).toBe(403);
      expect(result.json.error).toMatchObject({ message: 'This install’s operator manages email and payments', details: { integrations: ['operator_managed'] } });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(await row()).toEqual(before);
    expect(await audits()).toEqual(audited);
  });
  it('keeps the sandbox’s own refusal in demo mode', async () => {
    const sandbox = server(service(operatorEnv, { sandbox: true }));
    const status = await read(sandbox);
    expect(status).toMatchObject({ sandbox: true, integrationsEditable: false });
    const result = await call(sandbox, 'PUT', '/email', email(status.revision));
    expect(result.status).toBe(403);
    expect(result.json.error?.message).toBe('A sandbox uses the demo’s own email and payments');
  });
  it.each(staffRoles)('still answers only owners (%s)', async (role) => {
    const denied = server(service(operatorEnv), { role }), owner = role === 'owner';
    expect((await call(denied, 'GET', '')).status).toBe(owner ? 200 : 403);
  });
});

describe('multi-gym mode, with gym-managed settings allowed', () => {
  const app = () => server(service(gymEnv));
  it('reports the sections as editable', async () => {
    expect((await read(app())).integrationsEditable).toBe(true);
  });
  it('accepts a host that resolves to a public address, marks it for every later send and connects to the address it checked', async () => {
    const before = reachable.messages.length;
    expect(await saveEmail(app())).toEqual({ status: 200, test: 'sent' });
    expect(seenConfigs).toEqual([expect.objectContaining({ host: 'mail.gym.example', publicHostOnly: true })]);
    expect(reachable.messages).toHaveLength(before + 1);
    expect(internal.connections).toBe(0);
    expect((await row()).smtpConfig).toBeTruthy();
  });
  it.each([['private', '10.0.0.5'], ['private', '192.168.1.1'], ['loopback', '127.0.0.1'], ['loopback', '::1'], ['link-local', '169.254.169.254'], ['link-local', 'fe80::1'],
    ['IPv4-mapped IPv6', '::ffff:127.0.0.1'], ['IPv4-mapped IPv6', '::ffff:10.0.0.5']])('refuses a host resolving to a %s address (%s) and saves nothing', async (_kind, address) => {
    answers = [address];
    hostCheck.isPublic.mockReturnValue(false);
    const before = await row(), connections = internal.connections + reachable.connections;
    expect(await saveEmail(app())).toEqual({ status: 200, test: 'failed' });
    expect(internal.connections + reachable.connections).toBe(connections);
    expect(await row()).toEqual(before);
  });
  it('refuses a host when any of its addresses is private, even with a public one first', async () => {
    answers = [publicHere, '10.0.0.5'];
    const connections = reachable.connections;
    expect(await saveEmail(app())).toEqual({ status: 200, test: 'failed' });
    expect(reachable.connections).toBe(connections);
    expect((await row()).smtpConfig).toBeNull();
  });
  it('answers a refused host and a name that doesn’t resolve the same way', async () => {
    answers = ['10.0.0.5'];
    const refused = await saveEmail(app());
    lookup.mockImplementationOnce(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); });
    expect(await saveEmail(app())).toEqual(refused);
  });
  it('keeps the port allowlist', async () => {
    const result = await call(app(), 'PUT', '/email', email((await read(app())).revision, { port: 5432 }));
    expect(result.status).toBe(400);
    expect(result.json.error?.details).toEqual({ port: ['port_not_allowed'] });
    expect(lookup).not.toHaveBeenCalled();
  });
  it('still answers only owners, and an owner of another gym changes nothing', async () => {
    for (const role of staffRoles) {
      const result = await call(server(service(gymEnv), { role }), 'PUT', '/stripe', {});
      expect(result.status, role).toBe(role === 'owner' ? 400 : 403);
    }
    const before = await row(gymB);
    const cross = server(service(gymEnv), { gymId: gymB, principalGym: gymA, userId: ownerA });
    for (const [method, path, body] of [['GET', '', undefined], ['PUT', '/email', email(before.revision)], ['DELETE', '/email', { revision: before.revision }],
      ['PUT', '/stripe', { revision: before.revision, restrictedKey: 'rk_test_crossgym' }]] as const)
      expect((await call(cross, method, path, body)).status, method + ' ' + path).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(await row(gymB)).toEqual(before);
  });
});

describe('real sends through a gym’s stored settings', () => {
  const message = { to: 'member@example.test', subject: 'Receipt', html: '<p>Receipt</p>', text: 'Receipt' };
  it('marks a gym’s own server on a multi-gym install under either setting, and never the install’s or a single-gym install’s', async () => {
    for (const env of [operatorEnv, gymEnv]) {
      const smtp = createSmtpResolver({ key, env, scope: database.forGym });
      expect(await smtp.config(gymC)).toMatchObject({ host: stored.host, publicHostOnly: true });
      expect(await smtp.config(gymB)).toMatchObject({ host: common.SMTP_HOST });
      expect(await smtp.config(gymB)).not.toHaveProperty('publicHostOnly');
    }
    expect(await createSmtpResolver({ key, env: singleEnv, scope: database.forGym }).config(gymC)).not.toHaveProperty('publicHostOnly');
  });
  it('refuses a stored host that now resolves to a private address, before connecting', async () => {
    const config = await createSmtpResolver({ key, env: operatorEnv, scope: database.forGym }).config(gymC);
    answers = ['127.0.0.1'];
    const sender = new SmtpEmail({ ...config!, security: 'plain', port: internal.port }, { hostCheck }), connections = internal.connections;
    try {
      const failure = await sender.sendEmail(message).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeliveryError);
      expect(failure).toMatchObject({ acceptance: 'not_accepted' });
      expect(internal.connections).toBe(connections);
    } finally { sender.close(); }
  });
});
