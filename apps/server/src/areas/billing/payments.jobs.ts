// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { auditEvents, forGym, households, invoices, paymentMethods, payments, refunds, writeAudit } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import { notFound } from '../../core/interfaces/common.js';
import { logInfo } from '../../core/log.js';
import type { JobRegistration } from '../../core/registry.js';
import type { TransitionNotifications } from './transitions/notifications.js';
import { snapshot } from './transitions/store.js';
import { PaymentMethodCustomerDeleted, type DetachOptions, type Payments } from '../../infra/payments/index.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import { cardDetachedAction, detachJob, receiptJob, recordCardDetached, transientFailure } from './payments.mutations.js';
import { customerUnlinkedAction } from './customers.js';
import { customerAdoptedAction, recordCustomerAdoption } from './customer-adoption.js';
import { refundRetryWindowMs, refundSettleSkewMs, settleLapsed } from './transitions/lapsed-refunds.js';

export const lapsedRefundJob = 'billing.payments.settle_lapsed';
/** The ordinary per-gym job lane serializes this sweep with duplicate-refund workers. A staff retry still sending a row
 * is waited for (`settleLapsed`). No transaction holds a provider call. */
export function createLapsedRefundJobs(options: { scope?: typeof forGym; clock: Clock; transitions: InvoiceTransitions;
  payments(gymId: string): Promise<Payments> }): readonly JobRegistration[] {
  const scope = options.scope ?? forGym;
  return [{ id: lapsedRefundJob, cron: '43 * * * *', async handler(_payload, context) {
    const rows = await scope(context.gymId, tx => tx.select({ reservation: refunds, payment: payments }).from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId)).where(and(eq(refunds.status, 'pending'), isNotNull(refunds.taggedAt),
        isNull(refunds.processorId), lte(refunds.createdAt, new Date(options.clock.now().getTime() - refundRetryWindowMs - refundSettleSkewMs)),
        inArray(payments.method, ['card', 'bank_debit']))).orderBy(asc(refunds.createdAt), asc(refunds.id)).limit(100));
    // Resolve the provider only when a payment needs Stripe; a gym without Stripe has nothing to settle, and a payment
    // marked as test is released without it.
    let provider: Promise<Payments> | undefined;
    const providerFor = () => provider ??= options.payments(context.gymId);
    // Each payment's refunds are listed once. A row that can't settle stays pending for staff. The oldest come first, so
    // it must not hold back the rows behind it, and the run still ends failed.
    const byPayment = new Map<string, { payment: typeof rows[number]['payment']; reservations: (typeof rows[number]['reservation'])[] }>();
    for (const { reservation, payment } of rows) {
      const group = byPayment.get(payment.id) ?? { payment, reservations: [] };
      group.reservations.push(reservation); byPayment.set(payment.id, group);
    }
    const failures: unknown[] = [];
    for (const { payment, reservations } of byPayment.values()) {
      await settleLapsed({ scope, clock: options.clock, transitions: options.transitions }, { gymId: context.gymId, actor: { kind: 'system' } },
        providerFor, payment, reservations).catch((error: unknown) => { failures.push(error); });
    }
    if (failures.length) throw failures[0];
  } }];
}

