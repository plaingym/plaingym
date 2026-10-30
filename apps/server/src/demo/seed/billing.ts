// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { auditEvents, forGym, households, invoices, paymentMethods, uuidv7, type Transaction } from '@plaingym/db';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { clock as defaultClock, type Clock } from '../../core/clock.js';
import { createCatalogService } from '../../areas/billing/catalog.js';
import { createCustomersService } from '../../areas/billing/customers.js';
import { createMembershipService } from '../../areas/billing/memberships.js';
import { previousBillingDate } from '../../areas/billing/invoicing/index.js';
import { createChargeRunner } from '../../areas/billing/runner/index.js';
import { audit, generateCycle, system } from '../../areas/billing/runner/store.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { createCardHandlers } from '../../areas/billing/webhooks/handlers/methods.js';
import { createMembersService } from '../../areas/members/members.js';
import { createGoLiveService } from '../../areas/settings/go-live.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import type { SeedStep } from './index.js';
import { demoHouseholds, householdEmail, inBatches, memberKey, settableClock } from './members.js';
import type { Household } from '@plaingym/shared/contracts';
import type { BillingSeedProvider } from './billing-payments.js';
import type { GymSettings } from '../../core/interfaces/gym-settings.js';

const page = { limit: 100, offset: 0 } as const;
export const demoPlans = [
  { name: 'Demo adult monthly', amountCents: 15000, interval: 'monthly' },
  { name: 'Demo youth monthly', amountCents: 9000, interval: 'monthly' },
  { name: 'Demo annual', amountCents: 150000, interval: 'annual' },
] as const;
export const pastDueHouseholds = ['oneill', 'murphy'] as const;
const completed = 'billing.seed.household_completed', started = 'billing.seed.started', cardReserved = 'billing.seed.card_reserved';
const recorded = (tx: Transaction, action: string, targetId: string) => tx.select().from(auditEvents)
  .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId))).limit(1);

/** Inject the shared test account, never the ordinary (possibly live) payments resolver. */
export function billingSeed(options: {
  scope?: typeof forGym; clock?: Clock; paymentsFor(gymId: string): Promise<BillingSeedProvider>;
}): SeedStep {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return { id: 'billing', async run(context) {
    const { gymId } = context, actor = system(gymId);
    const provider = await options.paymentsFor(gymId);
    if (provider.mode !== 'test' || provider.gymId !== gymId) throw new Error('Billing seed requires this gym and test mode');
    if ((await scope(gymId, tx => recorded(tx, 'billing.seed.completed', gymId))).length) return;
    const settings = createGymSettingsAccessor({ scope, clock });
    const gym = await settings.get(gymId);
    const seedState = await scope(gymId, async tx => {
      const [existing] = await recorded(tx, started, gymId);
      if (existing) return { anchor: existing.occurredAt, billingEnabled: (existing.after as { billingEnabled: boolean }).billingEnabled };
      await audit(tx, actor, clock, started, 'gym', gymId, { billingEnabled: gym.billingEnabled });
      return { anchor: clock.now(), billingEnabled: gym.billingEnabled };
    });
    const { anchor } = seedState;
    const calendar = seedCalendar(anchor, gym.timezone), { today, billingDay, startsOn } = calendar;
    const at = settableClock(anchor), catalog = createCatalogService({ scope, clock: at, settings });
    const plans = new Map((await catalog.listPlans(gymId, page)).data.map(row => [row.name, row]));
    for (const plan of demoPlans) if (!plans.has(plan.name))
      plans.set(plan.name, await catalog.createPlan(actor, { ...plan, currency: gym.currency }));
    const people = createMembersService({ scope, clock: at });
    const lifecycle = createMembershipService({ scope, clock: at, settings });
    const customers = createCustomersService({ scope, clock, paymentsFor: async () => provider.payments });
    const transitions = createInvoiceTransitions({ scope, clock: at });
    const cards = createCardHandlers({ scope, clock: at });
    const runner = createChargeRunner({ scope, clock: at, settings, transitions, payments: async () => provider.payments,
      // No seed job is enqueued: transitions persist their normal effects for the runtime publisher.
      jobs: { async enqueue() { throw new Error('Billing seed must not enqueue jobs directly'); } } });
    const switches = createGoLiveService({ scope, clock, smtpConfigured: async () => false });
    const initial = await switches.checklist(gymId);
    // Use the existing switch API; restore the original switch even if a provider call fails.
    // A rerun after a partial failure can find seeded memberships still due in the past; confirm exactly those.
    if (!initial.billingEnabled) await switches.update(actor, { revision: initial.revision, billingEnabled: true,
      confirmedPastDueDates: initial.pastDueMemberships.map(({ id, revision, nextDueOn }) => ({ id, revision, nextDueOn })) });
    try {
      const prepared = new Map<string, Household>();
      // Overlap independent customer/card requests, bounded to three households.
      // Drain all in-flight work before restoring billing or letting provisioning roll back.
      // Invoice history and collection still run in order on the seed's calendar.
      await inBatches(demoHouseholds, async home => {
        const household = (await people.listHouseholds(gymId, { ...page, search: home.name })).data
          .find(row => row.name === home.name && row.email === householdEmail(home));
        if (!household) throw new Error('Run the members seed before the billing seed');
        if ((await scope(gymId, tx => recorded(tx, completed, household.id))).length) return;
        const customerId = await customers.ensureCustomer(gymId, household.id);
        await seedTestCard({ scope, clock, cards, provider }, gymId, household.id, customerId, pastDueHouseholds.some(slug => slug === home.slug));
        prepared.set(home.slug, household);
      }, 3);
      for (const home of demoHouseholds) {
        const household = prepared.get(home.slug);
        if (!household) continue;
        const billing = await people.getHouseholdBilling(gymId, household.id);
        if (billing.billingDay !== billingDay) await people.updateHouseholdBilling(actor, household.id,
          { familyDiscountBasisPoints: billing.familyDiscountBasisPoints, billingDay, revision: billing.revision });
        const existing = (await lifecycle.list(gymId, { ...page, householdId: household.id })).data;
        const members = (await people.listMembers(gymId, { ...page, householdId: household.id })).data;
        for (const person of home.members) {
          const member = members.find(row => memberKey(row) === memberKey(person));
          if (!member) throw new Error('Demo member is missing');
          let membership = existing.find(row => row.memberId === member.id);
          if (!membership) {
            const plan = plans.get(home.slug === 'petrova' ? demoPlans[2].name : person.age < 18 ? demoPlans[1].name : demoPlans[0].name)!;
            const trial = person.status === 'trial', pending = person.status === 'prospect';
            at.set(zonedInstant(trial || pending ? today : startsOn, '12:00', gym.timezone, { gap: 'shift' })!);
            membership = await lifecycle.assign(actor, { id: uuidv7(), householdId: household.id, memberId: member.id, planId: plan.id,
              startsOn: trial || pending ? today : startsOn, nextDueOn: trial || pending ? addDays(today, 7) : startsOn,
              initialStatus: trial ? 'trial' : pending ? 'pending' : 'active',
              ...(trial ? { trialEndsOn: addDays(today, 7) } : {}), firstPeriod: 'next_billing_date' });
          }
          if (person.status === 'frozen' && membership.status === 'active') await lifecycle.freeze(actor, { membershipId: membership.id, revision: membership.revision });
          if (person.status === 'cancelled' && membership.status !== 'cancelled') await lifecycle.cancel(actor, { membershipId: membership.id, revision: membership.revision });
        }
        await settleSeedPeriods({ scope, at, transitions, runner }, gym, household.id, calendar);
        at.set(anchor);
        await scope(gymId, tx => audit(tx, actor, clock, completed, 'household', household.id, {}));
      }
    } finally {
      if (!seedState.billingEnabled) {
        const current = await switches.checklist(gymId);
        await switches.update(actor, { revision: current.revision, billingEnabled: false });
      }
    }
    await scope(gymId, tx => audit(tx, actor, clock, 'billing.seed.completed', 'gym', gymId, {}));
  } };
}

