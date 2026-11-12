// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, lt, notInArray } from 'drizzle-orm';
import { households, invoiceLineItems, invoices, memberships, planTaxRates, plans, taxRates, type Transaction } from '@plaingym/db';
import type * as c from '@plaingym/shared/contracts';
import { calculatePlanChange, type CalculatedInvoice, type PlanChangeResult } from './invoicing/index.js';
import { pricing } from './runner/store.js';
import { refuse, switchTerms } from './memberships.plan-change.js';

type Row = typeof memberships.$inferSelect;
type Plan = typeof plans.$inferSelect;

/** A plan's tax rates as the invoice engine applies them. */
export function planTaxes(tx: Transaction, planId: string) {
  return tx.select({ id: taxRates.id, name: taxRates.name, rateMillionths: taxRates.rateMillionths, inclusive: taxRates.inclusive })
    .from(planTaxRates).innerJoin(taxRates, eq(taxRates.id, planTaxRates.taxRateId)).where(eq(planTaxRates.planId, planId))
    .orderBy(asc(taxRates.id));
}
/**
 * A switch made now is for an active membership whose last cycle has run, and keeps its billing interval (a new
 * interval starts on a due date). A pending or trial membership has no paid period, and a frozen one's is skipped.
 */
export function checkNow(row: Row, plan: Plan, today: string) {
  if (row.status !== 'active') refuse('not_active', 'Only an active membership can switch plans now');
  if (plan.interval !== row.interval) refuse('interval_change', 'A new billing interval starts on the next billing date');
  if (row.nextDueOn < today) refuse('period_not_billed', 'The membership\'s current period hasn\'t been billed yet');
}
const notBilled = () => refuse('period_not_billed', 'The current period wasn\'t billed at the membership\'s price');
/**
 * The upgrade's proration for the days left in the current period, or null when none are left (the switch falls on the
 * due date). The current period must have been billed to the membership: a membership line for it on an invoice due
 * within the period that isn't void (its cycle, its first period or an earlier switch). Otherwise (a freeze resumed
 * early, a trial activated early, a first period left to the next billing date, an imported membership) the days left
 * cost nothing at the current price, and the switch is refused rather than charging a difference against them.
 */
export async function prorateNow(tx: Transaction, row: Row, membership: c.Membership, plan: Plan, today: string): Promise<PlanChangeResult | null> {
  if (row.nextDueOn <= today) return null;
  const home = (await tx.select().from(households).where(eq(households.id, row.householdId)))[0]!;
  const newPlan = { id: plan.id, amountCents: plan.amountCents, currency: plan.currency, interval: plan.interval as c.BillingInterval,
    description: plan.name, taxRates: await planTaxes(tx, plan.id) };
  const quote = () => {
    try {
      return calculatePlanChange({ ...pricing(home, row.currency), membership, newPlan, changeOn: today,
        ...(row.anniversaryOn === null ? {} : { annualAnchorOn: row.anniversaryOn }) });
    } catch (error) {
      // The engine refuses a change before the period it works out: after a freeze resumed early, that period is a later one.
      if (error instanceof RangeError) notBilled();
      throw error;
    }
  };
  const result = quote();
  const billed = await tx.select({ id: invoices.id }).from(invoiceLineItems)
    .innerJoin(invoices, and(eq(invoices.gymId, invoiceLineItems.gymId), eq(invoices.id, invoiceLineItems.invoiceId)))
    .where(and(eq(invoiceLineItems.membershipId, row.id), eq(invoiceLineItems.kind, 'membership'), notInArray(invoices.status, ['draft', 'void']),
      gte(invoices.dueOn, result.periodStartsOn), lt(invoices.dueOn, result.periodEndsOn))).limit(1);
  if (!billed.length) notBilled();
  return result;
}
/**
 * The proration invoice to issue, or null. The engine returns none for a proration rounded to zero, and a zero total
 * (a full household discount) is not issued either: no charge path settles a zero one-off invoice.
 */
export function issuable(result: PlanChangeResult | null): CalculatedInvoice | null {
  return result?.invoice && result.invoice.amountCents > 0 ? result.invoice : null;
}
/** What a switch would do, with the switch's refusals except the commitment, which it reports. */
export async function switchPreview(tx: Transaction, row: Row, membership: c.Membership, member: { anonymizedAt: Date | null },
  plan: Plan, timing: c.PlanSwitchTiming, today: string): Promise<c.MembershipSwitchPreview> {
  const { kind, commitmentBlocks } = switchTerms(row, member, plan, today);
  const upgradeNow = timing === 'now' && kind === 'upgrade';
  if (timing === 'now') checkNow(row, plan, today);
  const result = upgradeNow ? await prorateNow(tx, row, membership, plan, today) : null;
  return { planId: plan.id, timing, kind, currency: row.currency, commitmentBlocks, priceStartsOn: upgradeNow ? today : row.nextDueOn,
    proration: result && { periodStartsOn: result.periodStartsOn, periodEndsOn: result.periodEndsOn, billedDays: result.billedDays,
      periodDays: result.periodDays, totalCents: issuable(result)?.amountCents ?? 0 } };
}
