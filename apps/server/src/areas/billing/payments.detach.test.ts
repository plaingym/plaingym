// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, paymentMethods, households, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { PaymentMethodCustomerDeleted, PaymentObjectNotForGym, type DetachOptions } from '../../infra/payments/index.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { createPaymentJobs } from './payments.jobs.js';
import { detachJob } from './payments.mutations.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(options: { customerMetadata?: Record<string, string> | 'own'; methodMetadata?: Record<string, string>;
  householdCustomerId?: string | null; revoked?: boolean; billingDetails?: Record<string, string>;
  scope?: typeof db.forGym } = {}) {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'CAD', billingEnabled: true });
  const home = await factory('households', gymId, { stripeCustomerId: options.householdCustomerId === undefined ? 'cus_csv' : options.householdCustomerId });
  const card = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_csv_pad', type: 'acss_debit',
    isDefault: false, revokedAt: options.revoked === false ? null : clock.now() });
  const stripe = new StripeFixtures(gymId);
  stripe.objects.clear();
  stripe.objects.set('cus_csv', { id: 'cus_csv', object: 'customer', email: 'payer@example.invalid',
    metadata: options.customerMetadata === 'own' ? { gym_id: gymId } : options.customerMetadata ?? {} });
  stripe.objects.set('pm_csv_pad', { id: 'pm_csv_pad', object: 'payment_method', created: stripe.now, type: 'acss_debit',
    customer: 'cus_csv', metadata: options.methodMetadata ?? {}, billing_details: options.billingDetails ?? {
      name: 'Payer', email: 'payer@example.invalid', phone: '+12025550123', address: '1 Test Street' },
    acss_debit: { bank_name: 'STRIPE TEST BANK', last4: '6789' } });
  const provider = new StripePayments(gymId, { transport: stripe, webhookSecret: 'whsec_SYNTHETIC' });
  const detachErrors: unknown[] = [];
  const detachCard = vi.fn(async (_gym: string, id: string, detachOptions?: DetachOptions) => {
    assertNoTransaction('detachCard');
    try { await provider.detachPaymentMethod(id, detachOptions); }
    catch (error) { detachErrors.push(error); throw error; }
  });
  const adoptCustomer = vi.fn(async (_gym: string, id: string) => {
    assertNoTransaction('adoptCustomer');
    return provider.adoptCustomer(id);
  });
  const handler = createPaymentJobs({ scope: options.scope ?? db.forGym, notifications: {} as never, detachCard, adoptCustomer })
    .find(job => job.id === detachJob)!.handler;
  const run = (payload: unknown = { paymentMethodId: card.id }) => handler(payload, {
    jobId: 'job_detach', gymId, timezone: 'UTC', attempt: 1, clock });
  const audits = (action?: string) => db.forGym(gymId, tx => action
    ? tx.select().from(auditEvents).where(eq(auditEvents.action, action))
    : tx.select().from(auditEvents));
  return { gymId, clock, home, card, stripe, detachCard, detachErrors, adoptCustomer, run, audits };
}

