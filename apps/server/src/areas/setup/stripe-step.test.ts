// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
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
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { STRIPE_API_VERSION, STRIPE_EVENTS } from '../../infra/payments/stripe.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { StripePermissionError, stripeProvisioner } from '../../infra/payments/setup.js';
import type { ObjectData, PaymentTransport } from '../../infra/payments/transport.js';
import { setLogSink } from '../../core/log.js';
import { createStripeStep, type StripeConfig, type StripeProvisioner } from './stripe-step.js';
import { createStripeStepRoutes } from './stripe-step.routes.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-23T12:00:00Z');
const gymId = uuidv7(), otherGym = uuidv7(), key = Buffer.alloc(32, 5);
let ownerId: string;
const checks: string[] = [];
/** One synthetic Stripe account per key, unless a test points several keys at the same account. */
const accounts = new Map<string, StripeFixtures>();
const account = (apiKey: string) => { if (!accounts.has(apiKey)) accounts.set(apiKey, new StripeFixtures(gymId, undefined, accounts.size * 1000)); return accounts.get(apiKey)!; };
const provisioner = (apiKey: string): StripeProvisioner => {
  const real = stripeProvisioner(account(apiKey));
  return { ...real,
    async validate() { assertNoTransaction('payments.validate'); checks.push('validate'); return real.validate(); },
    async register(gym, origin, revision, previous) { checks.push(gym + origin); return real.register(gym, origin, revision, previous); } };
};
const service = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym, provisioner });
const endpointsIn = (apiKey: string) => [...account(apiKey).objects.values()].filter((object) => object.object === 'webhook_endpoint');
const url = 'https://gym.invalid/webhooks/stripe';
async function newGym() {
  const id = uuidv7();
  await factory('gyms', id, { settings: { setup: { ownerId, completed: false, completedSteps: [0, 1, 2, 3, 4, 5] } } });
  return { id, context: { gymId: id, actor: { kind: 'user', userId: ownerId } } as const };
}
const stored = async (id: string) => {
  const [gym] = await database.forGym(id, (tx) => tx.select().from(gyms));
  return gym!.stripeConfig ? JSON.parse(decryptSecret(key, { secretClass: 'stripe_config', owner: id }, gym!.stripeConfig)) as StripeConfig : null;
};
const revisionOf = async (id: string) => (await database.forGym(id, (tx) => tx.select().from(gyms)))[0]!.revision;
beforeAll(async () => {
  ownerId = (await factory('authUser', gymId)).id;
  for (const id of [gymId, otherGym]) await factory('gyms', id, { settings: { setup: { ownerId, completed: false, completedSteps: [0, 1, 2, 3, 4, 5] } } });
});
function app(principal: Principal, resolvedGym = gymId, step = service) {
  const server = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, c) => { if (!result.success) return respondError(c, result.error); } });
  server.onError(errorHandler);
  server.use('*', async (c, next) => { c.set('context', { requestId: 'test', principal, gym: { gymId: resolvedGym, timezone: 'UTC', enabledModules: new Set() }, clock }); await next(); });
  for (const entry of createStripeStepRoutes(step)) entry.mount(server, (permission) => async (c, next) => {
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
  expect(JSON.parse(decryptSecret(key, { secretClass: 'stripe_config', owner: gymId }, gym!.stripeConfig!))).toEqual({ apiKey: 'rk_test_SYNTHETIC', endpointId: 'we_1', webhookSecret: 'fixture-signing-secret', mode: 'test' });
  expect(gym!.settings).toMatchObject({ setup: { completedSteps: [0, 1, 2, 3, 4, 5, 6] } });
  const audits = await database.forGym(gymId, (tx) => tx.select().from(auditEvents));
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits)).not.toMatch(/rk_test_|fixture-signing-secret/);
});
it('rejects stale revisions and demo-mode live keys before network I/O', async () => {
  const context = { gymId, actor: { kind: 'user', userId: ownerId } } as const, count = checks.length;
  await expect(service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_SYNTHETIC' })).rejects.toThrow();
  const demo = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym, provisioner, demoMode: true });
  await expect(demo.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_live_SYNTHETIC' })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(checks.length).toBe(count);
});
it('does not save credentials if the revision changes while registering the endpoint', async () => {
  const racing = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym,
    provisioner: (apiKey) => ({ ...provisioner(apiKey), async register(gym, origin, revision, previous) {
      await database.forGym(otherGym, (tx) => tx.update(gyms).set({ revision: 2 }).where(eq(gyms.id, otherGym)));
      return stripeProvisioner(account(apiKey)).register(gym, origin, revision, previous);
    } }) });
  await expect(racing.configure({ gymId: otherGym, actor: { kind: 'user', userId: ownerId } },
    { choice: 'configure', revision: 1, restrictedKey: 'rk_test_SYNTHETIC' })).rejects.toThrow();
  expect((await database.forGym(otherGym, (tx) => tx.select().from(gyms)))[0]!.stripeConfig).toBeNull();
});

