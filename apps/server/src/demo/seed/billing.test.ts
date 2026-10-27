// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, emailOutbox, gyms, households, invoiceLineItems, invoices, memberships,
  members, paymentAttempts, paymentMethods, payments, plans, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { localDate } from '@plaingym/shared/time';
import { TestClock } from '../../core/clock.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createCustomersService } from '../../areas/billing/customers.js';
import { createChargeRunner } from '../../areas/billing/runner/index.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { createGymDeleteService } from '../../areas/settings/gym-delete.js';
import { createDemoService } from '../service.js';
import { FakePayments, type CreateCharge } from '../../infra/payments/index.js';
import { billingSeed, demoPlans } from './billing.js';
import type { BillingSeedProvider } from './billing-payments.js';
import { demoHouseholds, membersSeed } from './members.js';
import { runSeeds } from './index.js';

const db = useTestDatabase(), factory = createFactories(db);
function provider(gymId: string, clock: TestClock) {
  const declinedMethods = new Set<string>(), createdCards = new Map<string, string>();
  class TestPayments extends FakePayments {
    override async createCharge(input: CreateCharge) {
      const result = await super.createCharge(input);
      this.respondNextConfirmation(declinedMethods.has(input.paymentMethodId) ? 'declined' : 'succeeded');
      return result;
    }
  }
  const payments = new TestPayments(gymId, clock);
  const createCustomer = vi.spyOn(payments, 'createCustomer');
  const seedCard = vi.fn(async (customerId: string, householdId: string, declined: boolean) => {
    let id = createdCards.get(householdId);
    if (!id) {
      id = 'pm_' + uuidv7().replaceAll('-', ''); createdCards.set(householdId, id);
      payments.recordPaymentMethod({ id, customerId, last4: declined ? '0341' : '4242', expiresMonth: 12, expiresYear: 2030 });
      if (declined) declinedMethods.add(id);
    }
    return id;
  });
  return { gymId, mode: 'test' as const, payments, createCustomer, seedCard };
}
async function fixture(now = '2026-10-26T00:30:00Z') {
  const gymId = uuidv7(), timezone = 'America/Vancouver', clock = new TestClock(now);
  await factory('gyms', gymId, { timezone, currency: 'CAD' });
  const context = { gymId, timezone, enabledModules: new Set<string>() }, scope = db.forGym;
  const gateway = provider(gymId, clock), paymentsFor = async () => gateway;
  const seed = billingSeed({ scope, clock, paymentsFor });
  await membersSeed({ scope, clock, pinSecret: null }).run(context);
  return { gymId, clock, context, gateway, seed };
}
async function snapshot(gymId: string) {
  // Query plans can change after another gym is seeded; compare rows in a stable order.
  return db.forGym(gymId, async tx => ({
    plans: await tx.select().from(plans).orderBy(plans.id), households: await tx.select().from(households).orderBy(households.id),
    memberships: await tx.select().from(memberships).orderBy(memberships.id), invoices: await tx.select().from(invoices).orderBy(invoices.id),
    lines: await tx.select().from(invoiceLineItems).orderBy(invoiceLineItems.id), cards: await tx.select().from(paymentMethods).orderBy(paymentMethods.id),
    attempts: await tx.select().from(paymentAttempts).orderBy(paymentAttempts.id), payments: await tx.select().from(payments).orderBy(payments.id),
    audit: await tx.select().from(auditEvents).orderBy(auditEvents.id), emails: await tx.select().from(emailOutbox).orderBy(emailOutbox.id),
    gym: (await tx.select().from(gyms).where(eq(gyms.id, gymId)))[0]!,
  }));
}

