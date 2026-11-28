// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gt, gte, inArray, lt } from 'drizzle-orm';
import { auditEvents, type households, invoiceLineItems, invoices, memberships, plans, type Transaction } from '@plaingym/db';
import * as c from '@plaingym/shared/contracts';
import { addDays, monthStart, nextMonth } from '@plaingym/shared/time';
import { calculatePlanChange, currentPeriodStart, type CalculatedInvoice, type PlanChangeResult } from './invoicing/index.js';
import { isOffDay } from './invoicing/calendar.js';
import { calendarDaysBetween } from './memberships.calendar.js';
import { cycleConflictAction, pricing } from './runner/store.js';
import { planSwitchedAction, refuse, switchTerms, type PlanSwitchedNowAudit } from './memberships.plan-change.js';
import { priceDiscount, switchDiscount } from './discounts/apply.js';
import { planTaxes } from './memberships.plan-change.taxes.js';
export { planTaxes } from './memberships.plan-change.taxes.js';

type Row = typeof memberships.$inferSelect;
type Plan = typeof plans.$inferSelect;

type Household = typeof households.$inferSelect;
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
const auditDate = (value: unknown) => {
  const date = (value as { nextDueOn?: unknown } | null | undefined)?.nextDueOn;
  return typeof date === 'string' && c.dateSchema.safeParse(date).success ? date : null;
};
/**
 * The days an annual membership's resume moved its due date (and so its billed period) later: its latest activation
 * resumed a freeze and set the row's current due date. A monthly membership, or a date edited since, answers 0.
 */
async function resumeShift(tx: Transaction, row: Row): Promise<number> {
  if (row.interval !== 'annual') return 0;
  const [resume] = await tx.select({ before: auditEvents.before, after: auditEvents.after }).from(auditEvents).where(and(
    eq(auditEvents.action, 'billing.membership.activated'), eq(auditEvents.targetId, row.id)))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
  if ((resume?.before as { status?: unknown } | null | undefined)?.status !== 'frozen') return 0;
  const from = auditDate(resume?.before), to = auditDate(resume?.after);
  if (from === null || to === null || to !== row.nextDueOn) return 0;
  const shift = calendarDaysBetween(from, to);
  return shift > 0 ? shift : 0;
}
type PriceSnapshot = { amountCents?: unknown } | null;
/**
 * The upgrade's proration for the days left in the current period, or null when none are left (the switch falls on the
 * due date). The current period must have been billed to the membership at its current price: a membership line for
 * it on a cycle, cycle-conflict or first-period invoice that isn't void or fully refunded, with no staff price edit since billing.
 * An earlier switch supplies updated terms, but cannot establish that the period was billed. An annual resume moved
 * the period later by the days frozen, so the cycle bill due up to that shift before the period's start bills it.
 * Otherwise (a monthly freeze resumed early, a trial
 * activated early, a first period left to the next billing date, an imported membership, a refunded period, a price
 * edited mid-period) the days left weren't paid at the current price, and the switch is refused rather than charging
 * a difference against them. The proration adds the new plan's taxes to the difference, which is exact only when both
 * plans carry the same tax rates, so an upgrade between plans taxed differently is refused too (`tax_change`).
 */
