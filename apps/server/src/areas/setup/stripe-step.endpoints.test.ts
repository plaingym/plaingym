// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import { STRIPE_API_VERSION, STRIPE_EVENTS } from '../../infra/payments/stripe.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { stripeProvisioner } from '../../infra/payments/setup.js';
import { createStripeEndpointCheck } from './stripe-step.endpoints.js';
import type { StripeConfig, StripeProvisioner } from './stripe-step.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-29T12:00:00Z');
const key = Buffer.alloc(32, 7), origin = 'https://gym.invalid', url = origin + '/webhooks/stripe';
const accounts = new Map<string, StripeFixtures>();
const account = (apiKey: string) => { if (!accounts.has(apiKey)) accounts.set(apiKey, new StripeFixtures('unused')); return accounts.get(apiKey)!; };
const params = (gymId: string, extra: Record<string, unknown> = {}) => ({ url, api_version: STRIPE_API_VERSION, enabled_events: [...STRIPE_EVENTS], metadata: { gym_id: gymId }, ...extra });
const add = async (apiKey: string, value: Record<string, unknown>) =>
  (await account(apiKey).request({ method: 'POST', path: '/v1/webhook_endpoints', params: value as never })).id as string;
const ids = (apiKey: string) => [...account(apiKey).objects.values()].filter((object) => object.object === 'webhook_endpoint').map((object) => object.id);
const eventsOf = (apiKey: string, id: string) => [...account(apiKey).objects.get(id)!.enabled_events as string[]].sort();
let counter = 0;
/** A gym with Stripe saved against its own synthetic account and one endpoint made by `endpoint`. */
async function gymWith(endpoint: (gymId: string, apiKey: string) => Promise<string>) {
  const gymId = uuidv7(), apiKey = 'rk_test_CHECK' + ++counter;
  const endpointId = await endpoint(gymId, apiKey);
  const config: StripeConfig = { apiKey, mode: 'test', endpointId, webhookSecret: 'whsec_stored_' + counter };
  await factory('gyms', gymId, { stripeConfig: encryptSecret(key, 'stripe_config', JSON.stringify(config)) });
  return { gymId, apiKey, config };
}
const readConfig = async (gymId: string) => {
  const [gym] = await database.forGym(gymId, (tx) => tx.select().from(gyms));
  return gym!.stripeConfig ? JSON.parse(decryptSecret(key, 'stripe_config', gym!.stripeConfig)) as StripeConfig : null;
};
const checkFor = (list: readonly string[], overrides: Partial<Parameters<typeof createStripeEndpointCheck>[0]> = {}) => createStripeEndpointCheck({
  key, clock, scope: database.forGym, gyms: async () => list.map((gymId) => ({ gymId })), origin: async () => origin,
  provisioner: (apiKey) => stripeProvisioner(account(apiKey)), ...overrides });
function capture() {
  const lines: Record<string, unknown>[] = [];
  const previous = setLogSink((line) => { lines.push(JSON.parse(line) as Record<string, unknown>); });
  return { lines, done: () => { setLogSink(previous); } };
}
beforeEach(() => { accounts.clear(); });