describe('demo billing seed', { timeout: 60_000 }, () => {
  it('creates plans, family invoices, paid history and two past-due households using real billing services', async () => {
    const f = await fixture(); await f.seed.run(f.context);
    const rows = await snapshot(f.gymId), today = localDate(f.clock.now(), f.context.timezone);
    expect(today).toBe('2026-10-25');
    expect(rows.plans.map(row => row.name).sort()).toEqual(demoPlans.map(row => row.name).sort());
    expect(rows.memberships).toHaveLength(demoHouseholds.flatMap(home => home.members).length);
    expect(new Set(rows.memberships.map(row => row.status))).toEqual(new Set(['active', 'trial', 'pending', 'frozen', 'cancelled']));
    expect(rows.memberships.filter(row => row.status === 'active').every(row => row.nextDueOn > today)).toBe(true);
    expect(rows.memberships.find(row => row.interval === 'annual')?.anniversaryOn).toBe('2026-08-23');
    expect(rows.households).toHaveLength(14); expect(rows.cards).toHaveLength(14);
    expect(rows.households.every(row => row.stripeCustomerId)).toBe(true);
    expect(rows.cards.every(row => row.isDefault && !row.revokedAt && row.processorCreatedAt)).toBe(true);
    expect(rows.cards.filter(row => row.last4 === '0341')).toHaveLength(2);
    const overdue = rows.invoices.filter(row => row.status === 'past_due');
    expect(overdue).toHaveLength(2);
    expect(overdue.map(row => rows.households.find(home => home.id === row.householdId)!.email).sort())
      .toEqual(['murphy@example.invalid', 'oneill@example.invalid']);
    expect(rows.invoices.filter(row => row.status === 'paid').length).toBeGreaterThan(15);
    expect(rows.payments.some(row => row.method === 'card')).toBe(true);
    expect(rows.payments.some(row => row.method === 'cash')).toBe(true);
    expect(rows.invoices.every(row => row.number && row.currency === 'CAD' && !row.needsReview)).toBe(true);
    expect(new Set(rows.invoices.map(row => row.number)).size).toBe(rows.invoices.length);
    const rivera = rows.households.find(row => row.email === 'rivera@example.invalid')!;
    const family = rows.invoices.filter(row => row.householdId === rivera.id);
    expect(family).toHaveLength(3);
    for (const invoice of family) {
      expect(invoice.amountCents).toBe(48000);
      expect(rows.lines.filter(row => row.invoiceId === invoice.id)).toHaveLength(4);
    }
    const retryDays = rows.audit.filter(row => row.action === 'billing.transition.effect.created')
      .map(row => row.after as { kind: string; retryDay?: number }).filter(work => work.kind === 'retry').map(work => work.retryDay).sort();
    expect(retryDays).toEqual([3, 3, 7, 7]);
    expect(f.gateway.createCustomer).toHaveBeenCalledTimes(14);
    for (const call of f.gateway.createCustomer.mock.calls) expect(call[0]).toMatchObject({
      householdId: expect.any(String), email: expect.stringMatching(/@example[.]invalid$/),
      idempotencyKey: expect.stringMatching(/^household:.*:customer$/),
    });
    expect(rows.emails).toHaveLength(0);
    expect(rows.gym.billingEnabled).toBe(false); expect(rows.gym.memberEmailsEnabled).toBe(false);
    expect(rows.audit.some(row => row.action === 'settings.go_live.updated')).toBe(true);
    expect(rows.audit.every(row => row.actorKind === 'system' && row.gymId === f.gymId)).toBe(true);
  });

  it('is unchanged on rerun even a month later and never changes another gym', async () => {
    const other = await fixture(), f = await fixture();
    await other.seed.run(other.context); const otherBefore = await snapshot(other.gymId);
    await f.seed.run(f.context); const before = await snapshot(f.gymId);
    f.clock.advance(32 * 86_400_000); await f.seed.run(f.context);
    expect(await snapshot(f.gymId)).toEqual(before); expect(await snapshot(other.gymId)).toEqual(otherBefore);
    expect(f.gateway.createCustomer).toHaveBeenCalledTimes(14); expect(f.gateway.seedCard).toHaveBeenCalledTimes(14);
    const customer = createCustomersService({ scope: db.forGym, clock: f.clock, paymentsFor: async () => f.gateway.payments });
    await expect(customer.ensureCustomer(f.gymId, otherBefore.households[0]!.id)).rejects.toMatchObject({ code: 'not_found' });
    f.gateway.payments.seedCustomer({ id: 'cus_foreign', email: 'foreign@example.invalid', gymId: other.gymId });
    await expect(f.gateway.payments.adoptCustomer('cus_foreign')).rejects.toThrow(/another gym/);
  });

  it('retries a lost customer response without a duplicate and restores the billing switch on failure', async () => {
    const f = await fixture(); f.gateway.payments.loseNextResponse('createCustomer');
    await expect(f.seed.run(f.context)).rejects.toThrow(/lost/);
    expect((await snapshot(f.gymId)).gym.billingEnabled).toBe(false);
    await f.seed.run(f.context);
    expect((await f.gateway.payments.findCustomerByEmail('rivera@example.invalid'))).toHaveLength(1);
    expect((await snapshot(f.gymId)).cards).toHaveLength(14);
  });

  it('resumes after a saved card response is lost, preserving the seed calendar across midnight', async () => {
    const f = await fixture();
    const seedCard = f.gateway.seedCard.getMockImplementation()!;
    f.gateway.seedCard.mockImplementationOnce(async (...args) => { await seedCard(...args); throw new Error('Card response lost'); });
    await expect(f.seed.run(f.context)).rejects.toThrow(/Card response lost/);
    f.clock.advance(9 * 60 * 60 * 1000); await f.seed.run(f.context);
    const rows = await snapshot(f.gymId);
    expect(rows.cards).toHaveLength(14);
    expect(rows.invoices.filter(row => row.status === 'past_due').map(row => row.dueOn)).toEqual(['2026-10-23', '2026-10-23']);
  });

  it('leaves an unknown charge for reconciliation and never collects it twice on a seed retry', async () => {
    const f = await fixture(), createCharge = vi.spyOn(f.gateway.payments, 'createCharge');
    f.gateway.payments.loseNextResponse('confirmCharge');
    await expect(f.seed.run(f.context)).rejects.toThrow(/lost/);
    await expect(f.seed.run(f.context)).rejects.toThrow(/reconciliation/);
    expect(createCharge).toHaveBeenCalledTimes(1);
    expect((await snapshot(f.gymId)).attempts.filter(row => row.status === 'pending')).toHaveLength(1);
    const scope = db.forGym, clock = f.clock, settings = createGymSettingsAccessor({ scope, clock });
    const runner = createChargeRunner({ scope, clock, settings, transitions: createInvoiceTransitions({ scope, clock }),
      payments: async () => f.gateway.payments, jobs: { async enqueue() { throw new Error('Unexpected job'); } } });
    expect(await runner.reconcile(f.gymId)).toMatchObject({ inspected: 1, issues: [] });
    await f.seed.run(f.context);
    const rows = await snapshot(f.gymId);
    expect(rows.attempts.every(row => row.status !== 'pending')).toBe(true);
    expect(rows.attempts.every(row => row.attemptNumber === 1)).toBe(true);
    expect(rows.gym.billingEnabled).toBe(false);
  });

  it('confirms memberships already past due when it switches billing on, then restores the switch', async () => {
    const f = await fixture();
    // An interrupted run can leave an assigned membership whose first period was never generated.
    const [member] = await db.forGym(f.gymId, tx => tx.select().from(members).orderBy(members.id).limit(1));
    const plan = await factory('plans', f.gymId, { name: 'Interrupted plan', currency: 'CAD' });
    const overdue = await factory('memberships', f.gymId, { householdId: member!.householdId, memberId: member!.id, planId: plan.id,
      status: 'active', currency: 'CAD', nextDueOn: '2026-10-01' });
    await f.seed.run(f.context);
    const rows = await snapshot(f.gymId);
    const confirmed = rows.audit.filter(row => row.action === 'settings.go_live.past_due_dates_confirmed');
    expect(confirmed).toHaveLength(1);
    expect((confirmed[0]!.after as { memberships: { id: string }[] }).memberships.map(row => row.id)).toEqual([overdue.id]);
    expect(rows.gym.billingEnabled).toBe(false);
  });
  it('restores a disabled billing switch recorded before an interrupted seed process', async () => {
    const f = await fixture();
    await factory('auditEvents', f.gymId, { action: 'billing.seed.started', targetType: 'gym', targetId: f.gymId,
      occurredAt: f.clock.now(), after: { billingEnabled: false } });
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ billingEnabled: true }).where(eq(gyms.id, f.gymId)));
    await f.seed.run(f.context);
    expect((await snapshot(f.gymId)).gym.billingEnabled).toBe(false);
  });

  it('refuses an uncertain card creation after the provider idempotency window', async () => {
    const f = await fixture(); f.gateway.seedCard.mockRejectedValueOnce(new Error('Unknown provider outcome'));
    await expect(f.seed.run(f.context)).rejects.toThrow(/Unknown provider/);
    f.clock.advance(24 * 60 * 60 * 1000);
    await expect(f.seed.run(f.context)).rejects.toThrow(/idempotency window/);
    expect(f.gateway.seedCard).toHaveBeenCalledTimes(1);
    expect((await snapshot(f.gymId)).gym.billingEnabled).toBe(false);
  });

  it('rejects a live provider or a provider for another gym before changing any billing data', async () => {
    const f = await fixture(), before = await snapshot(f.gymId);
    for (const gateway of [{ ...f.gateway, mode: 'live' }, { ...f.gateway, gymId: uuidv7() }]) {
      const seed = billingSeed({ scope: db.forGym, clock: f.clock, paymentsFor: async () => gateway as BillingSeedProvider });
      await expect(seed.run(f.context)).rejects.toThrow(/test mode/);
      expect(await snapshot(f.gymId)).toEqual(before);
    }
  });

  it('runs through sandbox creation with dependency injection and preserves a previously enabled billing switch', async () => {
    const clock = new TestClock('2026-10-26T16:00:00Z'), scope = db.forGym, system = db.forSystem;
    const gateways = new Map<string, ReturnType<typeof provider>>();
    const paymentsFor = async (gymId: string) => {
      const gateway = gateways.get(gymId) ?? provider(gymId, clock); gateways.set(gymId, gateway); return gateway;
    };
    const demo = createDemoService({ config: { enabled: true, domain: 'demo.example.test', maxSandboxes: 50 },
      key: parseEncryptionKey('cd'.repeat(32)), clock, scope, system,
      identities: { async seed() {}, async login() { return new Response(); } },
      deletion: createGymDeleteService({ clock, scope, system, removeUploads: async () => {} }),
      seed: context => runSeeds(context, [membersSeed({ scope, clock, pinSecret: null }), billingSeed({ scope, clock, paymentsFor })]),
    });
    const sandbox = await demo.create(), rows = await snapshot(sandbox.gymId);
    expect(rows.invoices.some(row => row.status === 'paid')).toBe(true);
    expect(rows.invoices.some(row => row.status === 'past_due')).toBe(true);
    expect(rows.gym.settings).toMatchObject({ demo: { ready: true } });
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ billingEnabled: true }).where(eq(gyms.id, f.gymId)));
    await f.seed.run(f.context); expect((await snapshot(f.gymId)).gym.billingEnabled).toBe(true);
    expect((await snapshot(f.gymId)).audit.filter(row => row.action === 'settings.go_live.updated')).toHaveLength(0);
  });
});