const tagged = (id: string) => ({ url, api_version: STRIPE_API_VERSION, enabled_events: [...STRIPE_EVENTS], metadata: { gym_id: id } });
const add = async (apiKey: string, params: Record<string, unknown>) =>
  (await account(apiKey).request({ method: 'POST', path: '/v1/webhook_endpoints', params: params as never })).id as string;
const ids = (apiKey: string) => endpointsIn(apiKey).map((endpoint) => endpoint.id);

it("keeps the stored endpoint and signing secret when the same key is saved again, and deletes only this gym's duplicates", async () => {
  const { id, context } = await newGym(), apiKey = 'rk_test_REUSE';
  await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: apiKey });
  const first = (await stored(id))!;
  const foreign = await add(apiKey, tagged('another-gym')), untagged = await add(apiKey, { ...tagged(id), metadata: {} });
  const elsewhere = await add(apiKey, { ...tagged(id), url: 'https://other-host.invalid/webhooks/stripe' });
  const duplicate = await add(apiKey, tagged(id));
  const second = await service.configure(context, { choice: 'configure', revision: 2, restrictedKey: apiKey });
  expect(second).toMatchObject({ configured: true, revision: 3 });
  expect(await stored(id)).toEqual(first);
  expect(ids(apiKey)).toEqual([first.endpointId, foreign, untagged, elsewhere]);
  const audits = await database.forGym(id, (tx) => tx.select().from(auditEvents));
  expect(audits.map((audit) => audit.after)).toEqual([expect.objectContaining({ endpointReused: false }), expect.objectContaining({ endpointReused: true })]);
  expect(JSON.stringify(audits)).not.toContain(first.webhookSecret);
  expect(duplicate).not.toBe(first.endpointId);
});
it('keeps the stored endpoint when a different key belongs to the same Stripe account, and updates its events', async () => {
  const { id, context } = await newGym();
  await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_FIRSTKEY' });
  const first = (await stored(id))!;
  accounts.set('rk_test_SECONDKEY', account('rk_test_FIRSTKEY'));
  await account('rk_test_FIRSTKEY').request({ method: 'POST', path: '/v1/webhook_endpoints/' + first.endpointId, params: { enabled_events: ['charge.refunded'] } });
  await service.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_test_SECONDKEY' });
  expect(await stored(id)).toEqual({ ...first, apiKey: 'rk_test_SECONDKEY' });
  expect(endpointsIn('rk_test_FIRSTKEY')).toHaveLength(1);
  expect([...endpointsIn('rk_test_FIRSTKEY')[0]!.enabled_events as string[]].sort()).toEqual([...STRIPE_EVENTS].sort());
});
it("creates a new endpoint when the stored one was deleted, without touching other gyms' endpoints", async () => {
  const { id, context } = await newGym(), apiKey = 'rk_test_GONE';
  await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: apiKey });
  const first = (await stored(id))!, foreign = await add(apiKey, tagged('another-gym'));
  await account(apiKey).request({ method: 'DELETE', path: '/v1/webhook_endpoints/' + first.endpointId });
  await service.configure(context, { choice: 'configure', revision: 2, restrictedKey: apiKey });
  const second = (await stored(id))!;
  expect(second.endpointId).not.toBe(first.endpointId);
  expect(second.webhookSecret).toBeTruthy();
  expect(ids(apiKey)).toEqual([foreign, second.endpointId]);
});
it('moves to the new account when the key changes, and deletes the old endpoint with the old key', async () => {
  const { id, context } = await newGym();
  await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_ACCOUNTA' });
  const first = (await stored(id))!, foreignA = await add('rk_test_ACCOUNTA', tagged('another-gym'));
  const foreignB = await add('rk_test_ACCOUNTB', tagged('another-gym'));
  await service.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_test_ACCOUNTB' });
  const second = (await stored(id))!;
  expect(second).toMatchObject({ apiKey: 'rk_test_ACCOUNTB' });
  expect(second.endpointId).not.toBe(first.endpointId);
  expect(second.webhookSecret).not.toBe('');
  expect(ids('rk_test_ACCOUNTA')).toEqual([foreignA]);
  expect(ids('rk_test_ACCOUNTB')).toEqual([foreignB, second.endpointId]);
});
it('logs and still saves when the old key can no longer delete the old endpoint', async () => {
  const { id, context } = await newGym(), lines: string[] = [];
  await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_REFUSEDA' });
  const first = (await stored(id))!, old = account('rk_test_REFUSEDA');
  const refusing = { request: (input: { method: string }) => input.method === 'DELETE'
    ? Promise.reject(Object.assign(new Error('Permission denied rk_test_REFUSEDA'), { statusCode: 403 })) : old.request(input as never) };
  const refused = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym,
    provisioner: (apiKey) => stripeProvisioner(apiKey === 'rk_test_REFUSEDA' ? refusing : account(apiKey)) });
  const previous = setLogSink((line) => { lines.push(line); });
  try { await refused.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_test_REFUSEDB' }); }
  finally { setLogSink(previous); }
  expect(await stored(id)).toMatchObject({ apiKey: 'rk_test_REFUSEDB' });
  expect(ids('rk_test_REFUSEDA')).toEqual([first.endpointId]);
  expect(lines.join('\n')).toContain('payments.webhook_endpoint_remove_failed');
  expect(lines.join('\n')).not.toContain('rk_test_REFUSEDA');
});
it('deletes the stored endpoint when Stripe is skipped after being configured', async () => {
  const { id, context } = await newGym(), apiKey = 'rk_test_SKIPPED';
  await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: apiKey });
  const foreign = await add(apiKey, tagged('another-gym'));
  await service.configure(context, { choice: 'skip', revision: 2 });
  expect(await stored(id)).toBeNull();
  expect(ids(apiKey)).toEqual([foreign]);
});
it('audits the mode stored when each save locked the gym row and the mode it saved', async () => {
  const { id, context } = await newGym();
  await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_MODESFIRST' });
  await service.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_live_MODESSECOND' });
  await service.configure(context, { choice: 'skip', revision: 3 });
  const audits = await database.forGym(id, (tx) => tx.select().from(auditEvents)
    .where(eq(auditEvents.action, 'setup.stripe_configured')).orderBy(auditEvents.createdAt, auditEvents.id));
  expect(audits.map(({ before, after }) => ({ before, mode: (after as { mode: string | null }).mode }))).toEqual([
    { before: { mode: null }, mode: 'test' }, { before: { mode: 'test' }, mode: 'live' }, { before: { mode: 'live' }, mode: null }]);
});
it('deletes nothing when the revision changes while the new endpoint is registered', async () => {
  const { id, context } = await newGym(), apiKey = 'rk_test_RACEKEPT';
  await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_RACEOLD' });
  const first = (await stored(id))!;
  const racing = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym,
    provisioner: (k) => ({ ...provisioner(k), async register(gym, origin, revision, previous) {
      await database.forGym(id, (tx) => tx.update(gyms).set({ revision: 9 }).where(eq(gyms.id, id)));
      return stripeProvisioner(account(k)).register(gym, origin, revision, previous);
    } }) });
  await expect(racing.configure(context, { choice: 'configure', revision: 2, restrictedKey: apiKey })).rejects.toThrow();
  expect(await stored(id)).toEqual(first);
  expect(ids('rk_test_RACEOLD')).toEqual([first.endpointId]);
  expect(await revisionOf(id)).toBe(9);
});