it('subscribes a stored endpoint to events added by this release, keeping its secret and leaving other endpoints alone', async () => {
  const gym = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { enabled_events: STRIPE_EVENTS.filter((event) => event !== 'payment_method.automatically_updated') })));
  const foreign = await add(gym.apiKey, params('another-gym', { enabled_events: ['charge.refunded'] }));
  await checkFor([gym.gymId]).run();
  expect(eventsOf(gym.apiKey, gym.config.endpointId)).toEqual([...STRIPE_EVENTS].sort());
  expect(eventsOf(gym.apiKey, foreign)).toEqual(['charge.refunded']);
  expect(await readConfig(gym.gymId)).toEqual(gym.config);
  // A second pass finds nothing to do.
  const before = account(gym.apiKey).requests.length;
  await checkFor([gym.gymId]).run();
  expect(account(gym.apiKey).requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
});
it('replaces an endpoint at another API version, storing the new signing secret and deleting the old endpoint', async () => {
  const gym = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { api_version: '2025-01-01.old' })));
  const duplicate = await add(gym.apiKey, params(gym.gymId)), foreign = await add(gym.apiKey, params('another-gym'));
  const logs = capture();
  try { await checkFor([gym.gymId]).run(); } finally { logs.done(); }
  const saved = (await readConfig(gym.gymId))!;
  expect(saved.endpointId).not.toBe(gym.config.endpointId);
  expect(saved).toMatchObject({ apiKey: gym.apiKey, mode: 'test', webhookSecret: 'fixture-signing-secret' });
  expect(ids(gym.apiKey)).toEqual([foreign, saved.endpointId]);
  expect(duplicate).not.toBe(saved.endpointId);
  expect(account(gym.apiKey).objects.get(saved.endpointId)).toMatchObject({ api_version: STRIPE_API_VERSION, metadata: { gym_id: gym.gymId } });
  const audits = await database.forGym(gym.gymId, (tx) => tx.select().from(auditEvents));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ actorKind: 'system', action: 'payments.webhook_endpoint_replaced', before: { endpointId: gym.config.endpointId }, after: { endpointId: saved.endpointId } });
  expect(JSON.stringify([audits, logs.lines])).not.toMatch(/rk_test_|fixture-signing-secret|whsec_/);
  expect(logs.lines).toContainEqual(expect.objectContaining({ event: 'payments.webhook_endpoint_replaced', gymId: gym.gymId }));
});
it('never blocks on Stripe being down: it logs, keeps the stored settings and checks the other gyms', async () => {
  const down = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { enabled_events: ['charge.refunded'] })));
  const up = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { enabled_events: ['charge.refunded'] })));
  const outage = (): StripeProvisioner => stripeProvisioner({ request: () => Promise.reject(Object.assign(new Error('Network unavailable ' + down.apiKey), { code: 'ECONNRESET' })) });
  const logs = capture();
  try { await checkFor([down.gymId, up.gymId], { provisioner: (apiKey) => apiKey === down.apiKey ? outage() : stripeProvisioner(account(apiKey)) }).run(); }
  finally { logs.done(); }
  expect(eventsOf(down.apiKey, down.config.endpointId)).toEqual(['charge.refunded']);
  expect(eventsOf(up.apiKey, up.config.endpointId)).toEqual([...STRIPE_EVENTS].sort());
  expect(await readConfig(down.gymId)).toEqual(down.config);
  expect(logs.lines).toContainEqual(expect.objectContaining({ level: 'error', event: 'payments.webhook_check_failed', gymId: down.gymId }));
  expect(JSON.stringify(logs.lines)).not.toContain(down.apiKey);
  // The next pass, with Stripe back, finishes the job.
  await checkFor([down.gymId]).run();
  expect(eventsOf(down.apiKey, down.config.endpointId)).toEqual([...STRIPE_EVENTS].sort());
});
const deleted = (gymId: string, apiKey: string) => async () => {
  const id = await add(apiKey, params(gymId));
  await account(apiKey).request({ method: 'DELETE', path: '/v1/webhook_endpoints/' + id });
  return id;
};
it("recreates an endpoint deleted in the Stripe dashboard, storing the new secret and retiring the gym's stale endpoints", async () => {
  const gym = await gymWith((gymId, apiKey) => deleted(gymId, apiKey)());
  const stale = await add(gym.apiKey, params(gym.gymId)), foreign = await add(gym.apiKey, params('another-gym'));
  const other = await add(gym.apiKey, params(gym.gymId, { url: 'https://other-host.invalid/webhooks/stripe' }));
  const logs = capture();
  try { await checkFor([gym.gymId]).run(); } finally { logs.done(); }
  const saved = (await readConfig(gym.gymId))!;
  expect(saved).toMatchObject({ apiKey: gym.apiKey, mode: 'test', webhookSecret: 'fixture-signing-secret' });
  expect(saved.endpointId).not.toBe(gym.config.endpointId);
  expect(ids(gym.apiKey)).toEqual([foreign, other, saved.endpointId]);
  expect(stale).not.toBe(saved.endpointId);
  expect(account(gym.apiKey).objects.get(saved.endpointId)).toMatchObject({ api_version: STRIPE_API_VERSION, url, metadata: { gym_id: gym.gymId } });
  const audits = await database.forGym(gym.gymId, (tx) => tx.select().from(auditEvents));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ actorKind: 'system', action: 'payments.webhook_endpoint_recreated',
    before: { endpointId: gym.config.endpointId }, after: { endpointId: saved.endpointId } });
  expect(JSON.stringify([audits, logs.lines])).not.toMatch(/rk_test_|fixture-signing-secret|whsec_/);
  expect(logs.lines).toContainEqual(expect.objectContaining({ event: 'payments.webhook_endpoint_recreated', gymId: gym.gymId }));
  // The next start finds the new endpoint current and changes nothing.
  const requests = account(gym.apiKey).requests.length;
  await checkFor([gym.gymId]).run();
  expect(account(gym.apiKey).requests.slice(requests).every((request) => request.method === 'GET')).toBe(true);
  expect(await readConfig(gym.gymId)).toEqual(saved);
});
it('creates at most one endpoint when the recreation runs twice at once', async () => {
  const gym = await gymWith((gymId, apiKey) => deleted(gymId, apiKey)());
  await Promise.all([checkFor([gym.gymId]).run(), checkFor([gym.gymId]).run()]);
  const saved = (await readConfig(gym.gymId))!;
  expect(saved.endpointId).not.toBe(gym.config.endpointId);
  expect(ids(gym.apiKey)).toEqual([saved.endpointId]);
  expect(await database.forGym(gym.gymId, (tx) => tx.select().from(auditEvents))).toHaveLength(1);
});
it('deletes the recreated endpoint if the settings changed meanwhile, and keeps it if the concurrent save stored it', async () => {
  const lost = await gymWith((gymId, apiKey) => deleted(gymId, apiKey)());
  const changed = encryptSecret(key, 'stripe_config', JSON.stringify({ ...lost.config, webhookSecret: 'whsec_saved_meanwhile' }));
  const racing = (apiKey: string): StripeProvisioner => {
    const real = stripeProvisioner(account(apiKey));
    return { ...real, async check(...args) {
      const result = await real.check(...args);
      await database.forGym(lost.gymId, (tx) => tx.update(gyms).set({ stripeConfig: changed }).where(eq(gyms.id, lost.gymId)));
      return result;
    } };
  };
  await checkFor([lost.gymId], { provisioner: racing }).run();
  expect((await readConfig(lost.gymId))!).toMatchObject({ endpointId: lost.config.endpointId, webhookSecret: 'whsec_saved_meanwhile' });
  expect(ids(lost.apiKey)).toEqual([]);
  expect(await database.forGym(lost.gymId, (tx) => tx.select().from(auditEvents))).toEqual([]);
  // The concurrent writer saved the very endpoint this run created: it stays.
  const won = await gymWith((gymId, apiKey) => deleted(gymId, apiKey)());
  const winning = (apiKey: string): StripeProvisioner => {
    const real = stripeProvisioner(account(apiKey));
    return { ...real, async check(...args) {
      const result = await real.check(...args);
      if (result.status !== 'recreated') throw new Error('Expected a recreated endpoint');
      const stored = encryptSecret(key, 'stripe_config', JSON.stringify({ ...won.config, ...result.registration }));
      await database.forGym(won.gymId, (tx) => tx.update(gyms).set({ stripeConfig: stored }).where(eq(gyms.id, won.gymId)));
      return result;
    } };
  };
  await checkFor([won.gymId], { provisioner: winning }).run();
  expect(ids(won.apiKey)).toEqual([(await readConfig(won.gymId))!.endpointId]);
});
it('never treats a failed read as a missing endpoint', async () => {
  const gym = await gymWith((gymId, apiKey) => add(apiKey, params(gymId)));
  const failures = [
    Object.assign(new Error('Permission denied'), { type: 'StripePermissionError', statusCode: 403 }),
    Object.assign(new Error('Invalid key'), { type: 'StripeAuthenticationError', statusCode: 401 }),
    Object.assign(new Error('Network unavailable'), { code: 'ECONNRESET' }),
    Object.assign(new Error('Not found'), { statusCode: 404 }),
    Object.assign(new Error('Resource missing'), { code: 'resource_missing', statusCode: 400 }),
  ];
  const logs = capture();
  try {
    for (const failure of failures) {
      const inner = account(gym.apiKey), requests: string[] = [];
      await checkFor([gym.gymId], { provisioner: () => stripeProvisioner({ request: (input) => {
        requests.push(input.method);
        return input.method === 'GET' ? Promise.reject(failure) : inner.request(input);
      } }) }).run();
      expect(requests).toEqual(['GET']);
    }
  } finally { logs.done(); }
  expect(logs.lines.filter((line) => line.event === 'payments.webhook_check_failed')).toHaveLength(failures.length);
  expect(ids(gym.apiKey)).toEqual([gym.config.endpointId]);
  expect(await readConfig(gym.gymId)).toEqual(gym.config);
});
it("reports an endpoint that is not this install's without changing anything", async () => {
  const moved = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { url: 'https://old-host.invalid/webhooks/stripe', enabled_events: ['charge.refunded'], api_version: '2025-01-01.old' })));
  const untagged = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { metadata: {} })));
  const logs = capture();
  try { await checkFor([moved.gymId, untagged.gymId]).run(); } finally { logs.done(); }
  expect(logs.lines.map((line) => line.event)).toEqual(['payments.webhook_endpoint_skipped', 'payments.webhook_endpoint_skipped']);
  expect(ids(moved.apiKey)).toEqual([moved.config.endpointId]);
  expect(eventsOf(moved.apiKey, moved.config.endpointId)).toEqual(['charge.refunded']);
  for (const gym of [moved, untagged]) expect(await readConfig(gym.gymId)).toEqual(gym.config);
});
it('skips gyms without Stripe settings and unreadable settings, and survives a failing origin or gym list', async () => {
  const none = uuidv7(), broken = uuidv7(), noOrigin = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { enabled_events: ['charge.refunded'] })));
  await factory('gyms', none);
  await factory('gyms', broken, { stripeConfig: 'not-encrypted' });
  const logs = capture();
  try {
    await checkFor([none, broken, noOrigin.gymId], { origin: async () => { throw new Error('The gym has no default hostname'); } }).run();
    await checkFor([], { gyms: async () => { throw new Error('database unavailable'); } }).run();
  } finally { logs.done(); }
  expect(logs.lines.map((line) => line.event)).toEqual(['payments.stored_config_unreadable', 'payments.webhook_check_failed', 'payments.webhook_check_failed']);
  expect(eventsOf(noOrigin.apiKey, noOrigin.config.endpointId)).toEqual(['charge.refunded']);
  for (const gymId of [none, broken]) expect(await database.forGym(gymId, (tx) => tx.select().from(auditEvents))).toEqual([]);
});
it('stops between gyms once the server is stopping', async () => {
  const first = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { enabled_events: ['charge.refunded'] })));
  const second = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { enabled_events: ['charge.refunded'] })));
  await checkFor([first.gymId, second.gymId], { stopped: () => true }).run();
  expect(eventsOf(first.apiKey, first.config.endpointId)).toEqual(['charge.refunded']);
  expect(eventsOf(second.apiKey, second.config.endpointId)).toEqual(['charge.refunded']);
});
it('deletes the replacement it just created if the settings changed meanwhile, unless that was the saved endpoint', async () => {
  const gym = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { api_version: '2025-01-01.old' })));
  const changed = encryptSecret(key, 'stripe_config', JSON.stringify({ ...gym.config, webhookSecret: 'whsec_saved_meanwhile' }));
  const racing = (apiKey: string): StripeProvisioner => {
    const real = stripeProvisioner(account(apiKey));
    return { ...real, async check(...args) {
      const result = await real.check(...args);
      await database.forGym(gym.gymId, (tx) => tx.update(gyms).set({ stripeConfig: changed }).where(eq(gyms.id, gym.gymId)));
      return result;
    } };
  };
  await checkFor([gym.gymId], { provisioner: racing }).run();
  // The concurrent save wins; the replacement made for the old settings is deleted, and the old endpoint stays.
  expect((await readConfig(gym.gymId))!.webhookSecret).toBe('whsec_saved_meanwhile');
  expect(ids(gym.apiKey)).toEqual([gym.config.endpointId]);
  expect(await database.forGym(gym.gymId, (tx) => tx.select().from(auditEvents))).toEqual([]);
});
it('does not run twice concurrently against the same replacement key', async () => {
  const gym = await gymWith((gymId, apiKey) => add(apiKey, params(gymId, { api_version: '2025-01-01.old' })));
  await Promise.all([checkFor([gym.gymId]).run(), checkFor([gym.gymId]).run()]);
  const saved = (await readConfig(gym.gymId))!;
  // Both passes get the same endpoint from Stripe's idempotency; the one that lost the save must not delete it.
  expect(ids(gym.apiKey)).toEqual([saved.endpointId]);
});
