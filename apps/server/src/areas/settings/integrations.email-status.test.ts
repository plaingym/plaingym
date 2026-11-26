// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { integrationsResponseSchema } from '@plaingym/shared/contracts';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from '../staff/auth.permissions.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { authConfig } from '../../infra/auth/config.js';
import { SmtpDeliveryError } from '../../infra/email/smtp.js';
import { createEmailStatusRecorder } from './email-status.js';
import { createIntegrationsService } from './integrations.js';
import { createIntegrationsRoutes } from './integrations.routes.js';
import { encryptSmtpConfig, installSmtpFingerprint } from './smtp.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-11-21T09:00:00Z');
const key = Buffer.alloc(32, 7);
const env = { AUTH_SECRET: 'integration-settings-secret-with-32-characters', TENANCY: 'single', AUTH_PASSWORD_LOGIN: 'auto' };
const smtp = { host: 'smtp.gym.invalid', port: 587, security: 'starttls', from: 'desk@gym.invalid', username: 'gym-user', password: 'smtp-password-never-shown' } as const;
const service = createIntegrationsService({ key, env, config: authConfig(env, false), origin: async () => 'https://gym.invalid', hasPassword: async () => true,
  clock, scope: database.forGym, sendTest: vi.fn(async () => undefined) });
const recorder = createEmailStatusRecorder({ scope: database.forGym, clock });
const gymA = uuidv7(), gymB = uuidv7();
let ownerA: string, ownerB: string;
beforeAll(async () => {
  await factory('gyms', gymA, { smtpConfig: encryptSmtpConfig(key, gymA, smtp) });
  await factory('gyms', gymB, { smtpConfig: encryptSmtpConfig(key, gymB, smtp) });
  ownerA = (await factory('authUser', gymA)).id;
  ownerB = (await factory('authUser', gymB)).id;
});

// The same gym settings with the install's `SMTP_*` set too.
const installEnv = { ...env, SMTP_HOST: 'smtp.install.invalid', SMTP_FROM: 'noreply@install.invalid', SMTP_USER: 'install-user', SMTP_PASS: 'install-password-never-shown' };
const installService = createIntegrationsService({ key, env: installEnv, config: authConfig(installEnv, true), origin: async () => 'https://gym.invalid',
  hasPassword: async () => true, clock, scope: database.forGym, sendTest: vi.fn(async () => undefined) });
const refused = () => ({ ok: false as const, error: new SmtpDeliveryError('not_accepted', 'SMTP authentication failed',
  { cause: { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' } }) });
async function gymWithOwner(storedSmtp?: (gymId: string) => string) {
  const gymId = uuidv7();
  await factory('gyms', gymId, storedSmtp ? { smtpConfig: storedSmtp(gymId) } : {});
  return { gymId, owner: (await factory('authUser', gymId)).id };
}

function server(gymId: string, userId: string, integrations = service) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId, userId, roles: ['owner'] }, clock, requestId: 'test' }); await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createIntegrationsRoutes(integrations) }).mount(app, authorize, new Set());
  return app;
}
async function read(gymId: string, userId: string, integrations = service) {
  const response = await server(gymId, userId, integrations).request('/api/settings/integrations');
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toMatch(/smtp-password-never-shown|install-password-never-shown|5\.7\.8|Authentication failed/);
  return integrationsResponseSchema.parse(JSON.parse(text)).data.email;
}

describe('the last send failure in Settings → Integrations → Email', () => {
  it('shows the gym\'s last failure until a send works, and never another gym\'s', async () => {
    expect((await read(gymA, ownerA)).lastSendFailure).toBeNull();
    clock.advance(1000);
    const at = clock.now().toISOString();
    await recorder(gymA, { ...smtp, source: 'gym' })({ ok: false, error: new SmtpDeliveryError('not_accepted', 'SMTP authentication failed',
      { cause: { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' } }) });
    expect((await read(gymA, ownerA)).lastSendFailure).toEqual({ failure: 'authentication', at });
    expect((await read(gymB, ownerB)).lastSendFailure).toBeNull();
    clock.advance(1000);
    await recorder(gymA, { ...smtp, source: 'gym' })({ ok: true });
    expect((await read(gymA, ownerA)).lastSendFailure).toBeNull();
    expect((await read(gymB, ownerB)).lastSendFailure).toBeNull();
  });
  it('shows a failure only while mail goes through the settings it failed on', async () => {
    // The gym's stored value can no longer be read (restored under another key), so mail goes through the install's.
    const unreadable = await gymWithOwner((gymId) => encryptSmtpConfig(Buffer.alloc(32, 9), gymId, smtp));
    clock.advance(1000);
    await recorder(unreadable.gymId, { ...smtp, source: 'gym' })(refused());
    const section = await read(unreadable.gymId, unreadable.owner, installService);
    expect(section).toMatchObject({ source: 'install', unreadable: true, lastSendFailure: null });

    // A failure through the install's settings while they are in use, after a restart with the same settings.
    const installed = await gymWithOwner();
    clock.advance(1000);
    const at = clock.now().toISOString();
    await createEmailStatusRecorder({ scope: database.forGym, clock, installSince: new Date(0), installSettings: installSmtpFingerprint(key, installEnv) })(
      installed.gymId, { ...smtp, source: 'install' })(refused());
    expect(await read(installed.gymId, installed.owner, installService)).toMatchObject({ source: 'install', lastSendFailure: { failure: 'authentication', at } });
  });
  it('shows no failure recorded without a source when no settings are in use', async () => {
    const sourceless = (gymId: string) => database.forGym(gymId, (tx) => writeAudit(tx, { gymId, actorKind: 'system', action: 'email.delivery_failed',
      targetType: 'gym', targetId: gymId, after: { failure: 'authentication' }, occurredAt: clock.now() }));
    const none = await gymWithOwner();
    clock.advance(1000);
    await sourceless(none.gymId);
    expect(await read(none.gymId, none.owner)).toMatchObject({ source: 'none', lastSendFailure: null });
    // Such a row reads as one through the gym's settings, so it shows while those are in use.
    const own = await gymWithOwner((gymId) => encryptSmtpConfig(key, gymId, smtp));
    clock.advance(1000);
    await sourceless(own.gymId);
    expect(await read(own.gymId, own.owner)).toMatchObject({ source: 'gym', lastSendFailure: { failure: 'authentication' } });
  });
});
