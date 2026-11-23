// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments, type DetachOptions } from '../../infra/payments/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createPaymentService } from './payments.js';
import { createPaymentJobs } from './payments.jobs.js';
import { cardDetachedAction, detachJob } from './payments.mutations.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
  const user = await factory('authUser', gymId), home = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
  const card = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_4242', isDefault: true });
  const other = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_other', isDefault: false });
  const provider = new FakePayments(gymId, clock), jobs = new FakeJobs(clock), settings = createGymSettingsAccessor({ scope: db.forGym });
  const detachCard = vi.fn(async (_gym: string, _id: string, _options?: DetachOptions) => { assertNoTransaction('detachCard'); });
  const service = createPaymentService({ scope: db.forGym, clock, settings, jobs, detachCard, paymentsFor: async () => provider });
  createServerRegistry({ jobs: createPaymentJobs({ scope: db.forGym, detachCard, notifications: {} as never }) }).registerJobs(jobs, new Set());
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const detached = (gym = gymId) => db.forGym(gym, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, cardDetachedAction)));
  const list = async (household = home.id, gym = gymId) => (await service.listPaymentMethods(gym, household, {})).data;
  return { gymId, clock, home, card, other, jobs, detachCard, service, context, detached, list };
}

describe('a finished card removal', () => {
  it('is returned and listed as finished, with one audit and no state on active cards', async () => {
    const f = await fixture();
    expect((await f.service.revokeCard(f.context, f.home.id, f.card.id)).removal).toBe('finished');
    const rows = await f.list();
    expect(rows.find(r => r.id === f.card.id)).toMatchObject({ removal: 'finished' });
    const active = rows.filter(r => r.revokedAt === null);
    expect(active.length).toBeGreaterThan(0);
    for (const row of active) expect('removal' in row).toBe(false);
    const audits = await f.detached();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ targetType: 'payment_method', targetId: f.card.id, after: { householdId: f.home.id } });
  });

  it('stays pending after a Stripe outage until the queued detach job finishes it', async () => {
    const f = await fixture(); f.detachCard.mockRejectedValueOnce(new Error('Stripe unavailable'));
    await expect(f.service.revokeCard(f.context, f.home.id, f.card.id)).rejects.toThrow('Stripe unavailable');
    expect((await f.list()).find(r => r.id === f.card.id)).toMatchObject({ revokedAt: expect.any(String), removal: 'pending' });
    expect(await f.detached()).toHaveLength(0);
    await f.jobs.runNext();
    expect((await f.list()).find(r => r.id === f.card.id)).toMatchObject({ removal: 'finished' });
    expect(await f.detached()).toHaveLength(1);
  });

  it('is recorded once however often the removal or its job is repeated', async () => {
    const f = await fixture();
    await f.service.revokeCard(f.context, f.home.id, f.card.id);
    await f.service.revokeCard(f.context, f.home.id, f.card.id);
    for (let i = 0; i < 5 && await f.jobs.runNext(); i++) { /* bounded drain */ }
    const calls = f.detachCard.mock.calls.length;
    await f.jobs.enqueue(detachJob, { paymentMethodId: f.card.id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: 'detach:again' });
    await f.jobs.runNext();
    expect(f.detachCard.mock.calls.length).toBe(calls + 1);
    expect(await f.detached()).toHaveLength(1);
    const revoked = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'billing.card.revoked'), eq(auditEvents.targetId, f.card.id))));
    expect(revoked).toHaveLength(1);
  });

  it('is not recorded by a detach job for a card that is still active', async () => {
    const f = await fixture();
    await f.jobs.enqueue(detachJob, { paymentMethodId: f.other.id }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: 'detach:' + f.other.id });
    await f.jobs.runNext();
    expect(f.detachCard).not.toHaveBeenCalled();
    expect(await f.detached()).toHaveLength(0);
  });

  it('is not visible to another household or gym', async () => {
    const f = await fixture();
    await f.service.revokeCard(f.context, f.home.id, f.card.id);
    const sibling = await factory('households', f.gymId);
    expect(await f.list(sibling.id)).toEqual([]);
    const gymB = uuidv7(); await factory('gyms', gymB, { currency: 'USD', billingEnabled: true });
    await expect(f.list(f.home.id, gymB)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.detached(gymB)).toHaveLength(0);
  });
});