export async function prorateNow(tx: Transaction, home: Household, row: Row, membership: c.Membership, plan: Plan, today: string): Promise<PlanChangeResult | null> {
  if (row.nextDueOn <= today) return null;
  const [currentTaxes, newTaxes] = [await planTaxes(tx, row.planId), await planTaxes(tx, plan.id)];
  if (currentTaxes.length !== newTaxes.length || currentTaxes.some((rate, index) => rate.id !== newTaxes[index]!.id))
    refuse('tax_change', 'The plans carry different tax rates, so the upgrade starts on the next billing date');
  const newPlan = { id: plan.id, amountCents: plan.amountCents, currency: plan.currency, interval: plan.interval as c.BillingInterval,
    description: plan.name, taxRates: newTaxes };
  const newDiscount = switchDiscount(membership.discount, plan.id) === 'kept' ? priceDiscount(membership.discount) : undefined;
  const terms = pricing(home, row.currency);
  const item = { membership, description: newPlan.description, taxRates: newTaxes,
    ...(row.anniversaryOn === null ? {} : { annualAnchorOn: row.anniversaryOn }) };
  // The due date's own day is the earliest possible start: February 28 can follow January 28 through 31.
  const earliestStart = currentPeriodStart(terms, item);
  // An annual resume moved the paid period later by the days frozen, so its cycle bill is due up to that shift earlier.
  const shift = await resumeShift(tx, row);
  const candidates = await tx.select({ id: invoices.id, issuedAt: invoices.createdAt, kind: invoices.kind,
    dueOn: invoices.dueOn, status: invoices.status, planId: invoiceLineItems.planId, amountCents: invoiceLineItems.billedUnitAmountCents,
    discount: invoiceLineItems.billedDiscount }).from(invoiceLineItems)
    .innerJoin(invoices, and(eq(invoices.gymId, invoiceLineItems.gymId), eq(invoices.id, invoiceLineItems.invoiceId)))
    .where(and(eq(invoiceLineItems.membershipId, row.id), eq(invoiceLineItems.kind, 'membership'),
      gte(invoices.dueOn, addDays(earliestStart, -shift)), lt(invoices.dueOn, row.nextDueOn)))
    .orderBy(desc(invoices.dueOn), desc(invoices.createdAt), desc(invoices.id));
  const usable = candidates.filter(bill => !['draft', 'void', 'refunded'].includes(bill.status));
  if (!usable.length) notBilled();
  const earliestBill = usable.reduce((earliest, bill) => bill.issuedAt < earliest ? bill.issuedAt : earliest, usable[0]!.issuedAt);
  const switches = await tx.select({ after: auditEvents.after, occurredAt: auditEvents.occurredAt }).from(auditEvents).where(and(
    eq(auditEvents.action, planSwitchedAction), eq(auditEvents.targetId, row.id), gte(auditEvents.occurredAt, earliestBill)));
  const recorded = switches.map(event => ({ ...event, after: event.after as PlanSwitchedNowAudit | null }));
  const switchInvoices = new Set(recorded.map(event => event.after?.invoiceId).filter(id => id !== null && id !== undefined));
  // A cycle or conflict bill identifies the original anchor; an earlier switch's one-off invoice doesn't. A cycle bill
  // after the previous month-end (a due date edited mid-period) names no anchor, so the own-day rule applies.
  const ambiguous = row.interval === 'monthly' && isOffDay(row.nextDueOn, home.billingDay)
    && addDays(row.nextDueOn, 1) === nextMonth(monthStart(row.nextDueOn));
  const previousEnd = addDays(monthStart(row.nextDueOn), -1);
  // Conflict audits can't change the outcome when a cycle bill already decides it: any cycle bill proves an unambiguous
  // period, and an ambiguous one is anchored by the latest bill before the month-end only when that bill is the cycle bill.
  const hasCycle = ambiguous ? usable.find(bill => bill.dueOn <= previousEnd)?.kind === 'cycle'
    : usable.some(bill => bill.kind === 'cycle');
  const conflicts = new Set(hasCycle ? [] : (await tx.select({ id: auditEvents.targetId }).from(auditEvents).where(and(
    eq(auditEvents.action, cycleConflictAction), inArray(auditEvents.targetId, usable.map(bill => bill.id)))))
    .map(event => event.id));
  const cycleBill = (bill: typeof usable[number]) => bill.kind === 'cycle' || conflicts.has(bill.id);
  const billedPeriodStartsOn = ambiguous
    ? usable.find(bill => cycleBill(bill) && bill.dueOn <= previousEnd)?.dueOn : undefined;
  const periodStartsOn = currentPeriodStart(terms, item, billedPeriodStartsOn);
  const bills = usable.filter(bill => bill.dueOn >= addDays(periodStartsOn, -shift));
  if (!bills.some(bill => cycleBill(bill) || (bill.dueOn === row.startsOn && !switchInvoices.has(bill.id)))) notBilled();
  const from = today > membership.startsOn ? today : membership.startsOn;
  // Only this precondition denotes an unbilled period (for example, a freeze resumed early).
  // Other engine errors are invariant failures and must reach the error handler.
  if (from < periodStartsOn) notBilled();
  // A prior upgrade may be followed by a downgrade that keeps its billed price for this period.
  // Match that price first, including when several switches share a clock instant.
  const billed = bills.find(bill => bill.amountCents === row.amountCents)
    ?? bills.find(bill => bill.planId === row.planId) ?? bills[0]!;
  let billedAmount = billed.amountCents, billedDiscount = billed.discount;
  // A zero-charge upgrade has no invoice line. Its audited result carries the accepted new terms until the next bill.
  const latest = bills[0]!;
  const freeUpgrade = recorded.filter(event => event.occurredAt >= latest.issuedAt).map(event => event.after).find(event =>
    event?.request?.timing === 'now' && event.kind === 'upgrade' && event.invoiceId === null
    && event.membership?.amountCents === row.amountCents && event.membership.nextDueOn === row.nextDueOn
    && bills.every(bill => bill.amountCents === null || bill.amountCents < event.membership.amountCents));
  if (billedAmount !== row.amountCents && freeUpgrade) {
    billedAmount = freeUpgrade.membership.amountCents; billedDiscount = freeUpgrade.membership.discount;
  }
  // Unknown legacy terms are never inferred from mutable applications or application timestamps.
  if (billedAmount !== row.amountCents) notBilled();
  const currentDiscount = priceDiscount(billedDiscount);
  // A staff price edit after the period was billed means the days left were paid at another price than the current one.
  const edits = await tx.select({ before: auditEvents.before, after: auditEvents.after }).from(auditEvents).where(and(
    eq(auditEvents.action, 'billing.membership.updated'), eq(auditEvents.targetId, row.id), gt(auditEvents.occurredAt, billed.issuedAt)));
  if (edits.some(edit => (edit.before as PriceSnapshot)?.amountCents !== (edit.after as PriceSnapshot)?.amountCents)) notBilled();
  return calculatePlanChange({ ...terms, membership, newPlan, changeOn: today,
    ...(billedPeriodStartsOn === undefined ? {} : { billedPeriodStartsOn }),
    ...(currentDiscount ? { currentDiscount } : {}), ...(newDiscount ? { newDiscount } : {}),
    ...(row.anniversaryOn === null ? {} : { annualAnchorOn: row.anniversaryOn }) });
}
/**
 * The proration invoice to issue, or null. The engine returns none for a proration rounded to zero, and a zero total
 * (a full household discount) is not issued either: no charge path settles a zero one-off invoice.
 */
