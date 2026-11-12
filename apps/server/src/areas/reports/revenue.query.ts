// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gte, isNull, lt, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Reviewed reversal JSON projection and UUID-array predicates; values are bound and all reads remain gym-scoped.
import { sql } from 'drizzle-orm';
import { auditEvents, chargeTypes, classPacks, classPackSales, invoiceLineItems, invoices, memberships, payments, plans, refunds, taxRates,
  type Transaction } from '@plaingym/db';

/** Four bounded statements, regardless of month, payment or line count; all names remain under RLS. */
export async function readRevenue(tx: Transaction, gymId: string, startsAt: Date, endsAt: Date) {
  const reversalJoin = and(eq(auditEvents.gymId, refunds.gymId), eq(auditEvents.targetId, refunds.id),
    eq(auditEvents.targetType, 'refund'), eq(auditEvents.action, 'billing.refund.reversed'));
  // A reversed row's resolved_at is its failure time. The append-only event preserves its success time.
  // Fixed JSON key from the billing transition's snapshot, no interpolated SQL identifiers.
  const originalResolvedAt = sql<string | null>`${auditEvents.before}->>'resolvedAt'`;
  const succeededAt = sql`case when ${refunds.status} = 'succeeded' then ${refunds.resolvedAt} else (${originalResolvedAt})::timestamptz end`;
  // Keep the ordinary success range on resolved_at, so its time index remains usable.
  // Reversals are discovered through their audit action, without joining every historical refund.
  const refundPaymentsInRange = tx.select({ id: refunds.paymentId }).from(refunds)
    .where(and(eq(refunds.gymId, gymId), eq(refunds.status, 'succeeded'),
      gte(refunds.resolvedAt, startsAt), lt(refunds.resolvedAt, endsAt)))
    .union(tx.select({ id: refunds.paymentId }).from(auditEvents).innerJoin(refunds, reversalJoin)
      .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.targetType, 'refund'), eq(auditEvents.action, 'billing.refund.reversed'),
        or(and(gte(sql`(${originalResolvedAt})::timestamptz`, startsAt.toISOString()),
          lt(sql`(${originalResolvedAt})::timestamptz`, endsAt.toISOString())),
        and(gte(auditEvents.occurredAt, startsAt), lt(auditEvents.occurredAt, endsAt))))));
  const received = await tx.select({ payment: payments, invoiceAmount: invoices.amountCents }).from(payments)
    .innerJoin(invoices, and(eq(invoices.gymId, payments.gymId), eq(invoices.id, payments.invoiceId)))
    .where(and(eq(payments.gymId, gymId), gte(payments.paidAt, startsAt), lt(payments.paidAt, endsAt)));
  const returned = await tx.select({ refund: refunds, payment: payments, invoiceAmount: invoices.amountCents,
    originalResolvedAt, reversedAt: auditEvents.occurredAt }).from(refunds)
    .innerJoin(payments, and(eq(payments.gymId, refunds.gymId), eq(payments.id, refunds.paymentId)))
    .innerJoin(invoices, and(eq(invoices.gymId, payments.gymId), eq(invoices.id, payments.invoiceId)))
    .leftJoin(auditEvents, reversalJoin)
    // Earlier successes/reversals establish cumulative rounding for payments with activity in this range.
    // ARRAY runs the candidate query once as an InitPlan and permits indexed payment-ID lookups.
    .where(and(eq(refunds.gymId, gymId), sql`${refunds.paymentId} = any(array(${refundPaymentsInRange.getSQL()}))`, lt(succeededAt, endsAt.toISOString()),
      or(eq(refunds.status, 'succeeded'), eq(auditEvents.action, 'billing.refund.reversed'))));
  // Reuse IDs already read instead of scanning payments again. One bound UUID-array literal per
  // statement keeps both the bind count and indexed lookups independent of the number of IDs.
  const touched = [...received, ...returned];
  const invoiceIds = '{' + [...new Set(touched.map(row => row.payment.invoiceId))].join(',') + '}';
  const paymentIds = '{' + [...new Set(touched.map(row => row.payment.id))].join(',') + '}';
  const lines = await tx.select({ line: invoiceLineItems, planId: plans.id, planName: plans.name,
    chargeName: chargeTypes.name, taxName: taxRates.name, packId: classPacks.id, packName: classPacks.name }).from(invoiceLineItems)
    .leftJoin(memberships, and(eq(memberships.gymId, invoiceLineItems.gymId), eq(memberships.id, invoiceLineItems.membershipId)))
    // A line groups under the plan it recorded when billed; a line from before plans were recorded, under its membership's current plan.
    .leftJoin(plans, and(eq(plans.gymId, invoiceLineItems.gymId), or(eq(plans.id, invoiceLineItems.planId),
      and(isNull(invoiceLineItems.planId), eq(plans.id, memberships.planId)))))
    .leftJoin(chargeTypes, and(eq(chargeTypes.gymId, invoiceLineItems.gymId), eq(chargeTypes.id, invoiceLineItems.chargeTypeId)))
    .leftJoin(taxRates, and(eq(taxRates.gymId, invoiceLineItems.gymId), eq(taxRates.id, invoiceLineItems.taxRateId)))
    // A class pack sale's invoice has one untyped charge line: the pack it sold.
    .leftJoin(classPackSales, and(eq(classPackSales.gymId, invoiceLineItems.gymId), eq(classPackSales.invoiceId, invoiceLineItems.invoiceId),
      eq(invoiceLineItems.kind, 'charge'), isNull(invoiceLineItems.chargeTypeId)))
    .leftJoin(classPacks, and(eq(classPacks.gymId, classPackSales.gymId), eq(classPacks.id, classPackSales.packId)))
    .where(and(eq(invoiceLineItems.gymId, gymId), sql`${invoiceLineItems.invoiceId} = any(${invoiceIds}::uuid[])`));
  const markers = await tx.select({ paymentId: auditEvents.targetId, after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'billing.payment.recorded'), eq(auditEvents.targetType, 'payment'),
      sql`${auditEvents.targetId} = any(${paymentIds}::uuid[])`));
  return { received, returned, lines, markers };
}
export type RevenueData = Awaited<ReturnType<typeof readRevenue>>;