describe('detaching a card whose customer is linked by a people CSV', () => {
  it('adopts the household’s untagged customer, audits once, and detaches the method', async () => {
    const f = await fixture();
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.stripe.objects.get('cus_csv')!.metadata).toEqual({ gym_id: f.gymId });
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBeNull();
    const adopted = await f.audits('billing.customer.adopted');
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ targetType: 'household', targetId: f.home.id,
      after: { customerId: 'cus_csv', paymentMethodId: f.card.id, source: 'detach' } });
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
    await expect(f.run()).resolves.toBeUndefined();
    expect(await f.audits('billing.customer.adopted')).toHaveLength(1);
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
  });

  it('refuses to adopt a customer tagged for another gym and writes nothing', async () => {
    const otherGymId = uuidv7();
    const f = await fixture({ customerMetadata: { gym_id: otherGymId } });
    const rejection = await f.run().catch(error => error);
    expect(rejection).toBe(f.detachErrors[0]);
    expect(f.adoptCustomer).toHaveBeenCalledOnce();
    expect(f.stripe.requests.filter(request => request.method === 'POST'
      && request.path === '/v1/customers/cus_csv')).toHaveLength(0);
    expect(await f.audits()).toHaveLength(0);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');
  });

  it('redacts the billing details before both detach attempts when the erasure asks for it', async () => {
    const f = await fixture();
    await expect(f.run({ paymentMethodId: f.card.id, redactBillingDetails: true })).resolves.toBeUndefined();
    expect(f.detachCard).toHaveBeenCalledTimes(2);
    expect(f.detachCard).toHaveBeenNthCalledWith(1, f.gymId, 'pm_csv_pad', { redactBillingDetails: true });
    expect(f.detachCard).toHaveBeenNthCalledWith(2, f.gymId, 'pm_csv_pad', { redactBillingDetails: true });
    const method = f.stripe.objects.get('pm_csv_pad')!;
    expect(method.customer).toBeNull();
    expect(method.billing_details).toEqual({ name: 'Erased member', email: 'erased-member@example.com', phone: null, address: null });
  });

  it('detaches a gym-tagged customer with no adoption call or audit', async () => {
    const f = await fixture({ customerMetadata: 'own' });
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    expect(await f.audits('billing.customer.adopted')).toHaveLength(0);
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBeNull();
  });

  it('does not adopt when the household has no stored customer link', async () => {
    const f = await fixture({ householdCustomerId: null });
    const rejection = await f.run().catch(error => error);
    expect(rejection).toBe(f.detachErrors[0]);
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    expect(await f.audits()).toHaveLength(0);
  });

  it('retries a transient refusal without adopting, and a later successful run writes no adoption audit', async () => {
    const f = await fixture(), unavailable = Object.assign(new Error('unavailable'), { statusCode: 503 });
    f.detachCard.mockRejectedValueOnce(unavailable);
    await expect(f.run()).rejects.toBe(unavailable);
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    f.detachCard.mockResolvedValueOnce(undefined);
    await expect(f.run()).resolves.toBeUndefined();
    expect(await f.audits('billing.customer.adopted')).toHaveLength(0);
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
  });

  it.each([
    ['a lost connection', () => Object.assign(new Error('connection lost'), { type: 'StripeConnectionError' })],
    ['a missing key permission', () => new Error('Check the Stripe permission for Payment Methods',
      { cause: Object.assign(new Error('forbidden'), { statusCode: 403 }) })],
  ])('retries %s without adopting a gym-tagged customer or auditing an adoption', async (_name, failure) => {
    const f = await fixture({ customerMetadata: 'own' }), error = failure();
    f.detachCard.mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    expect(f.detachCard).toHaveBeenCalledOnce();
    await expect(f.run()).resolves.toBeUndefined();
    expect(await f.audits('billing.customer.adopted')).toHaveLength(0);
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
  });

  it('rethrows the second detach refusal while keeping the adoption audit once the tag was written', async () => {
    const otherGymId = uuidv7();
    const f = await fixture({ methodMetadata: { gym_id: otherGymId } });
    const rejection = await f.run().catch(error => error);
    expect(f.detachErrors).toHaveLength(2);
    expect(rejection).toBe(f.detachErrors[1]);
    expect(f.adoptCustomer).toHaveBeenCalledOnce();
    expect(f.stripe.objects.get('cus_csv')!.metadata).toEqual({ gym_id: f.gymId });
    const adopted = await f.audits('billing.customer.adopted');
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ targetType: 'household', targetId: f.home.id,
      after: { customerId: 'cus_csv', paymentMethodId: f.card.id, source: 'detach' } });
    expect(await f.audits('billing.card.detached')).toHaveLength(0);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');
    await expect(f.run()).rejects.toThrow();
    expect(await f.audits('billing.customer.adopted')).toHaveLength(1);
  });

  it('detaches without an adoption audit when a 400 refusal triggers adoption on an already-tagged customer', async () => {
    const f = await fixture({ customerMetadata: 'own' });
    const refused = Object.assign(new Error('Invalid request'), { statusCode: 400 });
    f.detachCard.mockRejectedValueOnce(refused);
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.adoptCustomer).toHaveBeenCalledOnce();
    await expect(f.adoptCustomer.mock.results[0]!.value).resolves.toMatchObject({ adopted: false });
    expect(f.detachCard).toHaveBeenCalledTimes(2);
    expect(await f.audits('billing.customer.adopted')).toHaveLength(0);
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBeNull();
  });

  it('calls neither detach nor adoption for a row that is not revoked', async () => {
    const f = await fixture({ revoked: false });
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.detachCard).not.toHaveBeenCalled();
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    expect(await f.audits()).toHaveLength(0);
    const [row] = await db.forGym(f.gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, f.card.id)));
    expect(row).toMatchObject({ householdId: f.home.id, revokedAt: null });
    expect(await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, f.home.id)))).toHaveLength(1);
  });

  it('retries a failed adoption audit once and detaches, and fails without detaching when it fails twice', async () => {
    const runWithFailures = async (failures: number) => {
      let remaining = 0;
      const errors: Error[] = [];
      const scope: typeof db.forGym = (gymId, fn) => {
        if (remaining > 0) {
          remaining--;
          const error = new Error(`audit write failed (${remaining} remaining)`);
          errors.push(error);
          return Promise.reject(error);
        }
        return db.forGym(gymId, fn);
      };
      const f = await fixture({ scope });
      const realAdopt = f.adoptCustomer.getMockImplementation()!;
      f.adoptCustomer.mockImplementationOnce(async (gymId, id) => {
        const result = await realAdopt(gymId, id);
        remaining = failures;
        return result;
      });
      return { f, errors };
    };

    const once = await runWithFailures(1);
    await expect(once.f.run()).resolves.toBeUndefined();
    expect(once.errors).toHaveLength(1);
    expect(once.f.stripe.objects.get('pm_csv_pad')!.customer).toBeNull();
    expect(await once.f.audits('billing.customer.adopted')).toHaveLength(1);
    expect(await once.f.audits('billing.card.detached')).toHaveLength(1);

    const twice = await runWithFailures(2);
    const rejection = await twice.f.run().catch(error => error);
    expect(twice.errors).toHaveLength(2);
    expect(rejection).toBe(twice.errors[1]);
    expect(twice.f.stripe.objects.get('cus_csv')!.metadata).toEqual({ gym_id: twice.f.gymId });
    expect(twice.f.stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');
    expect(await twice.f.audits('billing.customer.adopted')).toHaveLength(0);
    expect(await twice.f.audits('billing.card.detached')).toHaveLength(0);
  });
});