describe("the gym's Stripe references", () => {
  /** Answers a read of `cus_ref` when the key can read it, otherwise 404 `resource_missing`; records every path. */
  function references(reads: boolean) {
    const paths: string[] = [];
    const transport = (_apiKey: string): PaymentTransport => ({ async request(input) {
      assertNoTransaction('payments.transport');
      paths.push(input.method + ' ' + input.path);
      if (reads && input.method === 'GET' && input.path === '/v1/customers/cus_ref') return { id: 'cus_ref', object: 'customer' };
      throw Object.assign(new Error('No such customer'), { code: 'resource_missing', statusCode: 404 });
    } });
    const registered: string[] = [];
    const step = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym, transport,
      provisioner: (apiKey) => ({ ...provisioner(apiKey), async register(gym, origin, revision, previous) {
        registered.push(apiKey); return provisioner(apiKey).register(gym, origin, revision, previous);
      } }) });
    return { step, paths, registered };
  }
  /** An unfinished setup with a stored test-mode key and a household linked to `cus_ref`. */
  async function referencedGym() {
    const { id, context } = await newGym();
    await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_REFSTORED' });
    await factory('households', id, { stripeCustomerId: 'cus_ref' });
    return { id, context };
  }
  const state = async (id: string) => {
    const [gym] = await database.forGym(id, (tx) => tx.select().from(gyms));
    return { stripeConfig: gym!.stripeConfig, revision: gym!.revision, settings: gym!.settings };
  };

  it('refuses a key in the other mode before any provider request, and saves nothing', async () => {
    const { id, context } = await referencedGym(), before = await state(id), { step, paths, registered } = references(true), count = checks.length;
    await expect(step.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_live_REFOTHERMODE' })).rejects.toMatchObject({
      code: 'invalid_request', message: 'Stripe customers and payments exist in test mode', details: { restrictedKey: ['mode_locked'] } });
    expect(await state(id)).toEqual(before);
    expect(registered).toEqual([]);
    expect(paths).toEqual([]);
    expect(checks.length).toBe(count);
  });
  it('refuses a same-mode key that cannot read the references, after the permission probe and before registering', async () => {
    const { id, context } = await referencedGym(), before = await state(id), { step, paths, registered } = references(false), count = checks.length;
    await expect(step.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_test_REFOTHERACCOUNT' })).rejects.toMatchObject({
      code: 'invalid_request', message: 'The key belongs to another Stripe account', details: { restrictedKey: ['account_locked'] } });
    expect(await state(id)).toEqual(before);
    expect(registered).toEqual([]);
    expect(checks.slice(count)).toEqual(['validate']);
    expect(paths).toEqual(['GET /v1/customers/cus_ref']);
  });
  it('returns the conflict as a 400 through the route, so the setup screen shows its key message', async () => {
    const { id } = await referencedGym(), { step } = references(false);
    const response = await request(app({ kind: 'staff', userId: ownerId, gymId: id, roles: ['owner'] }, id, step),
      { choice: 'configure', revision: 2, restrictedKey: 'rk_test_REFROUTE' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('account_locked');
  });
  it('saves a same-mode key that reads the references, with the same audit', async () => {
    const { id, context } = await referencedGym(), { step, paths } = references(true);
    expect(await step.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_test_REFSAMEACCOUNT' }))
      .toMatchObject({ configured: true, mode: 'test', webhookRegistered: true, revision: 3 });
    expect(await stored(id)).toMatchObject({ apiKey: 'rk_test_REFSAMEACCOUNT', mode: 'test' });
    expect(paths).toEqual(['GET /v1/customers/cus_ref']);
    const audits = await database.forGym(id, (tx) => tx.select().from(auditEvents)
      .where(eq(auditEvents.action, 'setup.stripe_configured')).orderBy(auditEvents.createdAt, auditEvents.id));
    expect(audits.map(({ before, after }) => ({ before, after }))).toEqual([
      { before: { mode: null }, after: expect.objectContaining({ configured: true, mode: 'test' }) },
      { before: { mode: 'test' }, after: { configured: true, mode: 'test', endpointId: expect.any(String), endpointReused: false } }]);
  });
  it('accepts any key without reading Stripe when only imported customer IDs exist and nothing is stored', async () => {
    const { id, context } = await newGym(), { step, paths } = references(false);
    await factory('households', id, { stripeCustomerId: 'cus_imported' });
    await step.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_REFIMPORTED' });
    expect(await stored(id)).toMatchObject({ apiKey: 'rk_test_REFIMPORTED' });
    expect(paths).toEqual([]);
  });
  it('fails the save when a reference is recorded while the key is checked', async () => {
    const { id, context } = await newGym();
    await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_REFRACEOLD' });
    const before = await state(id), paths: string[] = [];
    const racing = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym,
      transport: () => ({ async request(input) { paths.push(input.path); return {}; } }),
      provisioner: (apiKey) => ({ ...provisioner(apiKey), async register(gym, origin, revision, previous) {
        await factory('households', id, { stripeCustomerId: 'cus_ref' });
        return stripeProvisioner(account(apiKey)).register(gym, origin, revision, previous);
      } }) });
    await expect(racing.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_test_REFRACENEW' })).rejects.toMatchObject({
      code: 'conflict', message: 'Stripe customers were recorded while the key was checked; try again' });
    expect(await state(id)).toEqual(before);
    expect(paths).toEqual([]);
  });
});

