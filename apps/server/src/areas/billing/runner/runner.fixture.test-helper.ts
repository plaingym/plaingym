// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
import { allocateInvoiceNumber, auditEvents, invoiceLineItems, invoices, memberships, paymentAttempts, payments, refunds, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { FakeGymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createMembershipService } from '../memberships.js';
import { createInvoiceTransitions } from '../transitions/index.js';
import { createChargeRunner } from './index.js';

export interface FixtureOptions {
  now?: string; dueOn?: string; interval?: string; anniversaryOn?: string | null;
  startsOn?: string; status?: string; enabled?: boolean; amount?: number; timezone?: string;
}

/**
 * Call once at module scope in a runner test file. Gives the file its database and a fixture per gym: one household
 * with a saved card and a membership due on 1 March 2028, the real transitions and a charge runner over `FakePayments`.
 */
export function useRunnerFixture() {
  const db = useTestDatabase(), factory = createFactories(db);
  async function fixture(options: FixtureOptions = {}) {
    const gymId = uuidv7();
    await factory('gyms', gymId, { currency: 'CAD', timezone: options.timezone ?? 'America/Vancouver', billingEnabled: options.enabled ?? true });
    const clock = new TestClock(options.now ?? '2028-03-01T17:00:00Z');
    const home = await factory('households', gymId, { billingDay: 1, stripeCustomerId: 'cus_test' });
    const member = await factory('members', gymId, { householdId: home.id });
    const plan = await factory('plans', gymId, { interval: options.interval ?? 'monthly', amountCents: options.amount ?? 10000 });
    const membership = await factory('memberships', gymId, { householdId: home.id, memberId: member.id, planId: plan.id,
      status: options.status ?? 'active', interval: options.interval ?? 'monthly', amountCents: options.amount ?? 10000,
      startsOn: options.startsOn ?? '2028-01-01', nextDueOn: options.dueOn ?? '2028-03-01', anniversaryOn: options.anniversaryOn ?? null });
    await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_test', isDefault: true });
    const settings = new FakeGymSettingsAccessor([await createGymSettingsAccessor({ scope: db.forGym }).get(gymId)]);
    const provider = new FakePayments(gymId, clock);
    provider.seedCustomer({ id: 'cus_test', email: 'payer@example.invalid' });
    const serviceOptions = { scope: db.forGym, clock, settings, jobs: new FakeJobs(clock) };
    const transitions = createInvoiceTransitions(serviceOptions);
    const runner = createChargeRunner({ ...serviceOptions, transitions, async payments() { return provider; } });
    const context = { jobId: uuidv7(), gymId, timezone: options.timezone ?? 'America/Vancouver', attempt: 1, clock };
    const read = () => db.forGym(gymId, async tx => ({
      invoices: await tx.select().from(invoices).orderBy(asc(invoices.dueOn)),
      attempts: await tx.select().from(paymentAttempts).orderBy(asc(paymentAttempts.attemptNumber)),
      payments: await tx.select().from(payments), refunds: await tx.select().from(refunds),
      memberships: await tx.select().from(memberships), lines: await tx.select().from(invoiceLineItems), audits: await tx.select().from(auditEvents),
    }));
    const enable = async (billingEnabled: boolean) => settings.set({ ...await settings.get(gymId), billingEnabled });
    return { gymId, clock, home, member, plan, membership, settings, provider, serviceOptions, transitions, runner, context, read, enable };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function invoice(f: Fixture) {
    const number = await db.forGym(f.gymId, tx => allocateInvoiceNumber(tx, f.gymId));
    return factory('invoices', f.gymId, { householdId: f.home.id, kind: 'cycle', status: 'open', number,
      dueOn: '2028-03-01', periodStartsOn: '2028-03-01', periodEndsOn: '2028-04-01' });
  }
  /** More households, each with a saved card and a membership due on the fixture's date: one more invoice for the daily run. */
  async function addHouseholds(f: Fixture, count: number) {
    for (let n = 0; n < count; n++) {
      f.provider.seedCustomer({ id: `cus_more_${n}`, email: `payer${n}@example.invalid` });
      const home = await factory('households', f.gymId, { billingDay: 1, stripeCustomerId: `cus_more_${n}` });
      const member = await factory('members', f.gymId, { householdId: home.id });
      await factory('memberships', f.gymId, { householdId: home.id, memberId: member.id, planId: f.plan.id, status: 'active',
        startsOn: '2028-01-01', nextDueOn: '2028-03-01' });
      await factory('paymentMethods', f.gymId, { householdId: home.id, processorId: `pm_more_${n}`, isDefault: true });
    }
  }
  async function checkout(f: Fixture, invoiceId: string) {
    const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_test', amount: 10000, currency: 'cad',
      invoiceId, successUrl: 'https://gym.example.invalid/success', cancelUrl: 'https://gym.example.invalid/cancel',
      saveForOffSession: true, idempotencyKey: invoiceId + ':checkout' });
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ checkoutSessionId: session.id }).where(eq(invoices.id, invoiceId)));
    return session;
  }
  /** A one-off invoice with one line of `kind`; the fixture's membership is cancelled so no cycle competes with it. */
  async function oneOff(f: Fixture, kind: 'charge' | 'membership' = 'charge') {
    const bill = await invoice(f);
    await db.forGym(f.gymId, async tx => {
      await tx.update(invoices).set({ kind: 'one_off', periodStartsOn: null, periodEndsOn: null }).where(eq(invoices.id, bill.id));
      await tx.update(memberships).set({ status: 'cancelled' }).where(eq(memberships.id, f.membership.id));
    });
    await factory('invoiceLineItems', f.gymId, { householdId: f.home.id, invoiceId: bill.id, kind,
      ...(kind === 'membership' ? { membershipId: f.membership.id } : {}) });
    return bill;
  }
  /** Assigns a new plan starting 1 March, which issues its prorated first period and sign-up fee. */
  async function assign(f: Fixture, amount = 10000, fee = 2500) {
    const plan = await factory('plans', f.gymId, { amountCents: amount, signupFeeCents: fee });
    const member = await factory('members', f.gymId, { householdId: f.home.id });
    const lifecycle = createMembershipService({ ...f.serviceOptions, onAssigned: f.runner.onAssigned });
    const membership = await lifecycle.assign({ gymId: f.gymId, actor: { kind: 'system' } }, { id: uuidv7(),
      householdId: f.home.id, memberId: member.id, planId: plan.id, startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' });
    return { membership, lifecycle };
  }
  return { db, factory, fixture, invoice, addHouseholds, checkout, oneOff, assign };
}
export type Fixture = Awaited<ReturnType<ReturnType<typeof useRunnerFixture>['fixture']>>;

export function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
/** What the Stripe adapter throws when the provider can't be reached in time. */
export const outage = () => Object.assign(new Error('Request to the provider timed out'), { type: 'StripeConnectionError' });
