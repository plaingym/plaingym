// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { auditEvents, chargeTypes, invoiceLineItems, invoices, memberships, payments, plans, refunds, taxRates, type Transaction } from '@plaingym/db';

/** Four bounded statements, regardless of month, payment or line count; all names remain under RLS. */
export async function readRevenue(tx: Transaction, gymId: string, startsAt: Date, endsAt: Date) {
  const received = await tx.select({ payment: payments, invoiceAmount: invoices.amountCents }).from(payments)
    .innerJoin(invoices, and(eq(invoices.gymId, payments.gymId), eq(invoices.id, payments.invoiceId)))
    .where(and(eq(payments.gymId, gymId), gte(payments.paidAt, startsAt), lt(payments.paidAt, endsAt)));
  const returned = await tx.select({ refund: refunds, payment: payments, invoiceAmount: invoices.amountCents }).from(refunds)
    .innerJoin(payments, and(eq(payments.gymId, refunds.gymId), eq(payments.id, refunds.paymentId)))
    .innerJoin(invoices, and(eq(invoices.gymId, payments.gymId), eq(invoices.id, payments.invoiceId)))
    .where(and(eq(refunds.gymId, gymId), eq(refunds.status, 'succeeded'), gte(refunds.resolvedAt, startsAt), lt(refunds.resolvedAt, endsAt)));
  const touched = [...received, ...returned];
  const invoiceIds = [...new Set(touched.map(row => row.payment.invoiceId))];
  const lines = await tx.select({ line: invoiceLineItems, planId: plans.id, planName: plans.name,
    chargeName: chargeTypes.name, taxName: taxRates.name }).from(invoiceLineItems)
    .leftJoin(memberships, and(eq(memberships.gymId, invoiceLineItems.gymId), eq(memberships.id, invoiceLineItems.membershipId)))
    .leftJoin(plans, and(eq(plans.gymId, memberships.gymId), eq(plans.id, memberships.planId)))
    .leftJoin(chargeTypes, and(eq(chargeTypes.gymId, invoiceLineItems.gymId), eq(chargeTypes.id, invoiceLineItems.chargeTypeId)))
    .leftJoin(taxRates, and(eq(taxRates.gymId, invoiceLineItems.gymId), eq(taxRates.id, invoiceLineItems.taxRateId)))
    .where(and(eq(invoiceLineItems.gymId, gymId), inArray(invoiceLineItems.invoiceId, invoiceIds)));
  const markers = await tx.select({ paymentId: auditEvents.targetId, after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'billing.payment.recorded'), eq(auditEvents.targetType, 'payment'),
      inArray(auditEvents.targetId, [...new Set(touched.map(row => row.payment.id))])));
  return { received, returned, lines, markers };
}
export type RevenueData = Awaited<ReturnType<typeof readRevenue>>;
