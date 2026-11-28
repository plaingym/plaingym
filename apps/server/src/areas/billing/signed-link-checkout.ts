// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { auditEvents, forGym, households, invoices, members, paymentAttempts, paymentMethods, signedLinks, uuidv7, writeAudit } from '@plaingym/db';
import type { Transaction } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { cardChargeIssue } from '@plaingym/shared/money';
import { BankDebitUnavailable, type Payments, type CheckoutSession, type CheckoutRequest } from '../../infra/payments/index.js';
import { locales } from '@plaingym/shared/locales';
import { clock as defaultClock } from '../../core/clock.js';
import { logError } from '../../core/log.js';
import { signedLinkWaiversComplete } from '../waivers/waivers.js';
import { createCustomersService, customerUnlinkedAction, CustomerUnavailable } from './customers.js';
import { isAssignmentInvoice } from './assignment-invoices.js';
import { readGymSettings } from '../settings/settings.js';
import { createCardHandlers } from './webhooks/handlers/methods.js';
import { completeCampaignIn } from '../links/campaigns.model.js';
import { defaultRefusal } from './payments.mutations.js';
import { localDate } from '@plaingym/shared/time';

const t = createTranslator(locales.en ?? {});
function bankDebitFor(gym: { bankDebitsEnabled: boolean; currency: string }): CheckoutRequest['bankDebit'] {
  if (gym.bankDebitsEnabled && gym.currency === 'USD') return { type: 'us_bank_account' };
  if (gym.bankDebitsEnabled && gym.currency === 'CAD') return { type: 'acss_debit', intervalDescription: t('billing/payments:padInterval') };
  return undefined;
}
/**
 * The household's default payment method, share-locked, when it can still be charged: a card not expired in the gym's
 * time zone (or with no expiry on record), or a bank debit of the gym currency's kind (a Canadian PAD only with a mandate).
 */
async function usableDefaultMethod(tx: Transaction, gymId: string, householdId: string, now: Date) {
  const [method] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.gymId, gymId),
    eq(paymentMethods.householdId, householdId), eq(paymentMethods.isDefault, true), isNull(paymentMethods.revokedAt))).for('share');
  if (!method) return null;
  const gym = await readGymSettings(tx, gymId);
  if (method.type === 'card') {
    if (method.expiryYear === null || method.expiryMonth === null) return method;
    const expiry = `${String(method.expiryYear).padStart(4, '0')}-${String(method.expiryMonth).padStart(2, '0')}`;
    return expiry >= localDate(now, gym.timezone).slice(0, 7) ? method : null;
  }
  return defaultRefusal(method, gym.currency) === null ? method : null;
}
function missing(): never { throw new AppError('not_found', 'Signed link or resource not found'); }
function unavailable(): never { throw new AppError('unavailable', 'Checkout is not available'); }
export class CustomerNotLinked extends AppError {
  constructor(cause?: unknown) { super('unavailable', 'Card setup is not available yet'); this.cause = cause; }
}
/** A payment flow with its own return pages and a short Checkout, such as /join. The paths are the flow's own
 * constants, never request values. Without one, pay links return to /l/return and keep the 23-hour window. */
