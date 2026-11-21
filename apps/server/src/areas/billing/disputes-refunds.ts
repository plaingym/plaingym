// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import { forGym, invoices, payments, refunds } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { refundReleased, stripeTestPaymentReference, terminalDisputeStatuses } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { logError } from '../../core/log.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { InvoiceTransitions, ProcessorRefundTransition } from '../../core/interfaces/invoice-transitions.js';
import type { ChargeOutcome, Dispute, Payments, Refund } from '../../infra/payments/index.js';
import type { BillingAlerts } from './alerts/index.js';
import { stripeWriteCurrent, stripeWriteScope } from './stripe-writes.js';
import { audit, effect, lockInvoice, recorded } from './transitions/store.js';

type Payment = typeof payments.$inferSelect;
type Succeeded = Extract<ChargeOutcome, { status: 'succeeded' }>;

const terminal = new Set<string>(terminalDisputeStatuses);
/** Won, lost and closed disputes are final. */
export const isTerminalDispute = (status: string | null) => status !== null && terminal.has(status);
export const hasOpenDispute = (invoice: { disputeId: string | null; disputeStatus: string | null }) =>
  Boolean(invoice.disputeId) && !isTerminalDispute(invoice.disputeStatus);

/** A name-based RFC 9562 UUIDv8 over SHA-256 (its Appendix B.2 layout): stable across concurrent delivery, restore
 * passes and process restarts. */
