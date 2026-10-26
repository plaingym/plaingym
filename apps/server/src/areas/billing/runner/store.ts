// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { allocateInvoiceNumber, households, invoiceLineItems, invoices, memberships, plans, planTaxRates,
  taxRates, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { membershipSchema } from '@plaingym/shared/contracts';
import { addDays } from '@plaingym/shared/time';
import type { MutationContext } from '../../../core/interfaces/common.js';
import type { GymSettings } from '../../../core/interfaces/gym-settings.js';
import type { MembershipOptions } from '../memberships.js';
import { calculateCycleInvoice, calculateFirstPeriod, calculateOneOffInvoice, type CalculatedInvoice,
  type PricedMembership } from '../invoicing/index.js';

const t = createTranslator(locales.en ?? {});
export const system = (gymId: string): MutationContext => ({ gymId, actor: { kind: 'system' } });
export async function audit(tx: Transaction, context: MutationContext, clock: Clock, action: string,
  targetType: string, targetId: string, after: unknown, before?: unknown) {
  await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action, targetType, targetId, after, ...(before === undefined ? {} : { before }), occurredAt: clock.now(), createdAt: clock.now() });
}
export async function issue(tx: Transaction, context: MutationContext, clock: Clock, calculated: CalculatedInvoice,
  needsReview = false) {
  const { lineItems, ...fields } = calculated;
  const id = uuidv7();
  await tx.insert(invoices).values({ ...fields, id, gymId: context.gymId, status: 'open',
    number: await allocateInvoiceNumber(tx, context.gymId), needsReview,
    createdAt: clock.now() });
  if (lineItems.length) await tx.insert(invoiceLineItems).values(lineItems.map(line => ({ ...line,
    id: uuidv7(), gymId: context.gymId, householdId: fields.householdId, invoiceId: id, createdAt: clock.now() })));
  await audit(tx, context, clock, 'billing.invoice.issued', 'invoice', id,
    { ...fields, needsReview });
  return id;
}
function pricing(home: typeof households.$inferSelect, currency: GymSettings['currency']) {
  return { householdId: home.id, currency, billingDay: home.billingDay,
    familyDiscountBasisPoints: home.familyDiscountBasisPoints, discountDescription: t('billing/runner:familyDiscount') };
}
async function priced(tx: Transaction, row: typeof memberships.$inferSelect): Promise<PricedMembership> {
  const plan = (await tx.select().from(plans).where(eq(plans.id, row.planId)))[0]!;
  const taxes = await tx.select({ id: taxRates.id, name: taxRates.name, rateMillionths: taxRates.rateMillionths,
    inclusive: taxRates.inclusive }).from(planTaxRates).innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId))
    .where(eq(planTaxRates.planId, row.planId));
  const { gymId: _gymId, anniversaryOn, ...fields } = row;
  void _gymId;
  return { membership: membershipSchema.parse({ ...fields, createdAt: row.createdAt.toISOString(),
    frozenAt: row.frozenAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null }),
    description: plan.name, taxRates: taxes, ...(anniversaryOn === null ? {} : { annualAnchorOn: anniversaryOn }) };
}
/** One household/date per transaction; the household lock also serializes assignment. */
export async function generateCycle(tx: Transaction, gym: GymSettings, clock: Clock, householdId: string, today: string) {
  const home = (await tx.select().from(households).where(eq(households.id, householdId)).for('update'))[0];
  if (!home) return false;
  const rows = await tx.select().from(memberships).where(and(eq(memberships.householdId, householdId),
    inArray(memberships.status, ['active', 'frozen']), lte(memberships.nextDueOn, today)))
    .orderBy(asc(memberships.nextDueOn), asc(memberships.id)).for('update');
  // A scheduled resume is lifecycle-owned. Do not let it block other due memberships.
  const due = rows.filter(row => row.status !== 'frozen' || row.resumesOn === null || row.resumesOn > row.nextDueOn);
  const dueOn = due[0]?.nextDueOn;
  if (!dueOn) return false;
  const previous = (await tx.select().from(invoices).where(and(eq(invoices.householdId, householdId),
    eq(invoices.kind, 'cycle'), eq(invoices.dueOn, dueOn))))[0];
  const result = calculateCycleInvoice({ ...pricing(home, gym.currency), dueOn,
    memberships: await Promise.all(due.filter(row => row.nextDueOn === dueOn).map(row => priced(tx, row))) });
  if (!result.nextDueDates.length) return false;
  if (result.invoice) {
    const calculated = previous ? { ...result.invoice, kind: 'one_off' as const, periodStartsOn: null, periodEndsOn: null } : result.invoice;
    const invoiceId = await issue(tx, system(gym.gymId), clock, calculated, !!previous || dueOn < addDays(today, -7));
    if (previous) await audit(tx, system(gym.gymId), clock, 'billing.runner.cycle_conflict', 'invoice', invoiceId,
      { cycleInvoiceId: previous.id, dueOn, periodStartsOn: result.invoice.periodStartsOn, periodEndsOn: result.invoice.periodEndsOn });
  }
  for (const change of result.nextDueDates) {
    await tx.update(memberships).set({ nextDueOn: change.nextDueOn, revision: change.expectedRevision + 1 })
      .where(and(eq(memberships.id, change.membershipId), eq(memberships.revision, change.expectedRevision)));
    await audit(tx, system(gym.gymId), clock, 'billing.membership.period_advanced', 'membership', change.membershipId, change);
  }
  return true;
}
/** Inject into MembershipService.onAssigned; called inside its transaction, with no provider calls. */
export function assignmentInvoices(clock: Clock): NonNullable<MembershipOptions['onAssigned']> {
  return async (tx, context, membership, billing) => {
    const home = (await tx.select().from(households).where(eq(households.id, membership.householdId)))[0]!;
    const plan = (await tx.select().from(plans).where(eq(plans.id, membership.planId)))[0]!;
    const input = { ...pricing(home, membership.currency), membership, description: plan.name,
      taxRates: billing.taxes, firstPeriod: billing.firstPeriod,
      ...(billing.annualAnchorOn === undefined ? {} : { annualAnchorOn: billing.annualAnchorOn }) };
    const first = calculateFirstPeriod(input);
    if (first.invoice) await issue(tx, context, clock, first.invoice);
    if (billing.signupFeeCents > 0) await issue(tx, context, clock, calculateOneOffInvoice({
      householdId: home.id, currency: membership.currency, dueOn: membership.startsOn,
      charges: [{ kind: 'signup_fee', description: t('billing/runner:signupFee', { plan: plan.name }),
        membershipId: membership.id, amountCents: billing.signupFeeCents, currency: membership.currency, taxRates: billing.taxes }] }));
  };
}