export interface CheckoutReturn {
  readonly successPath: string;
  readonly cancelPath: string;
  /** The reservation window and the session's provider expiry: 35 minutes to 23 hours. */
  readonly lifetimeMs: number;
}
const returnPath = /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
export interface SignedCheckoutOptions {
  scope?: typeof forGym;
  clock?: Clock;
  paymentsFor(gymId: string): Promise<Payments>;
  /** Trusted configured origin, never the request Host. */
  originFor(gymId: string): Promise<string>;
}
export function createSignedLinkCheckout(options: SignedCheckoutOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const customers = createCustomersService({ scope, clock, paymentsFor: options.paymentsFor });
  const settings = (gymId: string) => scope(gymId, tx => readGymSettings(tx, gymId));
  const cards = createCardHandlers({ scope, clock });
  async function checkBilling(gymId: string, payment: boolean) {
    if (payment && !(await settings(gymId)).billingEnabled) unavailable();
  }
  async function locked(tx: Transaction, gymId: string, linkId: string, completing = false) {
    const [link] = await tx.select().from(signedLinks).where(eq(signedLinks.id, linkId)).for('update');
    if (!link || link.gymId !== gymId || link.revokedAt || (!completing && link.usedAt) || link.expiresAt <= clock.now()
      || !['pay_invoice', 'update_card', 'onboarding'].includes(link.purpose)) missing();
    const [household] = await tx.select().from(households).where(eq(households.id, link.householdId));
    if (!household) missing();
    return { link, household };
  }
  const audit = (tx: Transaction, gymId: string, action: string, id: string, after: { sessionId?: string; customerId?: string; attemptKey?: string; expiresAt?: string } | null = null) => writeAudit(tx, {
    gymId, actorKind: 'system', action, targetType: 'signed_link', targetId: id,
    before: null, after, occurredAt: clock.now(),
  });
  type Household = { id: string; stripeCustomerId: string | null };
  /**
   * The link's latest card setup session, unless it was made for another customer than the household's current one (its
   * ID was cleared since: a switch from test to live, or an ID the account couldn't read). Each start records its
   * customer; one recorded before starts did counts as stale once the household was ever unlinked, since every unlink
   * came later. `stale` is a dropped session's ID, which keys the next session apart from it.
   */
  async function setupState(tx: Transaction, linkId: string, household: Household) {
    const [row] = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
      eq(auditEvents.targetType, 'signed_link'), eq(auditEvents.targetId, linkId),
      eq(auditEvents.action, 'billing.card_setup.started'))).orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
    const after = row?.after as { sessionId?: unknown; customerId?: unknown; expiresAt?: unknown } | null | undefined;
    const recorded = typeof after?.sessionId === 'string' ? after.sessionId : null;
    if (!recorded) return { sessionId: null, stale: null, expiresAt: null };
    const stale = typeof after?.customerId === 'string' ? after.customerId !== household.stripeCustomerId
      : (await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetType, 'household'),
        eq(auditEvents.targetId, household.id), eq(auditEvents.action, customerUnlinkedAction))).limit(1)).length > 0;
    return stale ? { sessionId: null, stale: recorded, expiresAt: null } : { sessionId: recorded, stale: null,
      expiresAt: typeof after?.expiresAt === 'string' ? new Date(after.expiresAt) : null };
  }
  const setupStart = async (tx: Transaction, linkId: string, household: Household) => (await setupState(tx, linkId, household)).sessionId;
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
    await cards.collect(gymId, provider, session.customerId, session.paymentMethodId, setup.mandateId, setup.id);
  }
  async function createCheckout(provider: Payments, gymId: string, bankDebit: CheckoutRequest['bankDebit'], request: CheckoutRequest & { linkId: string }) {
    // A lost response retries the original options, even if the gym toggled bank payments or
    // enabled the method at Stripe in the meantime. The link lock serializes the choice.
    const target = { attemptKey: request.idempotencyKey };
    const choice = await scope(gymId, async tx => {
      await tx.select({ id: signedLinks.id }).from(signedLinks).where(eq(signedLinks.id, request.linkId)).for('update');
      const [saved] = await tx.select({ action: auditEvents.action, after: auditEvents.after }).from(auditEvents).where(and(
        eq(auditEvents.targetType, 'signed_link'), eq(auditEvents.targetId, request.linkId), eq(auditEvents.before, target),
        inArray(auditEvents.action, ['billing.checkout.methods_reserved', 'billing.bank_debits.unavailable'])))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
      if (saved) return { fallback: saved.action === 'billing.bank_debits.unavailable',
        bank: (saved.after as { bankDebit?: CheckoutRequest['bankDebit'] } | null)?.bankDebit };
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.checkout.methods_reserved', targetType: 'signed_link',
        targetId: request.linkId, before: target, after: bankDebit ? { bankDebit } : {}, occurredAt: clock.now() });
      return { fallback: false, bank: bankDebit };
    });
    const card = { ...request, idempotencyKey: request.idempotencyKey + ':card' };
    if (choice.fallback) return provider.createCheckout(card);
    if (!choice.bank) return provider.createCheckout(request);
    try { return await provider.createCheckout({ ...request, bankDebit: choice.bank }); }
    catch (error) {
      if (!(error instanceof BankDebitUnavailable)) throw error;
      await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.bank_debits.unavailable',
        targetType: 'signed_link', targetId: request.linkId, before: target, occurredAt: clock.now() }));
      return provider.createCheckout(card);
    }
  }
  async function startCard(gymId: string, linkId: string, customerId: string, provider: Payments, successUrl: string, cancelUrl: string,
    bankDebit: CheckoutRequest['bankDebit'], flow?: CheckoutReturn) {
    // The persisted start association also supplies the next attempt's stable key. Concurrent
    // clicks and lost creation responses retry one attempt; terminal sessions advance the key.
    for (let attempt = 0; attempt < 3; attempt++) {
      const prepared = await scope(gymId, async tx => {
        const { link, household } = await locked(tx, gymId, linkId);
        if (household.stripeCustomerId !== customerId) missing();
        return { link, ...await setupState(tx, linkId, household) };
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
            if (household.stripeCustomerId !== customerId || await setupStart(tx, linkId, household) !== session.id)
              throw new AppError('conflict', 'Card setup changed');
          });
          return { session, expiresAt: new Date(Math.min(prepared.link.expiresAt.getTime(), prepared.expiresAt?.getTime()
            ?? clock.now().getTime() + 23 * 60 * 60 * 1000)).toISOString() };
        }
        await recoverCard(gymId, linkId, session, provider);
      }
      const attemptKey = `signed-link:${linkId}:setup` + (prepared.sessionId ? `:after:${prepared.sessionId}`
        : prepared.stale ? `:after:${prepared.stale}` : '');
      // A short setup flow persists its exact expiry before calling out. Lost creation responses and concurrent
      // clicks must reuse identical parameters; after expiry a fresh reservation gets a distinct provider key.
      const reservation = flow ? await scope(gymId, async tx => {
        const { household, link } = await locked(tx, gymId, linkId);
        if (household.stripeCustomerId !== customerId) missing();
        const [previous] = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, linkId),
          eq(auditEvents.action, 'billing.card_setup.reserved'))).orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
        const saved = previous?.after as { attemptKey?: string; expiresAt?: string; customerId?: string } | undefined;
        if (previous && saved?.attemptKey === attemptKey && saved.customerId === customerId && saved.expiresAt
          && new Date(saved.expiresAt).getTime() > clock.now().getTime() + 31 * 60_000)
          return { id: previous.id, expiresAt: new Date(saved.expiresAt) };
        const expiresAt = new Date(Math.min(link.expiresAt.getTime(), clock.now().getTime() + flow.lifetimeMs));
        if (expiresAt.getTime() < clock.now().getTime() + 35 * 60_000) unavailable();
        const id = uuidv7(clock.now().getTime());
        await writeAudit(tx, { id, gymId, actorKind: 'system', action: 'billing.card_setup.reserved', targetType: 'signed_link', targetId: linkId,
          occurredAt: clock.now(), after: { attemptKey, expiresAt: expiresAt.toISOString(), customerId } });
        return { id, expiresAt };
      }) : null;
      const session = await createCheckout(provider, gymId, bankDebit, { mode: 'setup', customerId, linkId, successUrl,
        cancelUrl, saveForOffSession: true,
        ...(reservation ? { expiresAt: reservation.expiresAt } : {}),
        idempotencyKey: attemptKey + (reservation ? `:reservation:${reservation.id}` : '') });
      ownedSetup(session, gymId, linkId, customerId);
      await scope(gymId, async tx => {
        const { household } = await locked(tx, gymId, linkId);
        if (household.stripeCustomerId !== customerId) missing();
        const current = await setupStart(tx, linkId, household);
        if (current === session.id) return;
        if (current !== prepared.sessionId) throw new AppError('conflict', 'Card setup changed');
        await audit(tx, gymId, 'billing.card_setup.started', linkId, { sessionId: session.id, customerId,
          ...(reservation ? { expiresAt: reservation.expiresAt.toISOString() } : {}) });
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
    const issue = cardChargeIssue(invoice.amountCents, invoice.currency);
    if (issue) throw new AppError('conflict', 'Contact the gym to arrange a manual payment; this invoice cannot be paid by card', { reason: [issue] });
  }
  async function start(gymId: string, linkId: string, renewed = false, flow?: CheckoutReturn): Promise<{ session: CheckoutSession; expiresAt: string }> {
    if (flow && (!returnPath.test(flow.successPath) || !returnPath.test(flow.cancelPath) || !Number.isSafeInteger(flow.lifetimeMs)
      || flow.lifetimeMs < 35 * 60 * 1000 || flow.lifetimeMs > 23 * 60 * 60 * 1000)) unavailable();
    const origin = new URL(await options.originFor(gymId));
    if (origin.protocol !== 'https:' || origin.username || origin.password) unavailable();
    const returnUrl = new URL('/l/return', origin).href;
    const successUrl = flow ? new URL(flow.successPath, origin).href : returnUrl, cancelUrl = flow ? new URL(flow.cancelPath, origin).href : returnUrl;
    const windowMs = flow?.lifetimeMs ?? 23 * 60 * 60 * 1000;
    const gym = await settings(gymId), bankDebit = bankDebitFor(gym);
    const prepared = await scope(gymId, async tx => {
      const { link, household } = await locked(tx, gymId, linkId);
      if (link.purpose !== 'pay_invoice') return { link, customerId: household.stripeCustomerId, invoice: null, savesCard: true };
      if (!gym.billingEnabled) unavailable();
      const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, link.invoiceId!), eq(invoices.householdId, link.householdId))).for('update');
      if (!invoice) missing();
      await payable(tx, invoice);
      const savesCard = invoice.kind === 'cycle' || await isAssignmentInvoice(tx, invoice.id);
      const replaying = !invoice.checkoutSessionId && !!invoice.checkoutExpiresAt && invoice.checkoutExpiresAt > clock.now();
      // Reserve before the provider call. A lost response retries the exact key/parameters,
      // only inside the provider's 24-hour idempotency window. Never blindly retry later.
      // A flow's session expires with its reservation, which must leave the provider's 30-minute minimum.
      const renewBy = clock.now().getTime() + (flow ? 31 * 60 * 1000 : 0);
      if (!invoice.checkoutSessionId && (!invoice.checkoutExpiresAt || invoice.checkoutExpiresAt.getTime() <= renewBy)) {
        // With no stored ID, no URL was exposed: successful responses are persisted before
        // returning, or expired on failed adoption. Renew under the invoice lock with a new
        // key; never reuse the old key outside its retention window.
        const replacing = !!invoice.checkoutExpiresAt;
        invoice.checkoutExpiresAt = new Date(clock.now().getTime() + windowMs);
        await tx.update(invoices).set({ checkoutExpiresAt: invoice.checkoutExpiresAt }).where(eq(invoices.id, invoice.id));
        await audit(tx, gymId, replacing ? 'billing.checkout.reservation_renewed' : 'billing.checkout.reserved', linkId,
          { expiresAt: invoice.checkoutExpiresAt.toISOString() });
      }
      const [reservation] = !invoice.checkoutSessionId ? await tx.select({ linkId: auditEvents.targetId }).from(auditEvents)
        .innerJoin(signedLinks, eq(signedLinks.id, auditEvents.targetId)).where(and(
          eq(auditEvents.targetType, 'signed_link'), eq(signedLinks.invoiceId, invoice.id),
          eq(signedLinks.householdId, link.householdId),
          eq(auditEvents.after, { expiresAt: invoice.checkoutExpiresAt!.toISOString() }),
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
      // A stored ID (imported, or from before a key change) may be one this account can't read: it is never sent to Checkout,
      // and is replaced with a live key (with a test key, it may be a live customer, so the link is unavailable instead).
      if (prepared.customerId) customerId = await customers.readableCustomer(gymId, prepared.link.householdId, customerId, provider);
    } catch (error) {
      if (error instanceof AppError && error.code === 'not_found') throw error;
      logError('billing.customer.unavailable', { gymId, householdId: prepared.link.householdId, purpose: prepared.link.purpose,
        reason: error instanceof CustomerUnavailable ? error.reason : error instanceof Error ? error.name : typeof error }, error);
      throw new CustomerNotLinked(error);
    }
    let session: CheckoutSession;
    await checkBilling(gymId, !!prepared.invoice);
    if (!prepared.invoice) return startCard(gymId, linkId, customerId, provider, successUrl, cancelUrl, bankDebit, flow);
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
          if (!invoice) throw new AppError('conflict', 'Invoice changed');
          // The expired-Checkout webhook may have cleared this session and its reservation first: nothing to write here,
          // and the restarted call reserves under the invoice lock by its usual rule. Reconciliation clears only the
          // session, and the restarted call would replay the old link's reservation, so that case stays a conflict.
          if (invoice.checkoutSessionId === null && (!invoice.checkoutExpiresAt
            || invoice.checkoutExpiresAt.getTime() !== prepared.invoice!.checkoutExpiresAt?.getTime())) return payable(tx, invoice);
          if (invoice.checkoutSessionId !== session.id) throw new AppError('conflict', 'Invoice changed');
          await payable(tx, invoice);
          const checkoutExpiresAt = new Date(Math.max(clock.now().getTime() + windowMs, (invoice.checkoutExpiresAt?.getTime() ?? 0) + 1));
          await tx.update(invoices).set({ checkoutSessionId: null,
            checkoutExpiresAt,
          }).where(eq(invoices.id, invoice.id));
          await audit(tx, gymId, 'billing.checkout.expired', linkId);
          await audit(tx, gymId, 'billing.checkout.reservation_renewed', linkId, { expiresAt: checkoutExpiresAt.toISOString() });
        });
        return start(gymId, linkId, true, flow);
      }
      if (session.status !== 'open') throw new AppError('conflict', 'Checkout is no longer open');
    } else {
      const invoice = prepared.invoice;
      session = await createCheckout(provider, gymId, bankDebit, {
        mode: 'payment', customerId, linkId: prepared.reservationLinkId ?? linkId,
        invoiceId: invoice.id, amount: invoice.amountCents, currency: invoice.currency.toLowerCase(),
        successUrl, cancelUrl, saveForOffSession: prepared.savesCard,
        // A flow's return pages and expiry are part of its key, so no key is ever reused with other
        // parameters; the reservation fixes the expiry, so a retried key repeats identical ones.
        idempotencyKey: `invoice:${invoice.id}:checkout:${invoice.checkoutExpiresAt!.toISOString()}` + (flow ? ':' + flow.successPath + ':' + flow.cancelPath : ''),
        ...(flow ? { expiresAt: invoice.checkoutExpiresAt! } : {}),
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
    if (sessionLinkId !== linkId || session.status === 'expired' || prepared.replaying) return start(gymId, linkId, renewed, flow);
    if (session.status !== 'open') throw new AppError('conflict', 'Checkout is no longer open');
    return { session, expiresAt: new Date(Math.min(prepared.link.expiresAt.getTime(),
      prepared.invoice?.checkoutExpiresAt?.getTime() ?? clock.now().getTime() + 23 * 60 * 60 * 1000)).toISOString() };
  }
  /**
   * The one rule the page's offer and the completion share: the usable default with its last four digits on record, for a
   * household still linked to its Stripe customer (the charge runner charges no household without one).
   */
  async function keptMethod(tx: Transaction, gymId: string, household: Household) {
    if (!household.stripeCustomerId) return null;
    const method = await usableDefaultMethod(tx, gymId, household.id, clock.now());
    return method?.last4 ? method : null;
  }
  /**
   * The saved default method an onboarding link may keep instead of card setup, masked; null for other purposes. A
   * read-only view, so the link is read without its lock; `'used'` once the link was completed, even while rendering.
   */
  async function keepableCard(gymId: string, linkId: string): Promise<{ type: string; bankName: string | null; last4: string } | null | 'used'> {
    return scope(gymId, async tx => {
      const [link] = await tx.select().from(signedLinks).where(eq(signedLinks.id, linkId));
      if (!link || link.gymId !== gymId || link.revokedAt || link.expiresAt <= clock.now()
        || !['pay_invoice', 'update_card', 'onboarding'].includes(link.purpose)) missing();
      if (link.usedAt) return 'used';
      const [household] = await tx.select().from(households).where(eq(households.id, link.householdId));
      if (!household) missing();
      if (link.purpose !== 'onboarding') return null;
      const method = await keptMethod(tx, gymId, household);
      return method ? { type: method.type, bankName: method.bankName, last4: method.last4! } : null;
    });
  }
  /**
   * Called by an authenticated browser receipt or the webhook's persisted link/session association. `keepCard` (an onboarding
   * link's own page only) completes without card setup when the household's default method is still usable, rechecked here
   * under the link lock, and every waiver is signed. It calls no provider and changes no payment method.
   */
  async function complete(gymId: string, linkId: string, sessionId: string | null, keepCard = false) {
    let session: CheckoutSession | null = null;
    // Keeping a card never reads the provider, even with an earlier Checkout's receipt; that one completes by its webhook.
    if (sessionId && !keepCard) {
      const provider = await options.paymentsFor(gymId);
      const found = await provider.readPaymentObject({ kind: 'checkout', id: sessionId });
      if (found.status === 'found' && found.value.kind === 'checkout') session = found.value.object;
      if (session?.metadata.gymId === gymId && session.metadata.linkId === linkId)
        await recoverCard(gymId, linkId, session, provider);
    }
    return scope(gymId, async tx => {
      const { link, household } = await locked(tx, gymId, linkId, true);
      if (link.usedAt) return true;
      if (keepCard && link.purpose === 'onboarding') {
        const kept = await keptMethod(tx, gymId, household);
        const people = kept ? await tx.select({ id: members.id }).from(members)
          .where(and(eq(members.householdId, link.householdId), isNull(members.anonymizedAt))) : [];
        if (kept && await signedLinkWaiversComplete(tx, people.map(m => m.id))) {
          await tx.update(signedLinks).set({ usedAt: clock.now() }).where(eq(signedLinks.id, linkId));
          await writeAudit(tx, { gymId, actorKind: 'system', action: 'signed_link.card_kept', targetType: 'signed_link', targetId: linkId,
            before: null, after: { paymentMethodId: kept.id }, occurredAt: clock.now() });
          await audit(tx, gymId, 'signed_link.used', linkId);
          await completeCampaignIn(tx, gymId, link.campaignId, clock.now());
          return true;
        }
      }
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
        // Only this link's own tagged Checkout can leave the invoice processing; another debit's doesn't use the link.
        if (!(tagged ? ['processing', 'paid', 'partially_refunded', 'refunded'] : ['paid', 'partially_refunded', 'refunded']).includes(invoice.status)) return false;
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
      await completeCampaignIn(tx, gymId, link.campaignId, clock.now());
      return true;
    });
  }
  return { start, complete, keepableCard };
}
