// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { auditEvents, forGym, households, invoices, members, paymentAttempts, paymentMethods, signedLinks, writeAudit } from '@plaingym/db';
import type { Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { Payments, CheckoutSession } from '../../infra/payments/index.js';
import { clock as defaultClock } from '../../core/clock.js';
import { describeError } from '../../core/log.js';
import { signedLinkWaiversComplete } from '../waivers/waivers.js';
import { createCustomersService, CustomerUnavailable } from './customers.js';
import { isAssignmentInvoice } from './assignment-invoices.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createCardHandlers } from './webhooks/handlers/methods.js';

function missing(): never { throw new AppError('not_found', 'Signed link or resource not found'); }
function unavailable(): never { throw new AppError('unavailable', 'Checkout is not available'); }
export class CustomerNotLinked extends AppError {
  constructor(cause?: unknown) { super('unavailable', 'Card setup is not available yet'); this.cause = cause; }
}
export interface SignedCheckoutOptions {
  scope?: typeof forGym;
  clock?: Clock;
  paymentsFor(gymId: string): Promise<Payments>;
  log?: (line: string) => void;
  /** Trusted configured origin, never the request Host. */
  originFor(gymId: string): Promise<string>;
}
export function createSignedLinkCheckout(options: SignedCheckoutOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const log = options.log ?? console.error;
  const customers = createCustomersService({ scope, clock, paymentsFor: options.paymentsFor });
  const settings = createGymSettingsAccessor({ scope, clock });
  const cards = createCardHandlers({ scope, clock });
  async function checkBilling(gymId: string, payment: boolean) {
    if (payment && !(await settings.get(gymId)).billingEnabled) unavailable();
  }
  async function locked(tx: Transaction, gymId: string, linkId: string, completing = false) {
    const [link] = await tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)).for('update');
    if (!link || link.gymId !== gymId || link.revokedAt || (!completing && link.usedAt) || link.expiresAt <= clock.now()
      || !['pay_invoice', 'update_card', 'onboarding'].includes(link.purpose)) missing();
    const [household] = await tx.select().from(households).where(eq(households.id, link.householdId));
    if (!household) missing();
    return { link, household };
  }
  const audit = (tx: Transaction, gymId: string, action: string, id: string, after: { sessionId: string } | null = null) => writeAudit(tx, {
    gymId, actorKind: 'system', action, targetType: 'signed_link', targetId: id,
    before: null, after, occurredAt: clock.now(),
  });
  async function setupStart(tx: Transaction, linkId: string) {
    const [row] = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
      eq(auditEvents.targetType, 'signed_link'), eq(auditEvents.targetId, linkId),
      eq(auditEvents.action, 'billing.card_setup.started'))).orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
    return row?.after && typeof row.after === 'object' && 'sessionId' in row.after && typeof row.after.sessionId === 'string'
      ? row.after.sessionId : null;
  }
  function ownedSetup(session: CheckoutSession, gymId: string, linkId: string, customerId: string) {
    if (session.metadata.gymId !== gymId || session.metadata.linkId !== linkId || session.customerId !== customerId
      || session.mode !== 'setup' || !session.savesCard) unavailable();
  }
  /** A browser return can repair a missed webhook using the same idempotent card writer.
   * Neither the return flag nor an arbitrary processor ID authorizes collecting a card. */
  async function recoverCard(gymId: string, linkId: string, session: CheckoutSession, provider: Payments) {
    if (session.status !== 'complete' || session.mode !== 'setup' || !session.metadata.linkId) return;
    const allowed = await scope(gymId, async tx => {
      const { link, household } = await locked(tx, gymId, linkId, true);
      if (link.purpose === 'pay_invoice' || link.usedAt) return false;
      if (session.metadata.gymId !== gymId || session.metadata.linkId !== linkId || session.customerId !== household.stripeCustomerId
        || session.mode !== 'setup' || !session.savesCard) return false;
      const [recorded] = await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(and(
        eq(paymentMethods.householdId, household.id), eq(paymentMethods.processorId, session.paymentMethodId ?? '')));
      if (recorded) return false; // Includes staff-revoked cards, which must never be re-enabled.
      const starts = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
        eq(auditEvents.targetType, 'signed_link'), eq(auditEvents.targetId, linkId), eq(auditEvents.action, 'billing.card_setup.started')));
      return starts.some(({ after }) => after && typeof after === 'object' && 'sessionId' in after && after.sessionId === session.id);
    });
    if (!allowed) return;
    if (!session.setupId || !session.paymentMethodId) unavailable();
    const result = await provider.readPaymentObject({ kind: 'setup', id: session.setupId });
    if (result.status !== 'found' || result.value.kind !== 'setup') unavailable();
    const setup = result.value.object;
    if (setup.status !== 'succeeded' || setup.metadata.gymId !== gymId || setup.metadata.linkId !== linkId
      || setup.customerId !== session.customerId || setup.paymentMethodId !== session.paymentMethodId) unavailable();
    await cards.collect(gymId, provider, session.customerId, session.paymentMethodId);
  }
  async function startCard(gymId: string, linkId: string, customerId: string, provider: Payments, returnUrl: string) {
    // The persisted start association also supplies the next attempt's stable key. Concurrent
    // clicks and lost creation responses retry one attempt; terminal sessions advance the key.
    for (let attempt = 0; attempt < 3; attempt++) {
      const prepared = await scope(gymId, async tx => {
        const { link, household } = await locked(tx, gymId, linkId);
        if (household.stripeCustomerId !== customerId) missing();
        return { link, sessionId: await setupStart(tx, linkId) };
      });
      if (prepared.sessionId) {
        const found = await provider.readPaymentObject({ kind: 'checkout', id: prepared.sessionId });
        if (found.status !== 'found' || found.value.kind !== 'checkout') unavailable();
        const session = found.value.object;
        ownedSetup(session, gymId, linkId, customerId);
        if (session.status === 'open') {
          if (!session.url) unavailable();
          await scope(gymId, async tx => {
            const { household } = await locked(tx, gymId, linkId);
            if (household.stripeCustomerId !== customerId || await setupStart(tx, linkId) !== session.id)
              throw new AppError('conflict', 'Card setup changed');
          });
          return { session, expiresAt: new Date(Math.min(prepared.link.expiresAt.getTime(), clock.now().getTime() + 23 * 60 * 60 * 1000)).toISOString() };
        }
        await recoverCard(gymId, linkId, session, provider);
      }
      const session = await provider.createCheckout({ mode: 'setup', customerId, linkId, successUrl: returnUrl,
        cancelUrl: returnUrl, saveForOffSession: true,
        idempotencyKey: `signed-link:${linkId}:setup` + (prepared.sessionId ? `:after:${prepared.sessionId}` : '') });
      ownedSetup(session, gymId, linkId, customerId);
      await scope(gymId, async tx => {
        const { household } = await locked(tx, gymId, linkId);
        if (household.stripeCustomerId !== customerId) missing();
        const current = await setupStart(tx, linkId);
        if (current === session.id) return;
        if (current !== prepared.sessionId) throw new AppError('conflict', 'Card setup changed');
        await audit(tx, gymId, 'billing.card_setup.started', linkId, { sessionId: session.id });
      });
      // A POST retry can contain Stripe's original open response after expiry/completion.
      // Retrieve the persisted session on the next iteration before exposing its URL.
    }
    return unavailable();
  }
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
    const billingEnabled = (await settings.get(gymId)).billingEnabled;
    const prepared = await scope(gymId, async tx => {
      const { link, household } = await locked(tx, gymId, linkId);
      if (link.purpose !== 'pay_invoice') return { link, customerId: household.stripeCustomerId, invoice: null, savesCard: true };
      if (!billingEnabled) unavailable();
      const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, link.invoiceId!), eq(invoices.householdId, link.householdId))).for('update');
      if (!invoice) missing();
      await payable(tx, invoice);
      const savesCard = invoice.kind === 'cycle' || await isAssignmentInvoice(tx, invoice.id);
      const replaying = !invoice.checkoutSessionId && !!invoice.checkoutExpiresAt && invoice.checkoutExpiresAt > clock.now();
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
      const [reservation] = !invoice.checkoutSessionId ? await tx.select({ linkId: auditEvents.targetId }).from(auditEvents)
        .innerJoin(signedLinks, eq(signedLinks.id, auditEvents.targetId)).where(and(
          eq(auditEvents.targetType, 'signed_link'), eq(signedLinks.invoiceId, invoice.id),
          eq(signedLinks.householdId, link.householdId),
          inArray(auditEvents.action, ['billing.checkout.reserved', 'billing.checkout.reservation_renewed'])))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1) : [];
      return { link, customerId: household.stripeCustomerId, invoice, savesCard, reservationLinkId: reservation?.linkId, replaying };
    });
    await checkBilling(gymId, !!prepared.invoice);
    let customerId: string, provider: Payments;
    try {
      customerId = prepared.customerId ?? await customers.ensureCustomer(gymId, prepared.link.householdId);
      try { provider = await options.paymentsFor(gymId); }
      catch (error) { throw new CustomerUnavailable('stripe_not_configured', error); }
    } catch (error) {
      if (error instanceof AppError && error.code === 'not_found') throw error;
      log(JSON.stringify({ event: 'billing.customer.unavailable', gymId, householdId: prepared.link.householdId,
        purpose: prepared.link.purpose, reason: error instanceof CustomerUnavailable ? error.reason : error instanceof Error ? error.name : typeof error,
        error: describeError(error) }));
      throw new CustomerNotLinked(error);
    }
    let session: CheckoutSession;
    await checkBilling(gymId, !!prepared.invoice);
    if (!prepared.invoice) return startCard(gymId, linkId, customerId, provider, returnUrl);
    if (prepared.invoice.checkoutSessionId) {
      const found = await provider.readPaymentObject({ kind: 'checkout', id: prepared.invoice.checkoutSessionId });
      if (found.status !== 'found' || found.value.kind !== 'checkout') unavailable();
      session = found.value.object;
      if (session.status === 'open' && session.metadata.linkId && session.metadata.linkId !== linkId && !renewed) {
        if (session.metadata.gymId !== gymId || session.customerId !== customerId || session.mode !== 'payment'
          || session.metadata.invoiceId !== prepared.invoice.id || session.savesCard !== prepared.savesCard) unavailable();
        // Another link may take over only after provider-confirmed expiry. Payment can win
        // the expire race; re-read and keep the completed session for reconciliation.
        await provider.expireCheckout(session.id);
        const refreshed = await provider.readPaymentObject({ kind: 'checkout', id: session.id });
        if (refreshed.status !== 'found' || refreshed.value.kind !== 'checkout') unavailable();
        session = refreshed.value.object;
      }
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
          await audit(tx, gymId, 'billing.checkout.reservation_renewed', linkId);
        });
        return start(gymId, linkId, true);
      }
      if (session.status !== 'open') throw new AppError('conflict', 'Checkout is no longer open');
    } else {
      const invoice = prepared.invoice;
      session = await provider.createCheckout({
        mode: 'payment', customerId, linkId: prepared.reservationLinkId ?? linkId,
        invoiceId: invoice.id, amount: invoice.amountCents, currency: invoice.currency.toLowerCase(),
        successUrl: returnUrl, cancelUrl: returnUrl, saveForOffSession: prepared.savesCard,
        idempotencyKey: `invoice:${invoice.id}:checkout:${invoice.checkoutExpiresAt!.toISOString()}`,
      });
    }
    const sessionLinkId = prepared.invoice?.checkoutSessionId ? linkId : prepared.reservationLinkId ?? linkId;
    if (session.metadata.gymId !== gymId || (session.metadata.linkId && session.metadata.linkId !== sessionLinkId) || session.customerId !== customerId
      || session.mode !== 'payment' || session.savesCard !== prepared.savesCard || session.metadata.invoiceId !== prepared.invoice.id) unavailable();
    try {
      await checkBilling(gymId, !!prepared.invoice);
      await scope(gymId, async tx => {
        const { link, household } = await locked(tx, gymId, linkId);
        if (household.stripeCustomerId !== customerId) missing();
        if (prepared.invoice) {
          const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, prepared.invoice.id), eq(invoices.householdId, link.householdId))).for('update');
          if (!invoice || !['open', 'past_due'].includes(invoice.status)
            || invoice.checkoutExpiresAt?.getTime() !== prepared.invoice.checkoutExpiresAt?.getTime()
            || (invoice.checkoutSessionId && invoice.checkoutSessionId !== session.id)) throw new AppError('conflict', 'Invoice changed');
          await payable(tx, invoice);
          if (!invoice.checkoutSessionId) {
            await tx.update(invoices).set({ checkoutSessionId: session.id }).where(eq(invoices.id, invoice.id));
            await audit(tx, gymId, 'billing.checkout.started', sessionLinkId, { sessionId: session.id });
          }
        }
      });
    } catch (error) {
      await provider.expireCheckout(session.id).catch(() => undefined);
      throw error;
    }
    // Persist the replayed session before handing it over. The existing path confirms
    // expiry before renewing the invoice-wide key, and retains completed sessions.
    if (sessionLinkId !== linkId || session.status === 'expired' || prepared.replaying) return start(gymId, linkId, renewed);
    if (session.status !== 'open') throw new AppError('conflict', 'Checkout is no longer open');
    return { session, expiresAt: new Date(Math.min(prepared.link.expiresAt.getTime(),
      prepared.invoice?.checkoutExpiresAt?.getTime() ?? clock.now().getTime() + 23 * 60 * 60 * 1000)).toISOString() };
  }
  /** Called by an authenticated browser receipt or the webhook's persisted link/session association. */
  async function complete(gymId: string, linkId: string, sessionId: string | null) {
    let session: CheckoutSession | null = null;
    if (sessionId) {
      const provider = await options.paymentsFor(gymId);
      const found = await provider.readPaymentObject({ kind: 'checkout', id: sessionId });
      if (found.status === 'found' && found.value.kind === 'checkout') session = found.value.object;
      if (session?.metadata.gymId === gymId && session.metadata.linkId === linkId)
        await recoverCard(gymId, linkId, session, provider);
    }
    return scope(gymId, async tx => {
      const { link, household } = await locked(tx, gymId, linkId, true);
      if (link.usedAt) return true;
      if (!session) return false;
      const tagged = session.metadata.linkId !== undefined;
      if (tagged) {
        if (session.status !== 'complete' || session.metadata.gymId !== gymId
          || session.metadata.linkId !== linkId || session.customerId !== household.stripeCustomerId) return false;
        const starts = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
          eq(auditEvents.gymId, gymId), eq(auditEvents.targetType, 'signed_link'), eq(auditEvents.targetId, linkId),
          eq(auditEvents.action, link.purpose === 'pay_invoice' ? 'billing.checkout.started' : 'billing.card_setup.started')));
        if (!starts.some(({ after }) => after !== null && typeof after === 'object'
          && 'sessionId' in after && after.sessionId === session.id)) return false;
      }
      // Untagged Checkouts retain the browser-return checks used when they were issued.
      if (link.purpose === 'pay_invoice') {
        const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, link.invoiceId!), eq(invoices.householdId, link.householdId)));
        if (!invoice) missing();
        if (tagged && (session.mode !== 'payment' || session.metadata.invoiceId !== invoice.id || invoice.checkoutSessionId !== session.id)) return false;
        if (!['paid', 'partially_refunded', 'refunded'].includes(invoice.status)) return false;
      } else {
        if (session.status !== 'complete' || session.mode !== 'setup' || session.metadata.gymId !== gymId
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