/** The seed's three monthly periods: two before the current one, which fell due two days before the anchor. */
export function seedCalendar(anchor: Date, timezone: string) {
  const today = localDate(anchor, timezone), dueOn = addDays(today, -2), billingDay = Number(dueOn.slice(8));
  const previous = previousBillingDate({ dueOn, interval: 'monthly', billingDay });
  return { today, dueOn, billingDay, previous, startsOn: previousBillingDate({ dueOn: previous, interval: 'monthly', billingDay }) };
}
/** Saves a named test card once. Reserve before calling out, so a lost card response is never retried after Stripe forgets its key. */
export async function seedTestCard(options: { scope: typeof forGym; clock: Clock; cards: ReturnType<typeof createCardHandlers>; provider: BillingSeedProvider },
  gymId: string, householdId: string, customerId: string, declines: boolean) {
  const { scope, clock, provider } = options;
  if ((await scope(gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.householdId, householdId)))).length) return;
  await scope(gymId, async tx => {
    await tx.select({ id: households.id }).from(households).where(eq(households.id, householdId)).for('update');
    const [reservation] = await recorded(tx, cardReserved, householdId);
    if (reservation && clock.now().getTime() >= reservation.occurredAt.getTime() + 23 * 60 * 60 * 1000)
      throw new Error('Demo card creation needs reconciliation; its idempotency window elapsed');
    if (!reservation) await audit(tx, system(gymId), clock, cardReserved, 'household', householdId, {});
  });
  const methodId = await provider.seedCard(customerId, householdId, declines);
  await options.cards.collect(gymId, provider.payments, customerId, methodId);
}
/**
 * Generates one household's periods through the real runner's calendar and invoice engine, pays the older ones in
 * cash and charges the current one. A charge must end succeeded or failed; anything else waits for reconciliation.
 */
export async function settleSeedPeriods(options: { scope: typeof forGym; at: ReturnType<typeof settableClock>;
  transitions: ReturnType<typeof createInvoiceTransitions>; runner: ReturnType<typeof createChargeRunner> },
gym: GymSettings, householdId: string, calendar: ReturnType<typeof seedCalendar>) {
  const { scope, at } = options, gymId = gym.gymId, noon = (date: string) => zonedInstant(date, '12:00', gym.timezone, { gap: 'shift' })!;
  for (const date of [calendar.startsOn, calendar.previous, calendar.dueOn]) {
    at.set(noon(date));
    while (await scope(gymId, tx => generateCycle(tx, gym, at, householdId, date))) { /* One committed household/period. */ }
  }
  const history = await scope(gymId, tx => tx.select().from(invoices).where(and(eq(invoices.householdId, householdId),
    eq(invoices.kind, 'cycle'))).orderBy(asc(invoices.dueOn)));
  for (const invoice of history) {
    if (invoice.status !== 'open') continue;
    at.set(noon(invoice.dueOn));
    if (invoice.dueOn < calendar.dueOn) await options.transitions.manualPayment(system(gymId), { invoiceId: invoice.id, paymentId: uuidv7(),
      method: 'cash', amountCents: invoice.amountCents, currency: gym.currency, paidAt: at.now().toISOString() });
    else {
      const result = await options.runner.charge(gymId, invoice.id);
      if (!['succeeded', 'failed'].includes(result.status)) throw new Error('Demo charge needs reconciliation before the seed can finish');
    }
  }
}