export function processorRefundId(gymId: string, processorId: string): string {
  const digest = createHash('sha256').update(Buffer.from(gymId.replaceAll('-', ''), 'hex'))
    .update('billing.refund:' + processorId).digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface DisputeRefundOptions {
  transitions: Pick<InvoiceTransitions, 'processorRefund'>;
  scope?: typeof forGym;
  clock?: Clock;
  /** Queues the owner's dispute alert. Without it, the hourly dispute scan still finds the dispute. */
  disputeAlerts?: Pick<BillingAlerts, 'publishDispute'> | undefined;
}

/** The one writer for processor refunds and disputes, shared by the webhook handlers and restore reconciliation. */
export function createDisputeRefundWriter(options: DisputeRefundOptions) {
  const scope = stripeWriteScope(options.scope ?? forGym), clock = options.clock ?? defaultClock;
  const system = (gymId: string): MutationContext => ({ gymId, actor: { kind: 'system' } });
  /** The payment already recorded for a PaymentIntent, read without calling the processor. */
  const recordedPayment = (gymId: string, intentId: string) =>
    scope(gymId, async tx => (await tx.select().from(payments).where(eq(payments.paymentIntentId, intentId)))[0]);
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
  /** Applies a processor refund through the processor refund transition. A refund that names a tagged reservation on this payment
   * takes that row; an untagged reservation, from before the marker, keeps matching any refund of its payment. Every
   * other refund is external: it gets a deterministic ID, so every path records it as one row, and it leaves
   * reservations to the app's own refund, unless the processor has no room left for them: those never reached it, and
   * are released (untagged ones too, once a refund naming another reservation leaves them unmatched). False when the
   * refund does not belong to this payment. */
  async function refund(gymId: string, payment: Payment, value: Refund, provider: Pick<Payments, 'readPaymentObject'>): Promise<boolean> {
    const currency = value.currency.toUpperCase();
    if (value.metadata.gymId !== gymId || currency !== payment.currency
      || ![payment.paymentIntentId, payment.chargeId].includes(value.chargeId)) return false;
    // Processor reads stay outside the transaction. The transition rechecks the selected reservation and every
    // pending amount under the invoice lock, then releases and records atomically. A refund the processor reports
    // missing is passed apart from the found ones: the transition releases it only as far as an external refund needs
    // its room, with a staff notice. A read that throws fails this write, so a network error never releases anything;
    // the app's own refund and an already recorded one never wait on another refund.
    const pending = refundReleased(value) ? [] : await scope(gymId, tx => tx.select().from(refunds)
      .where(eq(refunds.paymentId, payment.id)));
    const pendingRefunds: Refund[] = [];
    const missingRefunds: string[] = [];
    for (const row of pending.filter(row => row.status === 'pending' && row.processorId !== null && row.processorId !== value.id)) {
      const found = await provider.readPaymentObject({ kind: 'refund', id: row.processorId! });
      if (found.status === 'unknown') missingRefunds.push(row.processorId!);
      else if (found.status === 'found' && found.value.kind === 'refund') pendingRefunds.push(found.value.object);
    }
    const request: ProcessorRefundTransition = { invoiceId: payment.invoiceId, paymentId: payment.id,
      refundId: processorRefundId(gymId, value.id), processorRefund: value, pendingRefunds, missingRefunds };
    await options.transitions.processorRefund(system(gymId), request);
    // A timed-out request may finish after settlement listed Stripe and released its reservation. Its external row
    // records the money; a durable follow-up corrects the earlier release notice, once, including on webhook replay.
    if (value.reservationId && value.status === 'succeeded') await scope(gymId, async tx => {
      await lockInvoice(tx, payment.invoiceId);
      const [released] = await tx.select().from(refunds).where(eq(refunds.id, value.reservationId!));
      const [external] = await tx.select().from(refunds).where(eq(refunds.processorId, value.id));
      if (!released || released.paymentId !== payment.id || released.status !== 'failed' || released.processorId !== null
        || released.taggedAt === null || released.amountCents !== value.amount || released.currency !== currency
        || !external || external.status !== 'succeeded' || external.paymentId !== payment.id
        || await recorded(tx, 'billing.refund.release_corrected', released.id)) return;
      await audit(tx, system(gymId), clock, 'billing.refund.release_corrected', 'refund', released.id, { processorId: value.id });
      await effect(tx, system(gymId), clock, { kind: 'staff_notice', notice: 'refund_arrived', invoiceId: payment.invoiceId,
        paymentId: payment.id, refundId: external.id });
    });
    return true;
  }
  /** Records a dispute's current status on its payment's invoice, under the invoice lock. Only the dispute ID and
   * status change, with an audit; final statuses never reopen. Another dispute on the invoice needs staff resolution.
   * A dispute newly attached to its invoice publishes the owner's alert, whose permanent key sends it once; later status
   * changes don't. The alert never fails the recorded write: the hourly dispute scan recovers one that couldn't be queued. */
  async function dispute(gymId: string, payment: Payment, value: Dispute): Promise<'recorded' | 'unchanged' | 'conflict'> {
    let attached = false;
    const result = await scope(gymId, async tx => {
      // A switch from test to live holds the gym row for its whole save and closes the open disputes of the card payments
      // it marks as test: waiting for it first means it either sees this dispute or has marked the payment, whose dispute
      // is then in the test account and isn't recorded (the live key could never read or answer it).
      await stripeWriteCurrent(tx, gymId);
      const invoice = await lockInvoice(tx, payment.invoiceId);
      const [current] = await tx.select({ method: payments.method, reference: payments.reference }).from(payments).where(eq(payments.id, payment.id));
      if ((current?.method === 'card' || current?.method === 'bank_debit') && current.reference === stripeTestPaymentReference) return 'unchanged' as const;
      if (invoice.disputeId && invoice.disputeId !== value.id) return 'conflict' as const;
      if (invoice.disputeId === value.id && (invoice.disputeStatus === value.status || isTerminalDispute(invoice.disputeStatus)))
        return 'unchanged' as const;
      const after = { disputeId: value.id, disputeStatus: value.status };
      await tx.update(invoices).set(after).where(eq(invoices.id, invoice.id));
      // The disputed payment is recorded with the dispute: restore skips one on a payment a switch to live marked as test.
      await audit(tx, system(gymId), clock, 'billing.invoice.disputed', 'invoice', invoice.id, { ...after, paymentId: payment.id },
        { disputeId: invoice.disputeId, disputeStatus: invoice.disputeStatus });
      attached = invoice.disputeId === null;
      return 'recorded' as const;
    });
    if (attached) {
      try { await options.disputeAlerts?.publishDispute(gymId, payment.invoiceId, value.id); }
      catch (error) { logError('billing.dispute.alert_publish_failed', { gymId, invoiceId: payment.invoiceId }, error); }
    }
    return result;
  }
  return { recordedPayment, parentPayment, refund, dispute };
}
export type DisputeRefundWriter = ReturnType<typeof createDisputeRefundWriter>;
