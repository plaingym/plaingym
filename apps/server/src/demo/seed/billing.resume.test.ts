// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createChargeRunner } from '../../areas/billing/runner/index.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { fixture, snapshot } from './billing.fixture.test-helper.js';

const db = useTestDatabase();

describe('demo billing seed after a lost provider response', { timeout: 90_000 }, () => {
  it('retries a lost customer response without a duplicate and restores the billing switch on failure', async () => {
    const f = await fixture(db); f.gateway.payments.loseNextResponse('createCustomer');
    await expect(f.seed.run(f.context)).rejects.toThrow(/lost/);
    expect((await snapshot(db, f.gymId)).gym.billingEnabled).toBe(false);
    await f.seed.run(f.context);
    expect((await f.gateway.payments.findCustomerByEmail('rivera@example.invalid'))).toHaveLength(1);
    expect((await snapshot(db, f.gymId)).cards).toHaveLength(14);
  });

  it('resumes after a saved card response is lost, preserving the seed calendar across midnight', async () => {
    const f = await fixture(db);
    const seedCard = f.gateway.seedCard.getMockImplementation()!;
    f.gateway.seedCard.mockImplementationOnce(async (...args) => { await seedCard(...args); throw new Error('Card response lost'); });
    await expect(f.seed.run(f.context)).rejects.toThrow(/Card response lost/);
    f.clock.advance(9 * 60 * 60 * 1000); await f.seed.run(f.context);
    const rows = await snapshot(db, f.gymId);
    expect(rows.cards).toHaveLength(14);
    expect(rows.invoices.filter(row => row.status === 'past_due').map(row => row.dueOn)).toEqual(['2026-10-23', '2026-10-23']);
  });

  it('leaves an unknown charge for reconciliation and never collects it twice on a seed retry', async () => {
    const f = await fixture(db), createCharge = vi.spyOn(f.gateway.payments, 'createCharge');
    f.gateway.payments.loseNextResponse('confirmCharge');
    await expect(f.seed.run(f.context)).rejects.toThrow(/lost/);
    await expect(f.seed.run(f.context)).rejects.toThrow(/reconciliation/);
    expect(createCharge).toHaveBeenCalledTimes(1);
    expect((await snapshot(db, f.gymId)).attempts.filter(row => row.status === 'pending')).toHaveLength(1);
    const scope = db.forGym, clock = f.clock, settings = createGymSettingsAccessor({ scope, clock });
    const runner = createChargeRunner({ scope, clock, settings, transitions: createInvoiceTransitions({ scope, clock }),
      payments: async () => f.gateway.payments, jobs: { async enqueue() { throw new Error('Unexpected job'); } } });
    expect(await runner.reconcile(f.gymId)).toMatchObject({ inspected: 1, issues: [] });
    await f.seed.run(f.context);
    const rows = await snapshot(db, f.gymId);
    expect(rows.attempts.every(row => row.status !== 'pending')).toBe(true);
    expect(rows.attempts.every(row => row.attemptNumber === 1)).toBe(true);
    expect(rows.gym.billingEnabled).toBe(false);
  });
});