describe('detaching a card after a last-member erasure cleared the household’s customer link', () => {
  const erased = (paymentMethodId: string, customerId?: unknown) =>
    ({ paymentMethodId, redactBillingDetails: true, ...(customerId === undefined ? {} : { customerId }) });
  const original = { name: 'Payer', email: 'payer@example.invalid', phone: '+12025550123', address: '1 Test Street' };

  it('adopts the customer the erasure read, redacts and detaches the method, and audits once', async () => {
    const f = await fixture({ householdCustomerId: null });
    await expect(f.run(erased(f.card.id, 'cus_csv'))).resolves.toBeUndefined();
    expect(f.detachCard).toHaveBeenCalledTimes(2);
    expect(f.detachCard).toHaveBeenNthCalledWith(1, f.gymId, 'pm_csv_pad', { redactBillingDetails: true });
    expect(f.detachCard).toHaveBeenNthCalledWith(2, f.gymId, 'pm_csv_pad', { redactBillingDetails: true });
    expect(f.stripe.objects.get('cus_csv')!.metadata).toEqual({ gym_id: f.gymId });
    const method = f.stripe.objects.get('pm_csv_pad')!;
    expect(method.customer).toBeNull();
    expect(method.billing_details).toEqual({ name: 'Erased member', email: 'erased-member@example.com', phone: null, address: null });
    const adopted = await f.audits('billing.customer.adopted');
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ targetType: 'household', targetId: f.home.id,
      after: { customerId: 'cus_csv', paymentMethodId: f.card.id, source: 'detach' } });
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
    await expect(f.run(erased(f.card.id, 'cus_csv'))).resolves.toBeUndefined();
    expect(await f.audits('billing.customer.adopted')).toHaveLength(1);
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
  });

  it('keeps a payload queued without the customer ID refused, as before', async () => {
    const f = await fixture({ householdCustomerId: null });
    const rejection = await f.run(erased(f.card.id)).catch(error => error);
    expect(rejection).toBe(f.detachErrors[0]);
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    expect(await f.audits()).toHaveLength(0);
    const method = f.stripe.objects.get('pm_csv_pad')!;
    expect(method.customer).toBe('cus_csv');
    expect(method.billing_details).toEqual(original);
  });

  it('refuses a carried customer tagged for another gym and writes nothing', async () => {
    const f = await fixture({ householdCustomerId: null, customerMetadata: { gym_id: uuidv7() } });
    const rejection = await f.run(erased(f.card.id, 'cus_csv')).catch(error => error);
    expect(rejection).toBe(f.detachErrors[0]);
    expect(f.adoptCustomer).toHaveBeenCalledOnce();
    expect(f.stripe.requests.filter(request => request.method === 'POST'
      && request.path === '/v1/customers/cus_csv')).toHaveLength(0);
    expect(await f.audits()).toHaveLength(0);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');
  });

  it('leaves a method on a different customer than the carried one attached', async () => {
    const f = await fixture({ householdCustomerId: null });
    f.stripe.objects.set('cus_other', { id: 'cus_other', object: 'customer', email: null, metadata: {} });
    const rejection = await f.run(erased(f.card.id, 'cus_other')).catch(error => error);
    expect(f.detachErrors).toHaveLength(2);
    expect(rejection).toBe(f.detachErrors[1]);
    const adopted = await f.audits('billing.customer.adopted');
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ targetType: 'household', targetId: f.home.id,
      after: { customerId: 'cus_other', paymentMethodId: f.card.id, source: 'detach' } });
    expect(await f.audits('billing.card.detached')).toHaveLength(0);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');
    expect(f.stripe.objects.get('cus_csv')!.metadata).toEqual({});
  });

  it('adopts the stored link over a carried customer ID', async () => {
    const f = await fixture({ householdCustomerId: 'cus_csv' });
    f.stripe.objects.set('cus_other', { id: 'cus_other', object: 'customer', email: null, metadata: {} });
    await expect(f.run(erased(f.card.id, 'cus_other'))).resolves.toBeUndefined();
    expect(f.adoptCustomer).toHaveBeenCalledOnce();
    expect(f.adoptCustomer).toHaveBeenCalledWith(f.gymId, 'cus_csv');
    expect(f.detachCard).toHaveBeenCalledTimes(2);
    expect(f.stripe.objects.get('cus_csv')!.metadata).toEqual({ gym_id: f.gymId });
    expect(f.stripe.objects.get('cus_other')!.metadata).toEqual({});
    const method = f.stripe.objects.get('pm_csv_pad')!;
    expect(method.customer).toBeNull();
    expect(method.billing_details).toEqual({ name: 'Erased member', email: 'erased-member@example.com', phone: null, address: null });
    const adopted = await f.audits('billing.customer.adopted');
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ after: { customerId: 'cus_csv', paymentMethodId: f.card.id, source: 'detach' } });
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
  });

  it.each([['a number', 42], ['a malformed ID', 'cus csv'], ['an empty string', '']])(
    'ignores %s as the carried customer ID', async (_name, customerId) => {
      const f = await fixture({ householdCustomerId: null });
      const rejection = await f.run(erased(f.card.id, customerId)).catch(error => error);
      expect(rejection).toBe(f.detachErrors[0]);
      expect(f.adoptCustomer).not.toHaveBeenCalled();
      expect(await f.audits()).toHaveLength(0);
    });

  it('retries a transient refusal without adopting the carried customer', async () => {
    const f = await fixture({ householdCustomerId: null }), unavailable = Object.assign(new Error('unavailable'), { statusCode: 503 });
    f.detachCard.mockRejectedValueOnce(unavailable);
    await expect(f.run(erased(f.card.id, 'cus_csv'))).rejects.toBe(unavailable);
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    expect(f.stripe.objects.get('cus_csv')!.metadata).toEqual({});
  });
});

