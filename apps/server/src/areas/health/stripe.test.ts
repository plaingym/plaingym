// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createWebhookHealthQuery } from '../billing/webhooks/inbox.js';
import { createHealthService } from './status.js';
import { createStripeHealthProvider } from './stripe.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-26T12:00:00Z');
describe('Stripe health', () => {
  it('reads safe inbox aggregates per gym, including failed and pending events', async () => {
    const a = uuidv7(), b = uuidv7(); await factory('gyms', a); await factory('gyms', b);
    await factory('stripeEvents', a, { receivedAt: clock.now(), processedAt: clock.now() });
    await factory('stripeEvents', b, { error: 'private event failure', payload: { private: 'secret' } });
    const provider = createStripeHealthProvider({ webhooks: createWebhookHealthQuery(db.forGym), configured: async () => true });
    const read = (gymId: string) => provider.read({ gymId, roles: ['owner'], clock });
    expect(await read(a)).toMatchObject({ status: 'healthy', details: { pending: 0, failed: 0 } });
    expect(await read(b)).toMatchObject({ status: 'error', details: { pending: 0, failed: 1 } });
    expect(JSON.stringify(await read(b))).not.toMatch(/private|secret/);
    await factory('stripeEvents', a);
    expect(await read(a)).toMatchObject({ status: 'warning', details: { pending: 1 } });
    await expect(provider.read({ gymId: a, roles: ['front_desk'], clock })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('distinguishes unconfigured Stripe, no traffic, and provider failure', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    for (const configured of [false, true]) {
      const provider = createStripeHealthProvider({ webhooks: createWebhookHealthQuery(db.forGym), configured: async () => configured });
      expect(await provider.read({ gymId, roles: ['admin'], clock })).toHaveProperty('status', configured ? 'warning' : 'not_configured');
    }
    const provider = createStripeHealthProvider({ webhooks: createWebhookHealthQuery(db.forGym), configured: async () => { throw new Error('private key'); } });
    const response = await createHealthService([provider]).get({ gymId, roles: ['owner'], clock });
    expect(response.data.tiles.find(tile => tile.id === 'stripe_webhooks')).toMatchObject({ status: 'unavailable', details: null });
    expect(JSON.stringify(response)).not.toContain('private key');
  });
});