interface DeliveryOptions {
  scope?: typeof forGym;
  notifications: TransitionNotifications;
  detachCard(gymId: string, processorId: string, options?: DetachOptions): Promise<void>;
  /** Adopts the household's stored Stripe customer for this gym (tags an untagged one); rejects one tagged for another gym or deleted. */
  adoptCustomer?(gymId: string, customerId: string): Promise<{ adopted: boolean }>;
}
let configured: DeliveryOptions | undefined;
export function configurePaymentDelivery(options: DeliveryOptions) { configured = options; }
export function createPaymentJobs(options?: DeliveryOptions): readonly JobRegistration[] {
  const read = () => { const value = options ?? configured; if (!value) throw new Error('Payment delivery is not configured'); return value; };
  return [
    { id: receiptJob, async handler(payload, ctx) {
      const { invoiceId } = payload as { invoiceId: string }; idSchema.parse(invoiceId);
      const options = read(), scope = options.scope ?? forGym;
      const notice = await scope(ctx.gymId, async tx => {
        const invoice = (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)))[0] ?? notFound();
        if (!invoice.paidAt) throw new Error('Invoice has no receipt');
        const payment = (await tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)))[0];
        // Each requested resend is its own job, so it sends again, and a retry of this job does not.
        return { gymId: ctx.gymId, generation: ctx.jobId, invoice: snapshot(invoice), ...(payment ? { payment } : {}) };
      });
      await options.notifications.receipt(notice, { emailOnly: true });
    } },
    { id: detachJob, async handler(payload, ctx) {
      const { paymentMethodId, redactBillingDetails, customerId } = payload as { paymentMethodId: string; redactBillingDetails?: boolean; customerId?: unknown };
      idSchema.parse(paymentMethodId);
      const options = read(), scope = options.scope ?? forGym;
      const { row, stripeCustomerId, anonymizedCustomerId, detached } = await scope(ctx.gymId, async tx => {
        const found = (await tx.select({ row: paymentMethods, stripeCustomerId: households.stripeCustomerId })
          .from(paymentMethods).innerJoin(households, eq(households.id, paymentMethods.householdId)).where(and(
            eq(paymentMethods.id, paymentMethodId), eq(paymentMethods.isDefault, false))))[0] ?? notFound();
        const done = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
          eq(auditEvents.action, cardDetachedAction), eq(auditEvents.targetType, 'payment_method'),
          eq(auditEvents.targetId, paymentMethodId))).limit(1);
        const latestLinkAudit = found.stripeCustomerId === null ? (await tx.select({ action: auditEvents.action, before: auditEvents.before }).from(auditEvents).where(and(
          inArray(auditEvents.action, ['household.anonymized', customerUnlinkedAction]), eq(auditEvents.targetType, 'household'),
          eq(auditEvents.targetId, found.row.householdId))).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1))[0] : undefined;
        return { row: found.row, stripeCustomerId: found.stripeCustomerId,
          anonymizedCustomerId: latestLinkAudit?.action === 'household.anonymized'
            ? (latestLinkAudit.before as { stripeCustomerId?: unknown } | null | undefined)?.stripeCustomerId
            : undefined,
          detached: done.length > 0 };
      });
      // Only an erasure asks for the card's billing details to be cleared; a staff removal queues the job without the flag.
      if (!row.revokedAt) return;
      if (detached && redactBillingDetails !== true) return;
      const detach = () => redactBillingDetails === true ? options.detachCard(ctx.gymId, row.processorId, { redactBillingDetails: true })
        : options.detachCard(ctx.gymId, row.processorId);
      // An erasure clears the household's customer link in the transaction that queues this job, so its payload carries
      // the customer ID it read from that household's row; a detach queued before the erasure falls back to the latest
      // household.anonymized audit's cleared ID only when no unlink came after the erasure. The stored link wins, then
      // the payload's, then the audit's.
      const validCustomerId = (value: unknown) => typeof value === 'string' && /^cus_[A-Za-z0-9]+$/.test(value) ? value : null;
      const erasedCustomerId = validCustomerId(customerId);
      const adoptId = stripeCustomerId ?? erasedCustomerId ?? validCustomerId(anonymizedCustomerId);
      try { await detach(); }
      catch (first) {
        // The card's own customer was deleted at Stripe, so nothing can charge the card for it: the card counts as
        // detached. Its billing details at Stripe stay as they are; the deleted customer no longer reaches them.
        if (first instanceof PaymentMethodCustomerDeleted) {
          logInfo('billing.card.detach_customer_deleted', { gymId: ctx.gymId, paymentMethodId: row.id, redactBillingDetails: redactBillingDetails === true });
          await recordCardDetached(scope, { gymId: ctx.gymId, actor: { kind: 'system' } }, ctx.clock, row);
          return;
        }
        // A people CSV can save the household's method and mandate on its customer without tagging it. Adopt only the
        // customer the method's own household links (or linked until its erasure), then detach once more. Another gym's
        // or a deleted customer is refused by adoption, and the first refusal stands; a method on any other customer is
        // refused by the second detach. An outage or a key's missing permission is left to the job's retry.
        if (!options.adoptCustomer || !adoptId || transientFailure(first)) throw first;
        let result: { adopted: boolean };
        try { result = await options.adoptCustomer(ctx.gymId, adoptId); }
        catch { throw first; }
        if (result.adopted) await recordCustomerAdoption(scope, ctx.gymId, row.householdId, adoptId, tx => writeAudit(tx, {
          gymId: ctx.gymId, actorKind: 'system', action: customerAdoptedAction,
          targetType: 'household', targetId: row.householdId,
          after: { customerId: adoptId, paymentMethodId: row.id, source: 'detach' }, occurredAt: ctx.clock.now(),
        }));
        await detach();
      }
      await recordCardDetached(scope, { gymId: ctx.gymId, actor: { kind: 'system' } }, ctx.clock, row);
    } },
  ];
}
export const jobs = createPaymentJobs();
