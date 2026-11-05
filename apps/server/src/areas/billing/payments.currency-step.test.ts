// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { invoices, paymentAttempts, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createInvoiceTransitions } from './transitions/index.js';
import { createPaymentService } from './payments.js';
import { createChargeRunner } from './runner/index.js';

const db = useTestDatabase(), factory = createFactories(db);

/** A gym in `currency` with one household, its saved card, and the payment service over the real runner and transitions. */
async function fixture(currency: string) {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency, billingEnabled: true });
  const user = await factory('authUser', gymId), home = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
  await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_4242', isDefault: true });
  const provider = new FakePayments(gymId, clock); provider.seedCustomer({ id: 'cus_fixture', email: 'payer@example.invalid' });
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }), jobs: new FakeJobs(clock),
    paymentsFor: async () => provider, transitions: createInvoiceTransitions({ scope: db.forGym, clock }) };
  const runner = createChargeRunner({ ...options, payments: async () => provider });
  const service = createPaymentService({ ...options, runner });
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const create = (amountCents: number) => service.createOneOff(context,
    { source: 'custom', householdId: home.id, dueOn: '2026-10-25', description: 'Drop-in', amountCents, currency });
  /** An invoice stored with `amountCents` as is, as one written before the step was checked would be. */
  const stored = async (amountCents: number) => {
    const bill = await create(minorStep(currency) * 1000);
    await db.forGym(gymId, tx => tx.update(invoices).set({ amountCents }).where(eq(invoices.id, bill.id)));
    return bill;
  };
  const cash = (invoiceId: string, amountCents: number) =>
    service.manualPayment(context, invoiceId, { amountCents, currency, method: 'cash', paidAt: clock.now().toISOString() });
  const attempts = (invoiceId: string) => db.forGym(gymId, tx => tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoiceId)));
  return { gymId, context, provider, runner, service, create, stored, cash, attempts };
}
const minorStep = (currency: string) => currency === 'ISK' ? 100 : currency === 'KWD' ? 10 : 1;

describe('card refunds on the currency step', () => {
  it.each([['KWD', 12_500, 1_255, 1_250], ['ISK', 50_000, 550, 500]] as const)(
    'refuses a %s card refund of %i off the step but refunds cash in any minor unit', async (currency, total, offStep, onStep) => {
      const f = await fixture(currency), bill = await f.create(total);
      expect(await f.service.charge(f.context, bill.id)).toMatchObject({ status: 'succeeded' });
      const card = (await f.service.getInvoice(f.gymId, bill.id)).payments[0]!, refund = vi.spyOn(f.provider, 'refund');
      await expect(f.service.refund(f.context, card.id, { amountCents: offStep, currency, reason: null }))
        .rejects.toMatchObject({ code: 'conflict', details: { reason: ['refund_off_step'] } });
      expect(refund).not.toHaveBeenCalled();
      expect((await f.service.getInvoice(f.gymId, bill.id)).refunds).toEqual([]);
      expect(await f.service.refund(f.context, card.id, { amountCents: onStep, currency, reason: null })).toMatchObject({ status: 'succeeded' });
      expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amount: onStep }));

      const paid = await f.create(total), payment = await f.cash(paid.id, total);
      expect(await f.service.refund(f.context, payment.id, { amountCents: offStep, currency, reason: null })).toMatchObject({ status: 'succeeded' });
      expect(refund).toHaveBeenCalledTimes(1);
    });
});

describe('card charges Stripe would refuse', () => {
  it.each([['USD', 49], ['JPY', 49], ['CAD', 1]] as const)(
    'skips a %s invoice of %i below the minimum charge and leaves it open for a manual payment', async (currency, amount) => {
      const f = await fixture(currency), bill = await f.create(amount), create = vi.spyOn(f.provider, 'createCharge');
      expect(await f.runner.charge(f.gymId, bill.id, { mode: 'staff', context: f.context })).toEqual({ status: 'skipped', reason: 'below_minimum' });
      await expect(f.service.charge(f.context, bill.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['below_minimum'] } });
      expect(create).not.toHaveBeenCalled(); expect(await f.attempts(bill.id)).toEqual([]);
      expect((await f.service.getInvoice(f.gymId, bill.id)).invoice.status).toBe('open');
      await f.cash(bill.id, amount);
      expect((await f.service.getInvoice(f.gymId, bill.id)).invoice.status).toBe('paid');
    });
  it.each([['USD', 50], ['JPY', 50], ['KWD', 10]] as const)('charges a %s invoice of %i at or above the minimum', async (currency, amount) => {
    const f = await fixture(currency), bill = await f.create(amount);
    expect(await f.service.charge(f.context, bill.id)).toMatchObject({ status: 'succeeded', amountCents: amount });
  });
  it.each([['KWD', 1_255], ['ISK', 555]] as const)('skips a %s invoice stored off the step at %i', async (currency, amount) => {
    const f = await fixture(currency), bill = await f.stored(amount), create = vi.spyOn(f.provider, 'createCharge');
    await expect(f.service.charge(f.context, bill.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['off_step'] } });
    expect(create).not.toHaveBeenCalled(); expect(await f.attempts(bill.id)).toEqual([]);
    await f.cash(bill.id, amount);
    expect((await f.service.getInvoice(f.gymId, bill.id)).invoice.status).toBe('paid');
  });
  it.each([['KWD', 1_255], ['ISK', 550]] as const)('refuses a custom %s invoice of %i off the step', async (currency, amount) => {
    const f = await fixture(currency);
    await expect(f.create(amount)).rejects.toThrow(/multiple of/);
  });
});
