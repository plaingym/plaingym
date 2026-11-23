// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { waiverTemplates, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { maxJoinDocuments } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createGoLiveService } from './go-live.js';

const db = useTestDatabase(), factory = createFactories(db);
const clock = new TestClock('2026-10-26T06:30:00Z');
const intro = 'Visitors see “Online joining is not available right now” at /join.';
const billing = 'Turn billing on.', stripe = 'Connect Stripe in Settings → Integrations → Payments.';
const documents = 'Add a waiver or agreement in Waivers and agreements.';

async function fixture(options: { billingEnabled?: boolean; stripe?: boolean; waivers?: number } = {}) {
  const { billingEnabled = true, stripe: connected = true, waivers = 1 } = options;
  const gymId = uuidv7();
  await factory('gyms', gymId, { billingEnabled, ...(connected ? { stripeConfig: 'opaque-encrypted-configuration' } : {}) });
  for (let index = 0; index < waivers; index++) await factory('waiverTemplates', gymId, { name: `Waiver ${index}` });
  const service = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true, paymentsConfigured: async () => connected });
  const joining = async () => (await service.checklist(gymId)).items.find(item => item.id === 'online_joining')!;
  return { gymId, joining };
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
  it('counts only this gym\'s documents', async () => {
    const empty = await fixture({ waivers: 0 });
    await fixture({ waivers: 2 });
    expect((await empty.joining()).message).toBe(`${intro} ${documents}`);
  });
});
