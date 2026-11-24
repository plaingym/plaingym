// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { plans, waiverTemplates, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { maxJoinDocuments } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { createGoLiveService } from './go-live.js';

const db = useTestDatabase(), factory = createFactories(db);
const clock = new TestClock('2026-10-26T06:30:00Z');
const intro = 'Visitors see “Online joining is not available right now” at /join.';
const billing = 'Turn billing on.', stripe = 'Connect Stripe in Settings → Integrations → Payments.';
const documents = 'Add a waiver or agreement in Waivers and agreements.';
const noPlans = 'Add an active plan in the gym\'s currency.';

async function fixture(options: { billingEnabled?: boolean; stripe?: boolean; waivers?: number; plans?: number; resolver?: boolean } = {}) {
  const { billingEnabled = true, stripe: connected = true, waivers = 1, plans: planCount = 1, resolver = true } = options;
  const gymId = uuidv7();
  await factory('gyms', gymId, { billingEnabled, ...(connected ? { stripeConfig: 'opaque-encrypted-configuration' } : {}) });
  for (let index = 0; index < waivers; index++) await factory('waiverTemplates', gymId, { name: `Waiver ${index}` });
  for (let index = 0; index < planCount; index++) await factory('plans', gymId);
  const service = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true,
    ...(resolver ? { paymentsConfigured: async () => connected } : {}) });
  const find = async (id: string) => (await service.checklist(gymId)).items.find(item => item.id === id)!;
  const joining = () => find('online_joining');
  return { gymId, joining, find };
}

describe('go-live online joining item', () => {
  it('is ready with billing on, Stripe connected and one current document', async () => {
    expect(await (await fixture()).joining()).toEqual({ id: 'online_joining', status: 'ready', message: 'Visitors can join and pay online at /join.' });
  });
  it('asks for billing when it is off', async () => {
    expect(await (await fixture({ billingEnabled: false })).joining())
      .toEqual({ id: 'online_joining', status: 'needs_attention', message: `${intro} ${billing}` });
  });
  it('asks for Stripe when none is configured', async () => {
    const item = await (await fixture({ stripe: false })).joining();
    expect(item.status).toBe('needs_attention');
    expect(item.message).toBe(`${intro} ${stripe}`);
  });
  it('names a failed Stripe read instead of missing Stripe when the resolver throws', async () => {
    const gymId = uuidv7();
    await factory('gyms', gymId, { billingEnabled: true, stripeConfig: 'opaque-encrypted-configuration' });
    await factory('waiverTemplates', gymId, { name: 'Waiver 0' });
    await factory('plans', gymId);
    const service = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true,
      paymentsConfigured: async () => { throw new Error('secret key'); } });
    const restore = setLogSink(() => {});
    try {
      const item = (await service.checklist(gymId)).items.find(entry => entry.id === 'online_joining')!;
      expect(item.status).toBe('needs_attention');
      expect(item.message).toBe(`${intro} Stripe could not be checked: check the saved keys in Settings → Integrations → Payments.`);
      expect(item.message).not.toContain(stripe);
    } finally { setLogSink(restore); }
  });
  it('asks for a document when there is none, or when every family is retired', async () => {
    expect((await (await fixture({ waivers: 0 })).joining()).message).toBe(`${intro} ${documents}`);
    const retired = await fixture();
    await db.forGym(retired.gymId, tx => tx.update(waiverTemplates).set({ retiredAt: clock.now() }).where(eq(waiverTemplates.gymId, retired.gymId)));
    expect((await retired.joining()).message).toBe(`${intro} ${documents}`);
  });
  it('allows eight current documents and asks to retire some beyond that', async () => {
    expect((await (await fixture({ waivers: maxJoinDocuments })).joining()).status).toBe('ready');
    expect((await (await fixture({ waivers: maxJoinDocuments + 1 })).joining()).message)
      .toBe(`${intro} Retire documents until at most eight are current.`);
  });
  it('lists every missing piece in order: billing, Stripe, documents', async () => {
    expect((await (await fixture({ billingEnabled: false, stripe: false, waivers: 0 })).joining()).message)
      .toBe(`${intro} ${billing} ${stripe} ${documents}`);
  });
  it('lists the missing plan last', async () => {
    expect((await (await fixture({ billingEnabled: false, stripe: false, waivers: 0, plans: 0 })).joining()).message)
      .toBe(`${intro} ${billing} ${stripe} ${documents} ${noPlans}`);
  });
  it('counts only this gym\'s documents', async () => {
    const empty = await fixture({ waivers: 0 });
    await fixture({ waivers: 2 });
    expect((await empty.joining()).message).toBe(`${intro} ${documents}`);
  });
  it('asks for a plan when there is none', async () => {
    expect(await (await fixture({ plans: 0 })).joining())
      .toEqual({ id: 'online_joining', status: 'needs_attention', message: `${intro} ${noPlans}` });
  });
  it('asks for a plan when the only plan is inactive', async () => {
    const inactive = await fixture();
    await db.forGym(inactive.gymId, tx => tx.update(plans).set({ active: false }).where(eq(plans.gymId, inactive.gymId)));
    expect(await inactive.joining()).toEqual({ id: 'online_joining', status: 'needs_attention', message: `${intro} ${noPlans}` });
  });
  it('accepts an active free plan', async () => {
    const free = await fixture();
    await db.forGym(free.gymId, tx => tx.update(plans).set({ amountCents: 0 }).where(eq(plans.gymId, free.gymId)));
    expect((await free.joining()).status).toBe('ready');
  });
  it('counts only this gym\'s plans', async () => {
    const empty = await fixture({ plans: 0 });
    await fixture({ plans: 1 });
    expect(await empty.joining()).toEqual({ id: 'online_joining', status: 'needs_attention', message: `${intro} ${noPlans}` });
  });
});

describe('go-live online joining without a payments resolver', () => {
  it('is ready when the gym has a stored Stripe configuration', async () => {
    const f = await fixture({ resolver: false });
    expect((await f.joining()).status).toBe('ready');
    expect((await f.find('stripe_ready')).status).toBe('ready');
  });
  it('asks for Stripe when the gym has no stored configuration', async () => {
    const f = await fixture({ resolver: false, stripe: false });
    expect(await f.joining()).toEqual({ id: 'online_joining', status: 'needs_attention', message: `${intro} ${stripe}` });
    expect(await f.find('stripe_ready')).toEqual({ id: 'stripe_ready', status: 'needs_attention', message: 'Payments are not configured yet.' });
  });
});
