// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { forGym, households, invoices, members, paymentAttempts, paymentMethods, signedLinks, writeAudit } from '@plaingym/db';
import type { Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { Payments, CheckoutSession } from '../../infra/payments/index.js';
import { clock as defaultClock } from '../../core/clock.js';
import { signedLinkWaiversComplete } from '../waivers/waivers.js';

function missing(): never { throw new AppError('not_found', 'Signed link or resource not found'); }
function unavailable(): never { throw new AppError('unavailable', 'Checkout is not available'); }
export class CustomerNotLinked extends AppError {
  constructor() { super('unavailable', 'Card setup is not available yet'); }
}
export interface SignedCheckoutOptions {
  scope?: typeof forGym;
  clock?: Clock;
  paymentsFor(gymId: string): Promise<Payments>;
  /** Trusted configured origin, never the request Host. */
  originFor(gymId: string): Promise<string>;
}
export function createSignedLinkCheckout(options: SignedCheckoutOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  async function locked(tx: Transaction, gymId: string, linkId: string) {
    const [link] = await tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)).for('update');
    if (!link || link.gymId !== gymId || link.revokedAt || link.usedAt || link.expiresAt <= clock.now()
      || !['pay_invoice', 'update_card', 'onboarding'].includes(link.purpose)) missing();
    const [household] = await tx.select().from(households).where(eq(households.id, link.householdId));
    if (!household) missing();
    return { link, household };
  }
  const audit = (tx: Transaction, gymId: string, action: string, id: string) => writeAudit(tx, {
    gymId, actorKind: 'system', action, targetType: 'signed_link', targetId: id,
    before: null, after: null, occurredAt: clock.now(),
  });
  async function payable(tx: Transaction, invoice: typeof invoices.$inferSelect) {
    const [pending] = await tx.select({ id: paymentAttempts.id }).from(paymentAttempts)
      .where(and(eq(paymentAttempts.invoiceId, invoice.id), eq(paymentAttempts.status, 'pending'))).limit(1);
    if (!['open', 'past_due'].includes(invoice.status) || invoice.amountCents <= 0 || invoice.needsReview || pending)
      throw new AppError('conflict', 'Invoice cannot be paid');
  }
  async function start(gymId: string, linkId: string, renewed = false): Promise<{ session: CheckoutSession; expiresAt: string }> {
    const origin = new URL(await options.originFor(gymId));
    if (origin.protocol !== 'https:' || origin.username || origin.password) unavailable();
    const returnUrl = new URL('/l/return', origin).href;
    const prepared = await scope(gymId, async tx => {
      const { link, household } = await locked(tx, gymId, linkId);
      if (!household.stripeCustomerId) throw new CustomerNotLinked();
      if (link.purpose !== 'pay_invoice') return { link, customerId: household.stripeCustomerId, invoice: null };
      const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, link.invoiceId!), eq(invoices.householdId, link.householdId))).for('update');
      if (!invoice) missing();
      await payable(tx, invoice);
      // Reserve before the provider call. A lost response retries the exact key/parameters,
      // only inside the provider's 24-hour idempotency window. Never blindly retry later.
      if (!invoice.checkoutSessionId && (!invoice.checkoutExpiresAt || invoice.checkoutExpiresAt <= clock.now())) {
        // With no stored ID, no URL was exposed: successful responses are persisted before
        // returning, or expired on failed adoption. Renew under the invoice lock with a new
        // key; never reuse the old key outside its retention window.
        const replacing = !!invoice.checkoutExpiresAt;
        invoice.checkoutExpiresAt = new Date(clock.now().getTime() + 23 * 60 * 60 * 1000);
        await tx.update(invoices).set({ checkoutExpiresAt: invoice.checkoutExpiresAt }).where(eq(invoices.id, invoice.id));
        await audit(tx, gymId, replacing ? 'billing.checkout.reservation_renewed' : 'billing.checkout.reserved', linkId);
      }
      return { link, customerId: household.stripeCustomerId, invoice };
    });
    const provider = await options.paymentsFor(gymId);
    let session: CheckoutSession;
    if (prepared.invoice?.checkoutSessionId) {
      const found = await provider.readPaymentObject({ kind: 'checkout', id: prepared.invoice.checkoutSessionId });
      if (found.status !== 'found' || found.value.kind !== 'checkout') unavailable();
      session = found.value.object;
      // Only a provider-confirmed expiry permits replacement. Unknown or completed sessions
      // retain their stored ID for reconciliation and delayed webhook delivery.
      if (session.status === 'expired' && !renewed) {
        await scope(gymId, async tx => {
          const { link } = await locked(tx, gymId, linkId);
          const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, prepared.invoice!.id), eq(invoices.householdId, link.householdId))).for('update');
          if (!invoice || invoice.checkoutSessionId !== session.id) throw new AppError('conflict', 'Invoice changed');
          await payable(tx, invoice);
          await tx.update(invoices).set({ checkoutSessionId: null,
            checkoutExpiresAt: new Date(Math.max(clock.now().getTime() + 23 * 60 * 60 * 1000, (invoice.checkoutExpiresAt?.getTime() ?? 0) + 1)),
          }).where(eq(invoices.id, invoice.id));
          await audit(tx, gymId, 'billing.checkout.expired', linkId);
        });
        return start(gymId, linkId, true);
      }
      if (session.status !== 'open') throw new AppError('conflict', 'Checkout is no longer open');
    } else {
      const invoice = prepared.invoice;
      session = await provider.createCheckout({
        mode: invoice ? 'payment' : 'setup', customerId: prepared.customerId,
        ...(invoice ? { invoiceId: invoice.id, amount: invoice.amountCents, currency: invoice.currency.toLowerCase() } : {}),
        successUrl: returnUrl, cancelUrl: returnUrl, saveForOffSession: !invoice,
        idempotencyKey: invoice ? `invoice:${invoice.id}:checkout:${invoice.checkoutExpiresAt!.toISOString()}` : `signed-link:${linkId}:setup`,
      });
    }
    if (session.metadata.gymId !== gymId || session.customerId !== prepared.customerId
      || session.mode !== (prepared.invoice ? 'payment' : 'setup')
      || (prepared.invoice && session.metadata.invoiceId !== prepared.invoice.id)) unavailable();
    try {
      await scope(gymId, async tx => {
        const { link, household } = await locked(tx, gymId, linkId);
        if (household.stripeCustomerId !== prepared.customerId) missing();
        if (prepared.invoice) {
          const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, prepared.invoice.id), eq(invoices.householdId, link.householdId))).for('update');
          if (!invoice || !['open', 'past_due'].includes(invoice.status)
            || invoice.checkoutExpiresAt?.getTime() !== prepared.invoice.checkoutExpiresAt?.getTime()
            || (invoice.checkoutSessionId && invoice.checkoutSessionId !== session.id)) throw new AppError('conflict', 'Invoice changed');
          await payable(tx, invoice);
          if (!invoice.checkoutSessionId) {
            await tx.update(invoices).set({ checkoutSessionId: session.id }).where(eq(invoices.id, invoice.id));
            await audit(tx, gymId, 'billing.checkout.started', linkId);
          }
        } else await audit(tx, gymId, 'billing.card_setup.started', linkId);
      });
    } catch (error) {
      await provider.expireCheckout(session.id).catch(() => undefined);
      throw error;
    }
    return { session, expiresAt: new Date(Math.min(prepared.link.expiresAt.getTime(),
      prepared.invoice?.checkoutExpiresAt?.getTime() ?? clock.now().getTime() + 23 * 60 * 60 * 1000)).toISOString() };
  }
  /** sessionId is taken only from the server-authenticated browser receipt.
   * Stripe completion alone is insufficient: wait for the existing webhook handler's writes. */
  async function complete(gymId: string, linkId: string, sessionId: string | null) {
    let session: CheckoutSession | null = null;
    if (sessionId) {
      const provider = await options.paymentsFor(gymId);
      const found = await provider.readPaymentObject({ kind: 'checkout', id: sessionId });
      if (found.status === 'found' && found.value.kind === 'checkout') session = found.value.object;
    }
    return scope(gymId, async tx => {
      const { link, household } = await locked(tx, gymId, linkId);
      if (link.purpose === 'pay_invoice') {
        const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, link.invoiceId!), eq(invoices.householdId, link.householdId)));
        if (!invoice) missing();
        if (!['paid', 'partially_refunded', 'refunded'].includes(invoice.status)) return false;
      } else {
        if (!session || session.status !== 'complete' || session.mode !== 'setup' || session.metadata.gymId !== gymId
          || session.customerId !== household.stripeCustomerId || !session.paymentMethodId) return false;
        const [card] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.householdId, link.householdId),
          eq(paymentMethods.processorId, session.paymentMethodId), isNull(paymentMethods.revokedAt)));
        if (!card) return false;
        if (link.purpose === 'onboarding') {
          const people = await tx.select({ id: members.id }).from(members).where(and(eq(members.householdId, link.householdId), isNull(members.anonymizedAt)));
          if (!await signedLinkWaiversComplete(tx, people.map(m => m.id))) return false;
        }
      }
      await tx.update(signedLinks).set({ usedAt: clock.now() }).where(eq(signedLinks.id, linkId));
      await audit(tx, gymId, 'signed_link.used', linkId);
      return true;
    });
  }
  return { start, complete };
}
