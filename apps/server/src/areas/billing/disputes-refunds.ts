// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { forGym, invoices, payments, refunds } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { terminalDisputeStatuses } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { logError } from '../../core/log.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../core/interfaces/invoice-transitions.js';
import type { ChargeOutcome, Dispute, Payments, Refund } from '../../infra/payments/index.js';
import type { BillingAlerts } from './alerts/index.js';
import { audit, lockInvoice } from './transitions/store.js';

type Payment = typeof payments.$inferSelect;
type Succeeded = Extract<ChargeOutcome, { status: 'succeeded' }>;

const terminal = new Set<string>(terminalDisputeStatuses);
/** Won, lost and closed disputes are final. */
export const isTerminalDispute = (status: string | null) => status !== null && terminal.has(status);
export const hasOpenDispute = (invoice: { disputeId: string | null; disputeStatus: string | null }) =>
  Boolean(invoice.disputeId) && !isTerminalDispute(invoice.disputeStatus);

/** RFC 9562 UUIDv5: stable across concurrent delivery, restore passes and process restarts. */
export function processorRefundId(gymId: string, processorId: string): string {
  const digest = createHash('sha1').update(Buffer.from(gymId.replaceAll('-', ''), 'hex'))
    .update('billing.refund:' + processorId).digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface DisputeRefundOptions {
  transitions: Pick<InvoiceTransitions, 'refund'>;
  scope?: typeof forGym;
  clock?: Clock;
  /** Queues the owner's dispute alert. Without it, the hourly dispute scan still finds the dispute. */
  disputeAlerts?: Pick<BillingAlerts, 'publishDispute'> | undefined;
}

/** The one writer for processor refunds and disputes, shared by the webhook handlers and restore reconciliation. */
export function createDisputeRefundWriter(options: DisputeRefundOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const system = (gymId: string): MutationContext => ({ gymId, actor: { kind: 'system' } });
  /** Refunds and disputes match their recorded payment through the parent PaymentIntent, never their own metadata.
   * One that arrives before the intent's success (or after restoring an earlier snapshot) first records the
   * succeeded intent, with its processor success time, through the caller's charge-outcome path. */
  async function parentPayment(gymId: string, provider: Payments, intentId: string,
    recordSuccess: (outcome: Succeeded) => Promise<unknown>): Promise<{ outcome: ChargeOutcome; payment?: Payment }> {
    const outcome = await provider.findCharge({ kind: 'charge', id: intentId });
    const chargeId = outcome.status === 'unknown' ? undefined : outcome.latestChargeId;
    const find = () => scope(gymId, async tx => (await tx.select().from(payments).where(or(eq(payments.paymentIntentId, intentId),
      ...(chargeId ? [eq(payments.chargeId, chargeId)] : []))))[0]);
    let payment = await find();
    if (!payment && outcome.status === 'succeeded') {
      // Only recording needs the success time, which costs another processor read.
      const timed = await provider.findCharge({ kind: 'charge', id: intentId }, { includeSuccessTime: true });
      if (timed.status === 'succeeded') await recordSuccess(timed);
      payment = await find();
    }
    return { outcome, ...(payment ? { payment } : {}) };
  }
  /** Applies a processor refund through the refund transition. A worker's reservation (duplicate-payment refunds) is
   * reused; any other new refund gets a deterministic ID, so every path records it as one row. False when the refund
   * does not belong to this payment. */
  async function refund(gymId: string, payment: Payment, value: Refund): Promise<boolean> {
    const currency = value.currency.toUpperCase();
    if (value.metadata.gymId !== gymId || currency !== payment.currency) return false;
    const refundId = await scope(gymId, async tx => {
      const existing = (await tx.select().from(refunds).where(eq(refunds.processorId, value.id)))[0];
      if (existing) return existing.id;
      const reservations = await tx.select().from(refunds).where(and(eq(refunds.paymentId, payment.id),
        isNull(refunds.processorId), eq(refunds.status, 'pending')));
      if (reservations.length) {
        if (reservations.length !== 1 || reservations[0]!.amountCents !== value.amount
          || reservations[0]!.currency !== currency) throw new Error('Refund reservation is ambiguous');
        return reservations[0]!.id;
      }
      return processorRefundId(gymId, value.id);
    });
    const apply = (id: string) => options.transitions.refund(system(gymId), { invoiceId: payment.invoiceId, paymentId: payment.id,
      refundId: id, processorId: value.id, amountCents: value.amount, currency: currency as 'USD' | 'CAD', status: value.status });
    try {
      await apply(refundId);
    } catch (error) {
      // A concurrent delivery or restore pass may have recorded this processor refund first, under another local ID.
      const raced = await scope(gymId, async tx => (await tx.select().from(refunds).where(eq(refunds.processorId, value.id)))[0]);
      if (!raced || raced.paymentId !== payment.id || raced.amountCents !== value.amount || raced.currency !== currency) throw error;
      await apply(raced.id);
    }
    return true;
  }
  /** Records a dispute's current status on its payment's invoice, under the invoice lock. Only the dispute ID and
   * status change, with an audit; final statuses never reopen. Another dispute on the invoice needs staff resolution.
   * A newly recorded dispute publishes its owner alert, whose permanent key sends it once. The alert never fails the
   * recorded write: the hourly dispute scan recovers one that couldn't be queued. */
  async function dispute(gymId: string, payment: Payment, value: Dispute): Promise<'recorded' | 'unchanged' | 'conflict'> {
    const result = await scope(gymId, async tx => {
      const invoice = await lockInvoice(tx, payment.invoiceId);
      if (invoice.disputeId && invoice.disputeId !== value.id) return 'conflict' as const;
      if (invoice.disputeId === value.id && (invoice.disputeStatus === value.status || isTerminalDispute(invoice.disputeStatus)))
        return 'unchanged' as const;
      const after = { disputeId: value.id, disputeStatus: value.status };
      await tx.update(invoices).set(after).where(eq(invoices.id, invoice.id));
      await audit(tx, system(gymId), clock, 'billing.invoice.disputed', 'invoice', invoice.id, after,
        { disputeId: invoice.disputeId, disputeStatus: invoice.disputeStatus });
      return 'recorded' as const;
    });
    if (result === 'recorded') {
      try { await options.disputeAlerts?.publishDispute(gymId, payment.invoiceId, value.id); }
      catch (error) { logError('billing.dispute.alert_publish_failed', { gymId, invoiceId: payment.invoiceId }, error); }
    }
    return result;
  }
  return { parentPayment, refund, dispute };
}
export type DisputeRefundWriter = ReturnType<typeof createDisputeRefundWriter>;
