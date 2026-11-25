// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, households, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import type { DetachOptions } from '../../infra/payments/index.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createPaymentService } from '../billing/payments.js';
import { createPaymentJobs } from '../billing/payments.jobs.js';
import { cardDetachedAction, detachJob } from '../billing/payments.mutations.js';
import { createMembersService } from './members.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymId = uuidv7(), clock = new TestClock('2026-11-23T12:00:00Z');
const service = createMembersService({ scope: database.forGym, clock });
beforeAll(async () => { await factory('gyms', gymId); });

async function fixture(customerId: string | null, members = 1) {
  const home = await factory('households', gymId, { stripeCustomerId: customerId });
  const people = [];
  for (let index = 0; index < members; index++) people.push(await factory('members', gymId, { householdId: home.id }));
  const card = await factory('paymentMethods', gymId, { householdId: home.id, type: 'acss_debit', isDefault: true });
  return { home, person: people[0]!, card };
}
async function erase(personId: string) {
  const jobs = new FakeJobs(clock);
  await service.eraseMember({ gymId, actor: { kind: 'system' } }, personId, { revision: 1 }, { jobs, timezone: 'UTC' });
  return jobs.jobs.filter(job => job.name === detachJob);
}

describe('the detach job a last-member erasure queues', () => {
  it('carries the customer ID the erasure cleared from the household', async () => {
    const { home, person, card } = await fixture('cus_csv');
    const detaches = await erase(person.id);
    expect(detaches).toHaveLength(1);
    expect(detaches[0]!.payload).toEqual({ paymentMethodId: card.id, redactBillingDetails: true, customerId: 'cus_csv' });
    expect(detaches[0]!.options).toMatchObject({ idempotencyKey: `detach:${card.id}`, maxAttempts: 12 });
    expect(detaches[0]!.runAt).toEqual(new Date(clock.now().getTime() + 60_000));
    const [stored] = await database.forGym(gymId, tx => tx.select().from(households).where(eq(households.id, home.id)));
    expect(stored!.stripeCustomerId).toBeNull();
  });

  it('carries no customer ID when the household had none', async () => {
    const { person, card } = await fixture(null);
    const detaches = await erase(person.id);
    expect(detaches).toHaveLength(1);
    expect(detaches[0]!.payload).toEqual({ paymentMethodId: card.id, redactBillingDetails: true });
    expect(detaches[0]!.payload).not.toHaveProperty('customerId');
    expect(detaches[0]!.options).toMatchObject({ idempotencyKey: `detach:${card.id}` });
  });

  it('queues no detach when another member of the household remains', async () => {
    const { person } = await fixture('cus_csv', 2);
    expect(await erase(person.id)).toEqual([]);
  });
});

