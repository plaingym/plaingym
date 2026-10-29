// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import * as stripeAdapter from '../infra/payments/stripe.js';
import { STRIPE_API_VERSION, STRIPE_EVENTS } from '../infra/payments/stripe.js';
import { StripeFixtures } from '../infra/payments/stripe-fixtures.js';
import type { ProviderRequest } from '../infra/payments/transport.js';
import { encryptSecret, parseEncryptionKey } from './secrets.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db);
let runtime: Runtime | undefined, directory: string | undefined;
const origin = 'https://gym.example.test';
const env = () => ({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32), AUTH_SECRET: 'runtime-endpoints-secret-at-least-32-characters',
  AUTH_PASSWORD_LOGIN: 'auto', TENANCY: 'single', PUBLIC_ORIGIN: origin, NODE_ENV: 'production', UPLOADS_DIR: join(directory!, 'uploads') });
async function gymWithEndpoint(transport: StripeFixtures, events: string[]) {
  const gymId = uuidv7(), apiKey = 'rk_test_RUNTIME';
  const endpoint = await transport.request({ method: 'POST', path: '/v1/webhook_endpoints', params: { url: origin + '/webhooks/stripe',
    api_version: STRIPE_API_VERSION, enabled_events: events, metadata: { gym_id: gymId } } });
  const config = { apiKey, mode: 'test', endpointId: endpoint.id, webhookSecret: 'whsec_runtime' };
  await factory('gyms', gymId, { stripeConfig: encryptSecret(parseEncryptionKey(env().APP_ENCRYPTION_KEY), 'stripe_config', JSON.stringify(config)) });
  return { gymId, endpointId: endpoint.id as string };
}
async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 200 && !done(); attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(done()).toBe(true);
}
afterEach(async () => { await runtime?.stop(); runtime = undefined; vi.restoreAllMocks(); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it('subscribes the stored endpoint to this release\'s events after starting', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-endpoints-runtime-'));
  const transport = new StripeFixtures('runtime');
  const { endpointId } = await gymWithEndpoint(transport, ['charge.refunded']);
  vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(transport);
  runtime = await startRuntime(env());
  const events = () => [...transport.objects.get(endpointId)!.enabled_events as string[]].sort();
  await until(() => events().length === STRIPE_EVENTS.length);
  expect(events()).toEqual([...STRIPE_EVENTS].sort());
});
it('starts without waiting for Stripe, and a Stripe outage only logs', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const inner = new StripeFixtures('runtime');
  await gymWithEndpoint(inner, ['charge.refunded']);
  let release!: () => void;
  const outage = new Promise<void>((resolve) => { release = resolve; });
  const requests: ProviderRequest[] = [];
  vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue({ async request(input) {
    requests.push(input); await outage; throw Object.assign(new Error('Network unavailable'), { code: 'ECONNRESET' });
  } });
  runtime = await startRuntime(env());
  await until(() => requests.length > 0);
  expect(requests[0]).toMatchObject({ method: 'GET' });
  expect(await runtime.app.request(origin + '/healthz', { headers: { host: 'gym.example.test' } })).toBeDefined();
  release();
});