describe('customers the app linked, with no key stored', () => {
  /** Reads of `cus_linked` get `answer` (a 404 `resource_missing` when none); records every path. */
  function linkedStep(answer?: () => Promise<ObjectData>, validate?: () => Promise<void>) {
    const paths: string[] = [], registered: string[] = [];
    const transport = (_apiKey: string): PaymentTransport => ({ async request(input) {
      assertNoTransaction('payments.transport');
      paths.push(input.method + ' ' + input.path);
      if (answer && input.method === 'GET' && input.path === '/v1/customers/cus_linked') return answer();
      throw Object.assign(new Error('No such customer'), { code: 'resource_missing', statusCode: 404 });
    } });
    const step = createStripeStep({ key, origin: 'https://gym.invalid', clock, scope: database.forGym, transport,
      provisioner: (apiKey) => ({ ...provisioner(apiKey),
        ...(validate ? { validate } : {}),
        async register(gym, origin, revision, previous) {
          registered.push(apiKey); return provisioner(apiKey).register(gym, origin, revision, previous);
        } }) });
    return { step, paths, registered };
  }
  /** A household whose customer the customers service linked, named by its link audit. */
  async function linkCustomer(id: string) {
    const household = await factory('households', id, { stripeCustomerId: 'cus_linked' });
    await factory('auditEvents', id, { action: 'billing.customer.linked', targetType: 'household', targetId: household.id,
      after: { customerId: 'cus_linked' } });
  }
  /** An unfinished setup that saved a test key and then skipped (nothing stored), with an app-linked customer. */
  async function skippedGym() {
    const { id, context } = await newGym();
    await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_LINKFIRST' });
    await service.configure(context, { choice: 'skip', revision: 2 });
    await linkCustomer(id);
    return { id, context };
  }
  const snapshot = async (id: string) => {
    const [gym] = await database.forGym(id, (tx) => tx.select().from(gyms));
    const audits = await database.forGym(id, (tx) => tx.select({ id: auditEvents.id }).from(auditEvents));
    return { stripeConfig: gym!.stripeConfig, revision: gym!.revision, settings: gym!.settings, audits: audits.length };
  };
  const failureLines = async (run: () => Promise<unknown>) => {
    const lines: string[] = [], previous = setLogSink((line) => { lines.push(line); });
    try { await run(); } finally { setLogSink(previous); }
    return lines.filter((line) => line.includes('"event":"setup.stripe_key_failed"'));
  };

  it('refuses a key in the latest saved mode\'s other mode before any provider request, and saves nothing', async () => {
    const { id, context } = await skippedGym(), before = await snapshot(id), { step, paths, registered } = linkedStep(), count = checks.length;
    expect(before.stripeConfig).toBeNull();
    await expect(step.configure(context, { choice: 'configure', revision: 3, restrictedKey: 'rk_live_LINKOTHERMODE' })).rejects.toMatchObject({
      code: 'invalid_request', message: 'Stripe customers and payments exist in test mode', details: { restrictedKey: ['mode_locked'] } });
    expect(await snapshot(id)).toEqual(before);
    expect(registered).toEqual([]);
    expect(paths).toEqual([]);
    expect(checks.length).toBe(count);
  });
  it('requires a same-mode key to read the linked customer, and saves one that does after one read', async () => {
    const { id, context } = await skippedGym(), before = await snapshot(id);
    const refused = linkedStep();
    await expect(refused.step.configure(context, { choice: 'configure', revision: 3, restrictedKey: 'rk_test_LINKOTHERACCOUNT' })).rejects.toMatchObject({
      code: 'invalid_request', details: { restrictedKey: ['account_locked'] } });
    expect(await snapshot(id)).toEqual(before);
    expect(refused.registered).toEqual([]);
    expect(refused.paths).toEqual(['GET /v1/customers/cus_linked']);
    const reading = linkedStep(async () => ({ id: 'cus_linked', object: 'customer' }));
    expect(await reading.step.configure(context, { choice: 'configure', revision: 3, restrictedKey: 'rk_test_LINKSAMEACCOUNT' }))
      .toMatchObject({ configured: true, mode: 'test', revision: 4 });
    expect(await stored(id)).toMatchObject({ apiKey: 'rk_test_LINKSAMEACCOUNT', mode: 'test' });
    expect(reading.paths).toEqual(['GET /v1/customers/cus_linked']);
  });
  it('compares the latest saved mode when the stored settings cannot be read', async () => {
    const { id, context } = await newGym();
    await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_LINKUNREADABLE' });
    const unreadable = encryptSecret(Buffer.alloc(32, 9), { secretClass: 'stripe_config', owner: id }, JSON.stringify({ mode: 'live' }));
    await database.forGym(id, (tx) => tx.update(gyms).set({ stripeConfig: unreadable }).where(eq(gyms.id, id)));
    await linkCustomer(id);
    const before = await snapshot(id), { step, paths, registered } = linkedStep(async () => ({ id: 'cus_linked', object: 'customer' }));
    const previous = setLogSink(() => {});
    try {
      await expect(step.configure(context, { choice: 'configure', revision: 2, restrictedKey: 'rk_live_UNREADLIVE' })).rejects.toMatchObject({
        code: 'invalid_request', message: 'Stripe customers and payments exist in test mode', details: { restrictedKey: ['mode_locked'] } });
    } finally { setLogSink(previous); }
    expect(await snapshot(id)).toEqual(before);
    expect(registered).toEqual([]);
    expect(paths).toEqual([]);
  });
  it('still accepts a key in either mode without a read when only imported customer IDs exist and nothing is stored', async () => {
    const { id, context } = await newGym();
    await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_IMPORTEDFIRST' });
    await service.configure(context, { choice: 'skip', revision: 2 });
    await factory('households', id, { stripeCustomerId: 'cus_imported' });
    const { step, paths } = linkedStep();
    expect(await step.configure(context, { choice: 'configure', revision: 3, restrictedKey: 'rk_live_IMPORTEDLIVE' }))
      .toMatchObject({ configured: true, mode: 'live' });
    expect(await stored(id)).toMatchObject({ apiKey: 'rk_live_IMPORTEDLIVE', mode: 'live' });
    expect(paths).toEqual([]);
  });
  it('locks no mode for imported customer IDs and cards alone with nothing stored, but still reads them', async () => {
    const { id, context } = await newGym();
    await service.configure(context, { choice: 'configure', revision: 1, restrictedKey: 'rk_test_IMPCARDFIRST' });
    await service.configure(context, { choice: 'skip', revision: 2 });
    // No link audit names it, so the customer counts as imported.
    const household = await factory('households', id, { stripeCustomerId: 'cus_linked' });
    const card = await factory('paymentMethods', id, { householdId: household.id });
    await factory('auditEvents', id, { action: 'payment_method.created', targetType: 'payment_method', targetId: card.id });
    const { step, paths } = linkedStep(async () => ({ id: 'cus_linked', object: 'customer' }));
    expect(await step.configure(context, { choice: 'configure', revision: 3, restrictedKey: 'rk_live_IMPCARDLIVE' }))
      .toMatchObject({ configured: true, mode: 'live' });
    expect(await stored(id)).toMatchObject({ apiKey: 'rk_live_IMPCARDLIVE', mode: 'live' });
    expect(paths).toEqual(['GET /v1/customers/cus_linked']);
  });
  it('answers a rate-limited reference read as unavailable, logged once without the message, and saves nothing', async () => {
    const { id, context } = await skippedGym(), before = await snapshot(id);
    const { step, registered } = linkedStep(async () => { throw Object.assign(new Error('Too many requests rk_test_LINKLIMITED'), { statusCode: 429, code: 'rate_limit' }); });
    const lines = await failureLines(() => expect(step.configure(context, { choice: 'configure', revision: 3, restrictedKey: 'rk_test_LINKLIMITED' }))
      .rejects.toMatchObject({ code: 'unavailable', message: 'Stripe could not be reached or refused the key' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('rk_test_LINKLIMITED');
    expect(await snapshot(id)).toEqual(before);
    expect(registered).toEqual([]);
  });
  it('answers a probe network error as a 503 through the route, logged once, and saves nothing', async () => {
    const { id } = await skippedGym(), before = await snapshot(id);
    const { step, paths, registered } = linkedStep(undefined, async () => { throw new Error('network'); });
    let status = 0;
    const lines = await failureLines(async () => {
      const response = await request(app({ kind: 'staff', userId: ownerId, gymId: id, roles: ['owner'] }, id, step),
        { choice: 'configure', revision: 3, restrictedKey: 'rk_test_LINKNETWORK' });
      status = response.status;
      expect(JSON.stringify(await response.json())).toContain('unavailable');
    });
    expect(status).toBe(503);
    expect(lines).toHaveLength(1);
    expect(await snapshot(id)).toEqual(before);
    expect(paths).toEqual([]);
    expect(registered).toEqual([]);
  });
  it('answers a probe missing a permission as missing_permission (400), and saves nothing', async () => {
    const { id, context } = await skippedGym(), before = await snapshot(id);
    const { step, registered } = linkedStep(undefined, async () => { throw new StripePermissionError('Webhook Endpoints'); });
    await expect(step.configure(context, { choice: 'configure', revision: 3, restrictedKey: 'rk_test_LINKPERMISSION' })).rejects.toMatchObject({
      code: 'invalid_request', details: { restrictedKey: ['missing_permission'] } });
    const response = await request(app({ kind: 'staff', userId: ownerId, gymId: id, roles: ['owner'] }, id, step),
      { choice: 'configure', revision: 3, restrictedKey: 'rk_test_LINKPERMISSION' });
    expect(response.status).toBe(400);
    expect(await snapshot(id)).toEqual(before);
    expect(registered).toEqual([]);
  });
});
