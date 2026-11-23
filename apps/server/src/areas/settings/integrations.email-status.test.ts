// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { integrationsResponseSchema } from '@plaingym/shared/contracts';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from '../staff/auth.permissions.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { authConfig } from '../../infra/auth/config.js';
import { DeliveryError } from '../../infra/email/index.js';
import { createEmailStatusRecorder } from './email-status.js';
import { createIntegrationsService } from './integrations.js';
import { createIntegrationsRoutes } from './integrations.routes.js';
import { encryptSmtpConfig } from './smtp.js';

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

function server(gymId: string, userId: string) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId, userId, roles: ['owner'] }, clock, requestId: 'test' }); await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createIntegrationsRoutes(service) }).mount(app, authorize, new Set());
  return app;
}
async function read(gymId: string, userId: string) {
  const response = await server(gymId, userId).request('/api/settings/integrations');
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toMatch(/smtp-password-never-shown|5\.7\.8|Authentication failed/);
  return integrationsResponseSchema.parse(JSON.parse(text)).data.email;
}

describe('the last send failure in Settings → Integrations → Email', () => {
  it('shows the gym\'s last failure until a send works, and never another gym\'s', async () => {
    expect((await read(gymA, ownerA)).lastSendFailure).toBeNull();
    clock.advance(1000);
    const at = clock.now().toISOString();
    await recorder(gymA, smtp)({ ok: false, error: new DeliveryError('not_accepted', 'SMTP authentication failed',
      { cause: { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed' } }) });
    expect((await read(gymA, ownerA)).lastSendFailure).toEqual({ failure: 'authentication', at });
    expect((await read(gymB, ownerB)).lastSendFailure).toBeNull();
    clock.advance(1000);
    await recorder(gymA, smtp)({ ok: true });
    expect((await read(gymA, ownerA)).lastSendFailure).toBeNull();
    expect((await read(gymB, ownerB)).lastSendFailure).toBeNull();
  });
});
