// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeWebhookHealthQuery } from '../../core/interfaces/webhook-health.js';
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
  it('shows a failure from the last 7 days as an error, an older unresolved one as a warning with the replay hint, and a replayed one as healthy', async () => {
    const [fresh, old, replayed, other] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    for (const gymId of [fresh, old, replayed, other]) await factory('gyms', gymId);
    const daysAgo = (days: number) => new Date(clock.now().getTime() - days * 86_400_000);
    await factory('stripeEvents', fresh, { receivedAt: daysAgo(1), error: 'handler_failed' });
    await factory('stripeEvents', old, { receivedAt: daysAgo(8), error: 'handler_failed' });
    await factory('stripeEvents', old, { receivedAt: daysAgo(9), processedAt: daysAgo(9) });
    // A replay that succeeds clears the failure, whatever the event's age.
    await factory('stripeEvents', replayed, { receivedAt: daysAgo(8), processedAt: daysAgo(2), error: null });
    // Another gym's fresh failure changes nothing here.
    await factory('stripeEvents', other, { receivedAt: daysAgo(1), error: 'handler_failed' });
    const provider = createStripeHealthProvider({ webhooks: createWebhookHealthQuery(db.forGym, clock), configured: async () => true });
    const read = (gymId: string) => provider.read({ gymId, roles: ['owner'], clock });
    expect(await read(fresh)).toMatchObject({ status: 'error', details: { failed: 1 }, message: expect.stringContaining('1 Stripe webhook events failed to process in the last 7 days') });
    const warning = await read(old);
    expect(warning).toMatchObject({ status: 'warning', details: { failed: 1 } });
    expect(warning.message).toContain('1 Stripe webhook events last failed to process more than 7 days ago');
    expect(warning.message).toContain('replay');
    expect(await read(replayed)).toMatchObject({ status: 'healthy', details: { failed: 0, pending: 0 } });
    // The same failure turns into the older kind once 7 days have passed since it was received.
    const later = new TestClock('2026-11-03T12:00:00Z');
    const aged = createStripeHealthProvider({ webhooks: createWebhookHealthQuery(db.forGym, later), configured: async () => true });
    expect(await aged.read({ gymId: fresh, roles: ['owner'], clock: later })).toMatchObject({ status: 'warning' });
  });
  it('counts an old event by when it last failed, so a recent failure on replay is an error', async () => {
    const [refailed, stale] = [uuidv7(), uuidv7()];
    for (const gymId of [refailed, stale]) await factory('gyms', gymId);
    const daysAgo = (days: number) => new Date(clock.now().getTime() - days * 86_400_000);
    await factory('stripeEvents', refailed, { receivedAt: daysAgo(30), error: 'handler_failed', failedAt: daysAgo(1) });
    await factory('stripeEvents', stale, { receivedAt: daysAgo(30), error: 'handler_failed', failedAt: daysAgo(9) });
    const provider = createStripeHealthProvider({ webhooks: createWebhookHealthQuery(db.forGym, clock), configured: async () => true });
    const read = (gymId: string) => provider.read({ gymId, roles: ['owner'], clock });
    expect(await read(refailed)).toMatchObject({ status: 'error', details: { failed: 1 }, message: expect.stringContaining('1 Stripe webhook events failed to process in the last 7 days') });
    const warning = await read(stale);
    expect(warning).toMatchObject({ status: 'warning', details: { failed: 1 } });
    expect(warning.message).toContain('1 Stripe webhook events last failed to process more than 7 days ago');
  });
  it('distinguishes unconfigured Stripe, no traffic, and provider failure', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    for (const configured of [false, true]) {
      const provider = createStripeHealthProvider({ webhooks: createWebhookHealthQuery(db.forGym), configured: async () => configured });
      const tile = await provider.read({ gymId, roles: ['admin'], clock });
      expect(tile).toHaveProperty('status', configured ? 'healthy' : 'not_configured');
      if (configured) {
        expect(tile).toMatchObject({ details: { lastReceivedAt: null, pending: 0, failed: 0 } });
        expect(tile.message).toContain('No webhook has arrived yet');
      }
    }
    const provider = createStripeHealthProvider({ webhooks: createWebhookHealthQuery(db.forGym), configured: async () => { throw new Error('private key'); } });
    const response = await createHealthService([provider]).get({ gymId, roles: ['owner'], clock });
    expect(response.data.tiles.find(tile => tile.id === 'stripe_webhooks')).toMatchObject({ status: 'unavailable', details: null });
    expect(JSON.stringify(response)).not.toContain('private key');
  });
  it('warns when no webhook has arrived a day after the first charge attempt, until an event arrives', async () => {
    const gymId = uuidv7();
    const hoursAgo = (hours: number) => new Date(clock.now().getTime() - hours * 3_600_000).toISOString();
    const read = (events: ConstructorParameters<typeof FakeWebhookHealthQuery>[0], firstChargeAttemptAt?: string | null) =>
      createStripeHealthProvider({
        webhooks: new FakeWebhookHealthQuery(events, clock, firstChargeAttemptAt === undefined ? {} : { firstChargeAttemptAt }),
        configured: async () => true,
      }).read({ gymId, roles: ['owner'], clock });

    const noAttempt = await read([]);
    expect(noAttempt).toMatchObject({ status: 'healthy' });
    expect(noAttempt.message).toContain('No webhook has arrived yet');

    const recentAttempt = await read([], hoursAgo(23));
    expect(recentAttempt).toMatchObject({ status: 'healthy' });
    expect(recentAttempt.message).toContain('No webhook has arrived yet');

    const silent = await read([], hoursAgo(25));
    expect(silent).toMatchObject({
      status: 'warning',
      message: 'Stripe charges have been attempted for more than a day, but no Stripe webhook has arrived. Check in Stripe that this install\'s webhook endpoint (/webhooks/stripe) is enabled and points here.',
    });

    const received = await read([{ gymId, receivedAt: hoursAgo(1), processedAt: hoursAgo(1), failed: false }], hoursAgo(25));
    expect(received).toMatchObject({ status: 'healthy', message: 'Stripe webhooks are processing normally.' });
  });
  it('asks silenceCheck, with the gym of the read, before warning that no webhook has arrived', async () => {
    const gymId = uuidv7();
    const hoursAgo = (hours: number) => new Date(clock.now().getTime() - hours * 3_600_000).toISOString();
    const read = (silenceCheck?: (gymId: string) => Promise<boolean>) => createStripeHealthProvider({
      webhooks: new FakeWebhookHealthQuery([], clock, { firstChargeAttemptAt: hoursAgo(25) }),
      configured: async () => true, silenceCheck,
    }).read({ gymId, roles: ['owner'], clock });

    const off = vi.fn(async () => false);
    const quiet = await read(off);
    expect(quiet).toMatchObject({ status: 'healthy' });
    expect(quiet.message).toContain('No webhook has arrived yet');
    expect(off.mock.calls).toEqual([[gymId]]);

    const on = vi.fn(async () => true);
    for (const tile of [await read(on), await read()]) {
      expect(tile).toMatchObject({ status: 'warning', message: expect.stringContaining('no Stripe webhook has arrived') });
    }
    expect(on.mock.calls).toEqual([[gymId]]);
  });
  it('still reports a failed event when silenceCheck turns the silence warning off', async () => {
    const gymId = uuidv7();
    const hoursAgo = (hours: number) => new Date(clock.now().getTime() - hours * 3_600_000).toISOString();
    const tile = await createStripeHealthProvider({
      webhooks: new FakeWebhookHealthQuery([{ gymId, receivedAt: hoursAgo(1), processedAt: null, failed: true }], clock,
        { firstChargeAttemptAt: hoursAgo(25) }),
      configured: async () => true, silenceCheck: async () => false,
    }).read({ gymId, roles: ['owner'], clock });
    expect(tile).toMatchObject({ status: 'error', details: { failed: 1 },
      message: expect.stringContaining('1 Stripe webhook events failed to process') });
  });
  it('does not ask silenceCheck when there is no silence to warn about', async () => {
    const gymId = uuidv7();
    const hoursAgo = (hours: number) => new Date(clock.now().getTime() - hours * 3_600_000).toISOString();
    const silenceCheck = vi.fn(async () => true);
    for (const [events, firstChargeAttemptAt] of [
      [[], null],
      [[], hoursAgo(23)],
      [[{ gymId, receivedAt: hoursAgo(1), processedAt: hoursAgo(1), failed: false }], hoursAgo(25)],
    ] as const) {
      const tile = await createStripeHealthProvider({
        webhooks: new FakeWebhookHealthQuery(events, clock, { firstChargeAttemptAt }),
        configured: async () => true, silenceCheck,
      }).read({ gymId, roles: ['owner'], clock });
      expect(tile).toMatchObject({ status: 'healthy' });
    }
    expect(silenceCheck).not.toHaveBeenCalled();
  });
  it('counts only unprocessed failures when computing status and failed counts', async () => {
    const gymId = uuidv7();
    const twoDaysAgo = new Date(clock.now().getTime() - 2 * 86_400_000).toISOString();
    const read = (processedAt: string | null) => createStripeHealthProvider({
      webhooks: new FakeWebhookHealthQuery([
        { gymId, receivedAt: twoDaysAgo, processedAt, failed: true, failedAt: twoDaysAgo },
      ], clock),
      configured: async () => true,
    }).read({ gymId, roles: ['owner'], clock });

    expect(await read(twoDaysAgo)).toMatchObject({ status: 'healthy', details: { failed: 0 } });
    expect(await read(null)).toMatchObject({ status: 'error', details: { failed: 1 } });
  });
});