describe('detaching a card whose own Stripe customer was deleted', () => {
  it('finishes with one card detached audit, no detach request and no adoption, also when the job runs again', async () => {
    const f = await fixture({ householdCustomerId: 'cus_gone' });
    const gone = await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_gone', type: 'card',
      isDefault: false, revokedAt: f.clock.now() });
    f.stripe.objects.set('cus_gone', { id: 'cus_gone', object: 'customer', deleted: true });
    f.stripe.objects.set('pm_gone', { id: 'pm_gone', object: 'payment_method', created: f.stripe.now, type: 'card',
      customer: 'cus_gone', metadata: {}, billing_details: { name: 'Payer' }, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
    const payload = { paymentMethodId: gone.id, redactBillingDetails: true };
    await expect(f.run(payload)).resolves.toBeUndefined();
    expect(f.detachErrors[0]).toBeInstanceOf(PaymentMethodCustomerDeleted);
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    const detached = await f.audits('billing.card.detached');
    expect(detached).toHaveLength(1);
    expect(detached[0]).toMatchObject({ actorKind: 'system', targetType: 'payment_method', targetId: gone.id });
    expect(await f.audits('billing.customer.adopted')).toHaveLength(0);
    await expect(f.run(payload)).resolves.toBeUndefined();
    expect(await f.audits('billing.card.detached')).toHaveLength(1);
    expect(f.stripe.requests.filter(request => request.method === 'POST' && request.path.startsWith('/v1/payment_methods/pm_gone'))).toHaveLength(0);
    expect(f.stripe.objects.get('pm_gone')).toMatchObject({ customer: 'cus_gone', billing_details: { name: 'Payer' } });
  });

  it('still fails a card on another gym’s customer with the refusal and records no detach', async () => {
    const f = await fixture({ customerMetadata: { gym_id: uuidv7() } });
    const rejection = await f.run({ paymentMethodId: f.card.id, redactBillingDetails: true }).catch(error => error);
    expect(rejection).toBeInstanceOf(PaymentObjectNotForGym);
    expect(rejection).not.toBeInstanceOf(PaymentMethodCustomerDeleted);
    expect(await f.audits('billing.card.detached')).toHaveLength(0);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');
  });

  it('still fails a card whose customer is missing at Stripe', async () => {
    const f = await fixture();
    f.stripe.objects.delete('cus_csv');
    await expect(f.run()).rejects.toBeDefined();
    expect(f.detachErrors[0]).not.toBeInstanceOf(PaymentMethodCustomerDeleted);
    expect(await f.audits('billing.card.detached')).toHaveLength(0);
  });
});
