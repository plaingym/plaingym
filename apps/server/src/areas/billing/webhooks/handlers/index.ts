// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, or } from 'drizzle-orm';
import { forGym, households, invoices, paymentAttempts, payments, refunds, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as defaultClock } from '../../../../core/clock.js';
import type { InvoiceTransitions } from '../../../../core/interfaces/invoice-transitions.js';
import type { ChargeOutcome, Payments, PaymentObjectReference, Refund } from '../../../../infra/payments/index.js';
import type { WebhookHandler, WebhookInbox } from '../inbox.js';
import { applyChargeOutcome } from '../../transitions/outcomes.js';
import { audit, lockInvoice } from '../../transitions/store.js';
import { createCardHandlers } from './methods.js';
import { processorRefundId } from './identity.js';

export const billingWebhookTypes = [
  'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.requires_action',
  'checkout.session.completed', 'setup_intent.succeeded', 'payment_method.updated', 'payment_method.automatically_updated',
  'charge.refunded', 'refund.created', 'refund.updated', 'refund.failed',
  'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed',
] as const;
export interface HandlerOptions {
  transitions: InvoiceTransitions;
  scope?: typeof forGym;
  clock?: Clock;
}
export async function readCurrent(provider: Payments, reference: PaymentObjectReference) {
  if (reference.kind === 'charge') return { kind: 'charge' as const,
    object: await provider.findCharge({ kind: 'charge', id: reference.id }, { includeSuccessTime: true }) };
  const result = await provider.readPaymentObject(reference);
  if (result.status !== 'found' || result.value.kind !== reference.kind)
    throw new Error('Webhook payment object is unresolved');
  return result.value;
}
function successTime(outcome: Extract<ChargeOutcome, { status: 'succeeded' }>): string {
  if (!outcome.succeededAt || !Number.isFinite(outcome.succeededAt.getTime())) throw new Error('Payment success time is unresolved');
  return outcome.succeededAt.toISOString();
}
/** Current objects only; a missing dependency stays retryable in the inbox. */
export function registerBillingWebhookHandlers(inbox: Pick<WebhookInbox, 'register'>, options: HandlerOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const system = (gymId: string) => ({ gymId, actor: { kind: 'system' as const } });
  const cards = createCardHandlers({ scope, clock });
  async function match(gymId: string, outcome: ChargeOutcome) {
    if (outcome.status === 'unknown') throw new Error('Webhook PaymentIntent is unresolved');
    if (outcome.metadata.gymId !== gymId) throw new Error('Webhook payment gym mismatch');
    return scope(gymId, async tx => {
      const attempt = (await tx.select().from(paymentAttempts).where(eq(paymentAttempts.paymentIntentId, outcome.id)))[0];
      const payment = (await tx.select().from(payments).where(or(eq(payments.paymentIntentId, outcome.id),
        ...(outcome.latestChargeId ? [eq(payments.chargeId, outcome.latestChargeId)] : []))))[0];
      const ids = new Set([outcome.metadata.invoiceId, attempt?.invoiceId, payment?.invoiceId].filter(Boolean));
      if (ids.size !== 1) throw new Error('Webhook invoice is unmatched or ambiguous');
      const invoice = (await tx.select().from(invoices).where(eq(invoices.id, [...ids][0]!)))[0];
      if (!invoice) throw new Error('Webhook invoice is unresolved');
      const household = (await tx.select().from(households).where(eq(households.id, invoice.householdId)))[0];
      if (!household || household.stripeCustomerId !== outcome.customerId)
        throw new Error('Webhook payment customer mismatch');
      if (outcome.metadata.attemptId && outcome.metadata.attemptId !== attempt?.id)
        throw new Error('Webhook attempt is unresolved');
      return { invoice, attempt, payment };
    });
  }
  async function applyIntent(gymId: string, outcome: ChargeOutcome) {
    const matched = await match(gymId, outcome);
    if (outcome.status === 'unknown') throw new Error('Webhook PaymentIntent is unresolved');
    // Checkout failures have no runner attempt and must not start dunning.
    if (!matched.attempt && outcome.status !== 'succeeded') return;
    await applyChargeOutcome(options.transitions, system(gymId), {
      invoiceId: matched.invoice.id, paymentId: matched.payment?.id ?? uuidv7(),
      ...(matched.attempt ? { attemptId: matched.attempt.id } : {}),
      paidAt: outcome.status === 'succeeded' ? successTime(outcome) : clock.now().toISOString(),
    }, { ...outcome, metadata: { ...outcome.metadata, invoiceId: matched.invoice.id } });
  }
  async function applyRefund(gymId: string, provider: Payments, refund: Refund) {
    // The adapter's chargeId on refunds/disputes is their parent PaymentIntent, including dashboard refunds.
    const outcome = await provider.findCharge({ kind: 'charge', id: refund.chargeId }, { includeSuccessTime: true });
    let matched = await match(gymId, outcome);
    if (!matched.payment) {
      // Refund may arrive before the success webhook, or after restoring an earlier snapshot.
      if (outcome.status !== 'succeeded') throw new Error('Refund payment is unresolved');
      await applyIntent(gymId, outcome);
      matched = await match(gymId, outcome);
    }
    const payment = matched.payment;
    if (!payment) throw new Error('Refund payment is unresolved');
    const refundId = await scope(gymId, async tx => {
      const existing = (await tx.select().from(refunds).where(eq(refunds.processorId, refund.id)))[0];
      if (existing) return existing.id;
      // The duplicate-payment worker reserves a refund before calling the processor.
      const reservations = await tx.select().from(refunds).where(and(eq(refunds.paymentId, payment.id),
        isNull(refunds.processorId), eq(refunds.status, 'pending')));
      if (reservations.length) {
        if (reservations.length !== 1 || reservations[0]!.amountCents !== refund.amount
          || reservations[0]!.currency !== refund.currency.toUpperCase()) throw new Error('Refund reservation is ambiguous');
        return reservations[0]!.id;
      }
      return processorRefundId(gymId, refund.id);
    });
    await options.transitions.refund(system(gymId), { invoiceId: matched.invoice.id, paymentId: payment.id,
      refundId, processorId: refund.id, amountCents: refund.amount,
      currency: refund.currency.toUpperCase() as 'USD' | 'CAD', status: refund.status });
  }
  const handle: WebhookHandler = async (event, context) => {
    const { gymId, payments: provider } = context;
    if (event.gymId !== gymId) throw new Error('Webhook gym mismatch');
    const expected = event.type.startsWith('payment_intent.') || event.type === 'charge.refunded' ? 'charge'
      : event.type.startsWith('charge.dispute.') ? 'dispute'
      : event.type.startsWith('refund.') ? 'refund'
      : event.type === 'checkout.session.completed' ? 'checkout'
      : event.type === 'setup_intent.succeeded' ? 'setup' : 'payment_method';
    if (event.objectKind !== expected) throw new Error('Webhook object kind mismatch');
    const current = await readCurrent(provider, { kind: expected, id: event.objectId });
    if (event.type === 'charge.refunded') {
      if (current.kind !== 'charge') throw new Error('Expected PaymentIntent');
      await match(gymId, current.object);
      const listed = await provider.listRefunds(event.objectId);
      if (!listed.length) throw new Error('Refunded charge has no resolved refunds');
      for (const id of new Set(listed.map(refund => refund.id))) {
        const refreshed = await readCurrent(provider, { kind: 'refund', id });
        if (refreshed.kind !== 'refund' || refreshed.object.chargeId !== event.objectId) throw new Error('Refund parent mismatch');
        await applyRefund(gymId, provider, refreshed.object);
      }
    } else if (current.kind === 'charge') await applyIntent(gymId, current.object);
    else if (current.kind === 'refund') await applyRefund(gymId, provider, current.object);
    else if (current.kind === 'dispute') {
      const dispute = current.object;
      const outcome = await provider.findCharge({ kind: 'charge', id: dispute.chargeId });
      const { invoice } = await match(gymId, outcome);
      await scope(gymId, async tx => {
        const locked = await lockInvoice(tx, invoice.id);
        if (locked.disputeId && locked.disputeId !== dispute.id) throw new Error('Invoice has another dispute; staff resolution required');
        if (locked.disputeId === dispute.id && (locked.disputeStatus === dispute.status
          || ['won', 'lost', 'closed'].includes(locked.disputeStatus ?? ''))) return;
        const after = { disputeId: dispute.id, disputeStatus: dispute.status };
        await tx.update(invoices).set(after).where(eq(invoices.id, invoice.id));
        await audit(tx, system(gymId), clock, 'billing.invoice.disputed', 'invoice', invoice.id, after,
          { disputeId: locked.disputeId, disputeStatus: locked.disputeStatus });
      });
    } else if (current.kind === 'checkout') {
      const session = current.object;
      if (session.status !== 'complete') return;
      if (session.metadata.gymId !== gymId) throw new Error('Checkout gym mismatch');
      if (session.mode === 'payment') {
        const outcome = await provider.findCharge({ kind: 'checkout', id: session.id }, { includeSuccessTime: true });
        const { invoice, payment } = await match(gymId, outcome);
        if (session.metadata.invoiceId !== invoice.id || session.customerId !== (outcome.status === 'unknown' ? '' : outcome.customerId)
          || (invoice.checkoutSessionId && invoice.checkoutSessionId !== session.id)) throw new Error('Checkout invoice mismatch');
        if (outcome.status !== 'succeeded' || !outcome.latestChargeId) throw new Error('Completed Checkout payment is unresolved');
        await options.transitions.cardSucceeded(system(gymId), { invoiceId: invoice.id, paymentId: payment?.id ?? uuidv7(),
          paymentIntentId: outcome.id, chargeId: outcome.latestChargeId, amountCents: outcome.amount,
          currency: outcome.currency.toUpperCase() as 'USD' | 'CAD', paidAt: successTime(outcome) });
        if (session.savesCard) {
          if (!session.paymentMethodId) throw new Error('Collected payment method is unresolved');
          await cards.collect(gymId, provider, session.customerId, session.paymentMethodId);
        }
      } else {
        if (!session.setupId) throw new Error('Completed Checkout setup is unresolved');
        await cards.setup(gymId, provider, session.setupId);
      }
    } else if (current.kind === 'setup') await cards.setup(gymId, provider, current.object.id);
    else if (current.kind === 'payment_method') await cards.update(gymId, current.object);
  };
  for (const type of billingWebhookTypes) inbox.register(type, handle);
}
