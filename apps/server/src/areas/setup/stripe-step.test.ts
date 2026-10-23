// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { canStaff, staffRoles } from '@plaingym/shared';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { errorHandler, respondError } from '../../core/errors.js';
import { decryptSecret } from '../../core/secrets.js';
import { createStripeStep } from './stripe-step.js';
import { createStripeStepRoutes } from './stripe-step.routes.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-23T12:00:00Z');
const gymId = uuidv7(), otherGym = uuidv7(), key = Buffer.alloc(32, 5);
let ownerId: string;
const checks: string[] = [];
const service = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym,
  provisioner: () => ({ async validate() { assertNoTransaction('payments.validate'); checks.push('validate'); },
    async register(gym, origin) { assertNoTransaction('payments.register'); checks.push(gym + origin); return { endpointId: 'we_fixture', webhookSecret: 'fixture-signing-secret' }; } }) });
beforeAll(async () => {
  ownerId = (await factory('authUser', gymId)).id;
  for (const id of [gymId, otherGym]) await factory('gyms', id, { settings: { setup: { ownerId, completed: false, completedSteps: [0, 1, 2, 3, 4, 5] } } });
});
function app(principal: Principal, resolvedGym = gymId) {
  const server = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, c) => { if (!result.success) return respondError(c, result.error); } });
  server.onError(errorHandler);
  server.use('*', async (c, next) => { c.set('context', { requestId: 'test', principal, gym: { gymId: resolvedGym, timezone: 'UTC', enabledModules: new Set() }, clock }); await next(); });
  for (const entry of createStripeStepRoutes(service)) entry.mount(server, (permission) => async (c, next) => {
    if (principal.kind === 'anonymous') return c.json({}, 401);
    if (permission.kind !== 'staff' || principal.kind !== 'staff' || !canStaff(principal.roles, permission.capability)) return c.json({}, 403);
    await next();
  });
  return server;
}
const request = (server: ReturnType<typeof app>, body: unknown) => server.request('/api/setup/stripe', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
it.each(staffRoles)('declares and enforces integration permissions for %s', async (role) => {
  const response = await request(app({ kind: 'staff', userId: ownerId, gymId, roles: [role] }), {});
  expect(response.status).toBe(role === 'owner' ? 400 : 403);
});
it('denies anonymous and cross-gym callers before any provider request', async () => {
  expect((await request(app({ kind: 'anonymous' }), {})).status).toBe(401);
  const input = { choice: 'configure', revision: 1, restrictedKey: 'rk_test_SYNTHETIC' };
  expect((await request(app({ kind: 'staff', userId: ownerId, gymId, roles: ['owner'] }, otherGym), input)).status).toBe(404);
  expect(checks).toEqual([]);
});
it('validates outside transactions, encrypts both secrets, audits, and advances the wizard', async () => {
  const response = await request(app({ kind: 'staff', userId: ownerId, gymId, roles: ['owner'] }),
    { choice: 'configure', revision: 1, restrictedKey: 'rk_test_SYNTHETIC' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { configured: true, mode: 'test', webhookRegistered: true, revision: 2 } });
  const [gym] = await database.forGym(gymId, (tx) => tx.select().from(gyms));
  expect(gym!.stripeConfig).not.toContain('rk_test_');
  expect(JSON.parse(decryptSecret(key, 'stripe_config', gym!.stripeConfig!))).toEqual({ apiKey: 'rk_test_SYNTHETIC', endpointId: 'we_fixture', webhookSecret: 'fixture-signing-secret', mode: 'test' });
  expect(gym!.settings).toMatchObject({ setup: { completedSteps: [0, 1, 2, 3, 4, 5, 6] } });
  const audits = await database.forGym(gymId, (tx) => tx.select().from(auditEvents));
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits)).not.toMatch(/rk_test_|fixture-signing-secret/);
});
it('rejects stale revisions and demo-mode live keys before network I/O', async () => {
  const context = { gymId, actor: { kind: 'user', userId: ownerId } } as const, count = checks.length;
  await expect(service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_SYNTHETIC' })).rejects.toThrow();
  vi.stubEnv('DEMO_MODE', 'true');
  try { await expect(service.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_live_SYNTHETIC' })).rejects.toMatchObject({ code: 'invalid_request' }); }
  finally { vi.unstubAllEnvs(); }
  expect(checks.length).toBe(count);
});
it('does not save credentials if the revision changes while registering the endpoint', async () => {
  const racing = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym,
    provisioner: () => ({ async validate() {}, async register() {
      await database.forGym(otherGym, (tx) => tx.update(gyms).set({ revision: 2 }).where(eq(gyms.id, otherGym)));
      return { endpointId: 'we_race', webhookSecret: 'fixture-race-secret' };
    } }) });
  await expect(racing.configure({ gymId: otherGym, actor: { kind: 'user', userId: ownerId } },
    { choice: 'configure', revision: 1, restrictedKey: 'rk_test_SYNTHETIC' })).rejects.toThrow();
  expect((await database.forGym(otherGym, (tx) => tx.select().from(gyms)))[0]!.stripeConfig).toBeNull();
});