describe('a detach job queued before a last-member erasure', () => {
  async function preErasureFixture(options: {
    customerId?: string | null;
    methodCustomerId?: string;
    customerMetadata?: Record<string, string>;
    revoked?: boolean;
  } = {}) {
    const gym = uuidv7(), testClock = new TestClock('2026-11-23T12:00:00Z');
    await factory('gyms', gym, { currency: 'CAD', billingEnabled: true });
    const user = await factory('authUser', gym);
    const householdCustomerId = options.customerId === undefined ? 'cus_csv' : options.customerId;
    const stripeCustomerId = options.methodCustomerId ?? householdCustomerId ?? 'cus_csv';
    const home = await factory('households', gym, { stripeCustomerId: householdCustomerId });
    const person = await factory('members', gym, { householdId: home.id });
    const card = await factory('paymentMethods', gym, {
      householdId: home.id, processorId: 'pm_csv_pad', type: 'acss_debit',
      isDefault: options.revoked ? false : true, revokedAt: options.revoked ? testClock.now() : null,
    });
    const stripe = new StripeFixtures(gym);
    stripe.objects.clear();
    stripe.objects.set(stripeCustomerId, {
      id: stripeCustomerId, object: 'customer', email: 'payer@example.invalid',
      metadata: options.customerMetadata ?? {},
    });
    stripe.objects.set('pm_csv_pad', {
      id: 'pm_csv_pad', object: 'payment_method', created: stripe.now, type: 'acss_debit',
      customer: stripeCustomerId, metadata: {},
      billing_details: { name: 'Payer', email: 'payer@example.invalid', phone: '+12025550123', address: '1 Test Street' },
      acss_debit: { bank_name: 'STRIPE TEST BANK', last4: '6789' },
    });
    const provider = new StripePayments(gym, { transport: stripe, webhookSecret: 'whsec_SYNTHETIC' });
    const detachErrors: unknown[] = [];
    const detachCard = vi.fn(async (_gymId: string, id: string, detachOptions?: DetachOptions) => {
      assertNoTransaction('detachCard');
      try { await provider.detachPaymentMethod(id, detachOptions); }
      catch (error) { detachErrors.push(error); throw error; }
    });
    const adoptCustomer = vi.fn(async (_gymId: string, id: string) => {
      assertNoTransaction('adoptCustomer');
      return provider.adoptCustomer(id);
    });
    const settings = createGymSettingsAccessor({ scope: database.forGym });
    const removalJobs = new FakeJobs(testClock);
    const payments = createPaymentService({
      scope: database.forGym, clock: testClock, settings, jobs: removalJobs, detachCard, paymentsFor: async () => provider,
    });
    const membersService = createMembersService({ scope: database.forGym, clock: testClock });
    const handler = createPaymentJobs({ scope: database.forGym, notifications: {} as never, detachCard, adoptCustomer })
      .find(job => job.id === detachJob)!.handler;
    const runDetach = (payload: unknown, attempt = 1) => handler(payload, {
      jobId: 'job_detach', gymId: gym, timezone: 'UTC', attempt, clock: testClock,
    });
    const audits = (action?: string) => database.forGym(gym, tx => action
      ? tx.select().from(auditEvents).where(eq(auditEvents.action, action))
      : tx.select().from(auditEvents));
    return {
      gym, testClock, user, home, person, card, stripe, detachCard, detachErrors, adoptCustomer,
      removalJobs, payments, membersService, runDetach, audits,
    };
  }

  it('adopts the customer recorded in household.anonymized when a staff removal retries after a last-member erasure', async () => {
    const f = await preErasureFixture();
    const unavailable = Object.assign(new Error('unavailable'), { statusCode: 503 });
    // Both the staff removal's immediate detach and the job's first attempt fail with a 503.
    f.detachCard.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable);
    await expect(f.payments.revokeCard({ gymId: f.gym, actor: { kind: 'user', userId: f.user.id } }, f.home.id, f.card.id))
      .rejects.toBe(unavailable);
    const queued = f.removalJobs.jobs.filter(job => job.name === detachJob);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({ paymentMethodId: f.card.id });
    expect(queued[0]!.payload).not.toHaveProperty('customerId');
    await expect(f.runDetach(queued[0]!.payload, 1)).rejects.toBe(unavailable);
    expect(f.adoptCustomer).not.toHaveBeenCalled();

    // A last-member erasure clears households.stripeCustomerId and records it in household.anonymized.
    const erasureJobs = new FakeJobs(f.testClock);
    await f.membersService.eraseMember({ gymId: f.gym, actor: { kind: 'system' } }, f.person.id, { revision: 1 },
      { jobs: erasureJobs, timezone: 'UTC' });
    expect(erasureJobs.jobs.filter(job => job.name === detachJob)).toEqual([]);
    const [afterErase] = await database.forGym(f.gym, tx => tx.select().from(households).where(eq(households.id, f.home.id)));
    expect(afterErase!.stripeCustomerId).toBeNull();

    // The earlier staff-removal detach job retries with no customerId in its payload and adopts the audited customer.
    await expect(f.runDetach(queued[0]!.payload, 2)).resolves.toBeUndefined();
    expect(f.adoptCustomer).toHaveBeenCalledExactlyOnceWith(f.gym, 'cus_csv');
    expect(f.stripe.objects.get('cus_csv')!.metadata).toEqual({ gym_id: f.gym });
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBeNull();
    const adopted = await f.audits('billing.customer.adopted');
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({
      targetType: 'household', targetId: f.home.id,
      after: { customerId: 'cus_csv', paymentMethodId: f.card.id, source: 'detach' },
    });
    const detached = await f.audits(cardDetachedAction);
    expect(detached).toHaveLength(1);
    expect(detached[0]).toMatchObject({ targetType: 'payment_method', targetId: f.card.id });

    // A repeat run does not adopt or audit again.
    await expect(f.runDetach(queued[0]!.payload, 3)).resolves.toBeUndefined();
    expect(await f.audits('billing.customer.adopted')).toHaveLength(1);
    expect(await f.audits(cardDetachedAction)).toHaveLength(1);
  });

  it('refuses to adopt an audited customer tagged for another gym and throws the first refusal', async () => {
    const f = await preErasureFixture({ customerMetadata: { gym_id: uuidv7() } });
    const unavailable = Object.assign(new Error('unavailable'), { statusCode: 503 });
    f.detachCard.mockRejectedValueOnce(unavailable);
    await expect(f.payments.revokeCard({ gymId: f.gym, actor: { kind: 'user', userId: f.user.id } }, f.home.id, f.card.id))
      .rejects.toBe(unavailable);
    const [queued] = f.removalJobs.jobs.filter(job => job.name === detachJob);
    await f.membersService.eraseMember({ gymId: f.gym, actor: { kind: 'system' } }, f.person.id, { revision: 1 },
      { jobs: new FakeJobs(f.testClock), timezone: 'UTC' });

    const rejection = await f.runDetach(queued!.payload, 2).catch(error => error);
    expect(rejection).toBe(f.detachErrors[0]);
    expect(f.adoptCustomer).toHaveBeenCalledExactlyOnceWith(f.gym, 'cus_csv');
    expect(f.stripe.requests.filter(request => request.method === 'POST'
      && request.path === '/v1/customers/cus_csv')).toHaveLength(0);
    expect(await f.audits('billing.customer.adopted')).toHaveLength(0);
    expect(await f.audits(cardDetachedAction)).toHaveLength(0);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');
  });

  it('keeps the first refusal when the household has no stored link and no household.anonymized audit', async () => {
    const f = await preErasureFixture({ customerId: null, methodCustomerId: 'cus_csv', revoked: true });
    const rejection = await f.runDetach({ paymentMethodId: f.card.id }).catch(error => error);
    expect(rejection).toBe(f.detachErrors[0]);
    expect(f.adoptCustomer).not.toHaveBeenCalled();
    expect(await f.audits('billing.customer.adopted')).toHaveLength(0);
    expect(await f.audits(cardDetachedAction)).toHaveLength(0);
    expect(f.stripe.objects.get('pm_csv_pad')!.customer).toBe('cus_csv');
  });

  it('uses a stored household link over an older household.anonymized audit, and picks the latest audit when the link is null', async () => {
    // Stored link wins over an earlier household.anonymized audit.
    const linked = await preErasureFixture({ customerId: 'cus_linked', revoked: true });
    linked.stripe.objects.set('cus_old', { id: 'cus_old', object: 'customer', email: null, metadata: {} });
    await database.forGym(linked.gym, tx => writeAudit(tx, {
      gymId: linked.gym, actorKind: 'system', action: 'household.anonymized', targetType: 'household', targetId: linked.home.id,
      before: { stripeCustomerId: 'cus_old' }, occurredAt: new Date('2026-11-20T12:00:00Z'),
    }));
    await expect(linked.runDetach({ paymentMethodId: linked.card.id })).resolves.toBeUndefined();
    expect(linked.adoptCustomer).toHaveBeenCalledExactlyOnceWith(linked.gym, 'cus_linked');
    expect(linked.stripe.objects.get('cus_old')!.metadata).toEqual({});

    // When the stored link is null, the latest household.anonymized audit wins.
    const latest = await preErasureFixture({ customerId: null, methodCustomerId: 'cus_newer', revoked: true });
    latest.stripe.objects.set('cus_older', { id: 'cus_older', object: 'customer', email: null, metadata: {} });
    // Separate transactions, so the two audits get different created_at times and the order is not left to their IDs.
    await database.forGym(latest.gym, tx => writeAudit(tx, {
      gymId: latest.gym, actorKind: 'system', action: 'household.anonymized', targetType: 'household', targetId: latest.home.id,
      before: { stripeCustomerId: 'cus_older' }, occurredAt: new Date('2026-11-20T12:00:00Z'),
    }));
    await database.forGym(latest.gym, tx => writeAudit(tx, {
      gymId: latest.gym, actorKind: 'system', action: 'household.anonymized', targetType: 'household', targetId: latest.home.id,
      before: { stripeCustomerId: 'cus_newer' }, occurredAt: new Date('2026-11-22T12:00:00Z'),
    }));
    const stamps = await database.forGym(latest.gym, tx => tx.select({ createdAt: auditEvents.createdAt }).from(auditEvents).where(and(
      eq(auditEvents.action, 'household.anonymized'), eq(auditEvents.targetId, latest.home.id))));
    expect(new Set(stamps.map(stamp => stamp.createdAt.getTime())).size).toBe(2);
    await expect(latest.runDetach({ paymentMethodId: latest.card.id })).resolves.toBeUndefined();
    expect(latest.adoptCustomer).toHaveBeenCalledExactlyOnceWith(latest.gym, 'cus_newer');
    expect(latest.stripe.objects.get('cus_older')!.metadata).toEqual({});
    expect(latest.stripe.objects.get('cus_newer')!.metadata).toEqual({ gym_id: latest.gym });
    expect(latest.stripe.objects.get('pm_csv_pad')!.customer).toBeNull();
  });
});
