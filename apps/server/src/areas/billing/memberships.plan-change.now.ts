// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or } from 'drizzle-orm';
import { auditEvents, households, invoiceLineItems, invoices, membershipDiscounts, memberships, planTaxRates, plans, taxRates, type Transaction } from '@plaingym/db';
import type * as c from '@plaingym/shared/contracts';
import { calculatePlanChange, type CalculatedInvoice, type MembershipDiscount, type PlanChangeResult } from './invoicing/index.js';
import { pricing } from './runner/store.js';
import { refuse, switchTerms } from './memberships.plan-change.js';
import { priceDiscount, switchDiscount } from './discounts/apply.js';
import { validateDiscount } from './invoicing/pricing.js';

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
type PriceSnapshot = { amountCents?: unknown } | null;
type BilledPricing = { membershipId: string; amountCents: number; discount: c.AppliedMembershipDiscount | null };
/**
 * The upgrade's proration for the days left in the current period, or null when none are left (the switch falls on the
 * due date). The current period must have been billed to the membership at its current price: a membership line for
 * it on an invoice due within the period that isn't void or fully refunded (its cycle, its first period or an earlier
 * switch), with no staff price edit since that invoice was issued. Otherwise (a freeze resumed early, a trial
 * activated early, a first period left to the next billing date, an imported membership, a refunded period, a price
 * edited mid-period) the days left weren't paid at the current price, and the switch is refused rather than charging
 * a difference against them. The proration adds the new plan's taxes to the difference, which is exact only when both
 * plans carry the same tax rates, so an upgrade between plans taxed differently is refused too (`tax_change`).
 */
export async function prorateNow(tx: Transaction, row: Row, membership: c.Membership, plan: Plan, today: string): Promise<PlanChangeResult | null> {
  if (row.nextDueOn <= today) return null;
  const [currentTaxes, newTaxes] = [await planTaxes(tx, row.planId), await planTaxes(tx, plan.id)];
  if (currentTaxes.length !== newTaxes.length || currentTaxes.some((rate, index) => rate.id !== newTaxes[index]!.id))
    refuse('tax_change', 'The plans carry different tax rates, so the upgrade starts on the next billing date');
  const home = (await tx.select().from(households).where(eq(households.id, row.householdId)))[0]!;
  const newPlan = { id: plan.id, amountCents: plan.amountCents, currency: plan.currency, interval: plan.interval as c.BillingInterval,
    description: plan.name, taxRates: newTaxes };
  const newDiscount = switchDiscount(membership.discount, plan.id) === 'kept' ? priceDiscount(membership.discount) : undefined;
  const quote = (currentDiscount?: MembershipDiscount) => {
    // Malformed terms are an invariant failure, not evidence that the period wasn't billed.
    validateDiscount(currentDiscount); validateDiscount(newDiscount);
    try {
      return calculatePlanChange({ ...pricing(home, row.currency), membership, newPlan, changeOn: today,
        ...(currentDiscount ? { currentDiscount } : {}), ...(newDiscount ? { newDiscount } : {}),
        ...(row.anniversaryOn === null ? {} : { annualAnchorOn: row.anniversaryOn }) });
    } catch (error) {
      // The engine refuses a change before the period it works out: after a freeze resumed early, that period is a later one.
      if (error instanceof RangeError) notBilled();
      throw error;
    }
  };
  const result = quote();
  const bills = await tx.select({ id: invoices.id, issuedAt: invoices.createdAt, planId: invoiceLineItems.planId }).from(invoiceLineItems)
    .innerJoin(invoices, and(eq(invoices.gymId, invoiceLineItems.gymId), eq(invoices.id, invoiceLineItems.invoiceId)))
    .where(and(eq(invoiceLineItems.membershipId, row.id), eq(invoiceLineItems.kind, 'membership'),
      notInArray(invoices.status, ['draft', 'void', 'refunded']), gte(invoices.dueOn, result.periodStartsOn), lt(invoices.dueOn, result.periodEndsOn)))
    .orderBy(desc(invoices.dueOn), desc(invoices.createdAt));
  if (!bills.length) notBilled();
  const issued = await tx.select({ id: auditEvents.targetId, after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.action, 'billing.invoice.issued'), inArray(auditEvents.targetId, bills.map(bill => bill.id))));
  const snapshots = new Map(issued.map(event => [event.id,
    (event.after as { membershipPricing?: BilledPricing[] } | undefined)?.membershipPricing?.find(item => item.membershipId === row.id)]));
  // A prior upgrade may be followed by a downgrade that keeps its billed price for this period.
  // Match that price first, including when several switches share a clock instant.
  const billed = bills.find(bill => snapshots.get(bill.id)?.amountCents === row.amountCents)
    ?? bills.find(bill => bill.planId === row.planId) ?? bills[0]!;
  const snapshot = snapshots.get(billed.id);
  if (snapshot && snapshot.amountCents !== row.amountCents) notBilled();
  let currentDiscount = priceDiscount(snapshot?.discount);
  // Recover older invoices from ended/live applications only when the clock unambiguously
  // places one application across issuance. Boundary ties without a snapshot are refused.
  if (!snapshot) {
    const history = await tx.select().from(membershipDiscounts).where(and(eq(membershipDiscounts.membershipId, row.id),
      lte(membershipDiscounts.appliedAt, billed!.issuedAt), or(isNull(membershipDiscounts.endedAt), gte(membershipDiscounts.endedAt, billed!.issuedAt))));
    if (history.length > 1 || history.some(item => item.appliedAt.getTime() === billed!.issuedAt.getTime()
      || item.endedAt?.getTime() === billed!.issuedAt.getTime())) notBilled();
    currentDiscount = priceDiscount(history[0]);
  }
  // A staff price edit after the period was billed means the days left were paid at another price than the current one.
  const edits = await tx.select({ before: auditEvents.before, after: auditEvents.after }).from(auditEvents).where(and(
    eq(auditEvents.action, 'billing.membership.updated'), eq(auditEvents.targetId, row.id), gt(auditEvents.occurredAt, billed!.issuedAt!)));
  if (edits.some(edit => (edit.before as PriceSnapshot)?.amountCents !== (edit.after as PriceSnapshot)?.amountCents)) notBilled();
  return quote(currentDiscount);
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
  const { kind, commitmentBlocks } = switchTerms(row, member, plan, timing, today);
  const upgradeNow = timing === 'now' && kind === 'upgrade';
  if (timing === 'now') checkNow(row, plan, today);
  const result = upgradeNow ? await prorateNow(tx, row, membership, plan, today) : null;
  return { planId: plan.id, timing, kind, currency: row.currency, commitmentBlocks, discount: switchDiscount(membership.discount, plan.id),
    priceStartsOn: upgradeNow ? today : row.nextDueOn,
    proration: result && { periodStartsOn: result.periodStartsOn, periodEndsOn: result.periodEndsOn, billedDays: result.billedDays,
      periodDays: result.periodDays, totalCents: issuable(result)?.amountCents ?? 0 } };
}
