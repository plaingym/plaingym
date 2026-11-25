// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { demoStripeEnv, useDemoRuntime } from './runtime.fixture.test-helper.js';
// After the runtime helper, which loads the OpenAPI extension of Zod before the route modules this one imports.
import { createWebhookHealthQuery } from '../areas/billing/webhooks/inbox.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;

it('never warns about webhook silence through the demo runtime', async () => {
  const sandbox = app.sandbox;
  const attemptedAt = new Date(Date.now() - 2 * 86_400_000);
  await factory('paymentAttempts', sandbox.gymId, { paymentIntentId: 'pi_runtime_silence', createdAt: attemptedAt });
  // Two days of charges and no webhook: without the runtime's silence check the tile would warn.
  expect(await createWebhookHealthQuery(database.forGym).get(sandbox.gymId))
    .toMatchObject({ lastReceivedAt: null, firstChargeAttemptAt: attemptedAt.toISOString() });
  await app.restart(demoStripeEnv);
  const headers = app.headers(sandbox, await app.login('owner'));
  const health = await app.runtime.app.request(sandbox.origin + '/api/health', { headers });
  expect(health.status, await health.clone().text()).toBe(200);
  expect((await health.json()).data.tiles).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'stripe_webhooks', status: 'healthy',
      message: expect.stringContaining('No webhook has arrived yet') }),
  ]));
}, 60_000);