export function issuable(result: PlanChangeResult | null): CalculatedInvoice | null {
  return result?.invoice && result.invoice.amountCents > 0 ? result.invoice : null;
}
/**
 * What a switch would do, with the switch's refusals except the commitment, which it reports.
 * For a non-active membership, priceStartsOn is the scheduled lower bound: the price only applies when billed as active.
 */
export async function switchPreview(tx: Transaction, home: Household, row: Row, membership: c.Membership, member: { anonymizedAt: Date | null },
  plan: Plan, timing: c.PlanSwitchTiming, today: string): Promise<c.MembershipSwitchPreview> {
  const { kind, commitmentBlocks } = switchTerms(row, member, plan, timing, today);
  const upgradeNow = timing === 'now' && kind === 'upgrade';
  if (timing === 'now') checkNow(row, plan, today);
  const result = upgradeNow ? await prorateNow(tx, home, row, membership, plan, today) : null;
  return { planId: plan.id, timing, kind, currency: row.currency, commitmentBlocks, discount: switchDiscount(membership.discount, plan.id),
    priceStartsOn: upgradeNow ? today : row.nextDueOn,
    proration: result && { periodStartsOn: result.periodStartsOn, periodEndsOn: result.periodEndsOn, billedDays: result.billedDays,
      periodDays: result.periodDays, totalCents: issuable(result)?.amountCents ?? 0 } };
}
