// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, type payments, type refunds } from '@plaingym/db';
import { AppError, createTranslator, type Clock, type Translator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { cardChargeIssue } from '@plaingym/shared/money';
import type { BankFailureCode, InvoiceSnapshot } from '../../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import { createEmailDeliveries, DeliveryError, deliveryAcceptance, recipientDigest, type Email, type EmailMessage } from '../../../infra/email/index.js';
import { releaseUndisclosed } from '../../../infra/email/deliveries.js';
import { renderReceipt } from '../../../emails/billing/transitions.js';
import { clock as defaultClock } from '../../../core/clock.js';
import { formatMoney } from '../../../core/money.js';
import { createSignedLinksIn, createSignedLinksService } from '../../links/service.js';
import { householdRecipient } from '../../members/household-recipient.js';

export interface TransitionNotice {
  bankCode?: BankFailureCode;
  gymId: string;
  /** The persisted work this notice belongs to, stable across its job's retries: the effect, or a resend request's job.
   * Each failed charge and each requested receipt has its own, so a reminder or a resend gets its own send key. */
  generation: string;
  invoice: InvoiceSnapshot;
  payment?: typeof payments.$inferSelect;
}
/** Staff are told about a duplicate card payment (the default), a processor refund that failed (`reversed` when it
 * failed after it was reported successful), a duplicate payment's reservation released with no processor refund, with
 * what isn't recorded as refunded, an app-created refund that was canceled, or a staff refund the app released on its own. */
export type StaffNotice = TransitionNotice & ({ reason?: 'duplicate_payment' }
  /** `reversedCredits`: class pack credits the full refund took back, which staff restore by adjustment if owed. */
  | { reason: 'refund_failed'; refund: typeof refunds.$inferSelect; reversed?: boolean; reversedCredits?: number }
  | { reason: 'refund_canceled'; refund: typeof refunds.$inferSelect }
  | { reason: 'duplicate_released'; unrefundedCents: number }
  /** A staff refund the app released before it reached the processor: the payer may still be owed it. */
  | { reason: 'refund_released'; refund: typeof refunds.$inferSelect }
  /** A pending processor refund Stripe reported missing, released so an external refund could be recorded. */
  | { reason: 'refund_missing'; refund: typeof refunds.$inferSelect }
  /** Stripe later reported success for a refund released as missing; billing kept the release for staff to reconcile. */
  | { reason: 'refund_found'; refund: typeof refunds.$inferSelect }
  /** A released reservation did reach Stripe after its release notice. */
  | { reason: 'refund_arrived'; refund: typeof refunds.$inferSelect }
  /** A class pack paid for a member erased before it was paid: its credits weren't granted. */
  | { reason: 'credits_not_granted'; credits: number });
export interface TransitionNotifications {
  receipt(notice: TransitionNotice, options?: { emailOnly?: boolean }): Promise<void>;
  dunning(notice: TransitionNotice & { actionRequired: boolean }): Promise<void>;
  staffNotice(notice: StaffNotice): Promise<void>;
}
// English messages live in locales/en/billing/transitions.json.
const defaultTranslator = createTranslator(locales.en ?? {});
export function billingTranslator(translator?: Translator): Translator {
  return (key, values) => {
    const translated = translator?.(key, values);
    return translated && translated !== key ? translated : defaultTranslator(key, values);
  };
}
export function bankFailureMessage(code: BankFailureCode) {
  return code === 'payment_method_unusable' ? 'bankUnusable' : 'bankFailed';
}
export function trustedBillingOrigin(value: string): URL {
  const origin = new URL(value);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Invalid billing notification origin');
  return origin;
}
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Runtime supplies the gym SMTP resolver (or demo outbox), trusted origin and staff recipients. */
export function createTransitionNotifications(options: {
  scope?: typeof forGym;
  clock?: Clock;
  settings: GymSettingsAccessor;
  prepare(gymId: string): Promise<{ email: Email; origin: string; t?: Translator; gymName?: string }>;
  staffRecipients(gymId: string): Promise<readonly string[]>;
  sms?: Pick<TransitionNotifications, 'receipt' | 'dunning'>;
}): TransitionNotifications {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const links = createSignedLinksService({ scope, clock });
  const deliveries = createEmailDeliveries({ scope, clock });
  async function deliver(notice: TransitionNotice, kind: 'receipt' | 'failed' | 'action' | 'duplicate' | 'duplicateReleased' | 'refundFailed' | 'refundReleased'
    | 'refundCanceled' | 'refundArrived' | 'refundReversed' | 'refundMissing' | 'refundFound' | 'creditsNotGranted', subject: { purpose: string; id: string }, amountCents?: number, credits?: number) {
    assertNoTransaction('invoice notification');
    const { gymId, invoice } = notice;
    const staff = kind === 'duplicate' || kind === 'duplicateReleased' || kind === 'refundFailed' || kind === 'refundReversed' || kind === 'refundReleased'
      || kind === 'refundMissing' || kind === 'refundFound' || kind === 'creditsNotGranted' || kind === 'refundArrived' || kind === 'refundCanceled';
    const recipients = staff ? await options.staffRecipients(gymId) : await memberRecipients(gymId, invoice.householdId);
    if (!recipients.length) {
      if (staff) throw new Error('No staff recipient configured for billing staff notices');
      return;
    }
    const base = `billing.${subject.purpose}:${subject.id}:${notice.generation}`;
    // Staff notices have one key per recipient, so a retry reaches only those the message provably did not reach. A member
    // notice has one recipient and no address in its key: an erased member's address leaves nothing behind, and an address
    // changed between retries gets no second notice.
    const keyFor = (to: string) => staff ? `${base}:${recipientDigest(to)}` : base;
    // Cache the promise, including a failure, so one notice resolves SMTP at most once and settled notices need none.
    let preparation: Promise<Awaited<ReturnType<typeof options.prepare>>> | undefined;
    const prepare = () => preparation ??= options.prepare(gymId);
    const context = { gymId, actor: { kind: 'system' as const } };
    const manualPayment = !notice.bankCode && (kind === 'action' || kind === 'failed') && !!cardChargeIssue(invoice.amountCents, invoice.currency);
    let failure: unknown;
    for (const to of new Set(recipients)) {
      try {
        if (!to || /[\r\n\0]/.test(to)) throw new Error('Invalid billing email recipient');
        if (!staff && !(await options.settings.get(gymId)).memberEmailsEnabled) return;
        const key = keyFor(to);
        // Only fresh keys and proven non-sends need SMTP. Reserve checks again under lock if another worker wins the race.
        const state = await deliveries.state(gymId, key);
        if (state === 'accepted' || state === 'unknown') continue;
        if (state === 'sending') throw new AppError('conflict', 'This email is still being sent');
        const prepared = await prepare(), origin = trustedBillingOrigin(prepared.origin), t = billingTranslator(prepared.t);
        const pending = await scope(gymId, async tx => {
          const reservation = await deliveries.reserve(tx, gymId, key);
          if (!reservation) return;
          const linkFields = { householdId: invoice.householdId, expiresAt: new Date(clock.now().getTime() + 21 * 86400_000).toISOString() };
          const created = (kind === 'action' || kind === 'failed') && !manualPayment
            ? await createSignedLinksIn(tx, context, [{ ...linkFields, purpose: 'pay_invoice', invoiceId: invoice.id },
              { ...linkFields, purpose: 'update_card' }], clock.now()) : [];
          await deliveries.remember(tx, reservation, { linkIds: created.map(item => item.link.id) });
          return { reservation, created };
        });
        if (!pending) continue;
        const { created, reservation } = pending;
        let attempted = false, cleaned = false;
        async function cleanup() {
          cleaned = true;
          await releaseUndisclosed(created.map(item => () => links.revoke(context, item.link.id)), () => deliveries.release(reservation),
            'Billing email cleanup failed');
        }
        try {
          const payUrl = pending.created[0] ? new URL(`/l/${pending.created[0].token}`, origin).href : '';
          const updateUrl = pending.created[1] ? new URL(`/l/${pending.created[1].token}`, origin).href : '';
          const values = { number: invoice.number, amount: formatMoney(amountCents ?? notice.payment?.amountCents ?? invoice.amountCents, invoice.currency),
            payUrl, updateUrl, credits: credits ?? 0 };
          const message = notice.bankCode ? bankFailureMessage(notice.bankCode) : manualPayment ? 'manual' : kind;
          const title = t(`billing/transitions:${message}Subject`, values);
          const creditsNote = credits && (kind === 'refundFailed' || kind === 'refundReversed') ? '\n\n' + t('billing/transitions:creditsReversedNote', values) : '';
          const text = t(`billing/transitions:${message}Body`, values) + creditsNote;
          // Render before the attempt starts, so a render failure still releases the key as a definite non-send.
          let outgoing: EmailMessage;
          if (kind === 'receipt') {
            const gymName = prepared.gymName?.trim() || t('billing/transitions:receiptGymFallback');
            outgoing = { to, ...await renderReceipt({ gymName, number: values.number, amount: values.amount }, t) };
          } else {
            let html = escape(text).replaceAll('\n', '<br>');
            if (notice.bankCode) {
              for (const url of [payUrl, updateUrl].filter(Boolean)) {
                const href = escape(url);
                html = html.replaceAll(href, `<a href="${href}" style="word-break:break-all">${href}</a>`);
              }
            }
            outgoing = { to, subject: title, text, html: `<p>${html}</p>` };
          }
          if (!staff && !(await options.settings.get(gymId)).memberEmailsEnabled) {
            await cleanup();
            return;
          }
          attempted = true;
          const sent = await deliveries.attempt(pending.reservation, prepared.email, outgoing);
          if (sent.status === 'suppressed' && (staff || pending.created.length))
            throw new DeliveryError('not_accepted', staff ? 'Staff notice was suppressed' : 'Dunning email was suppressed');
        } catch (error) {
          // A cleanup that already ran (member email turned off) reports its own failure; don't run it twice.
          // Both errors are in the list; the aggregate needs no separate cause.
          let failed = error;
          if (!cleaned && (!attempted || deliveryAcceptance(error) === 'not_accepted')) {
            try { await cleanup(); }
            catch (cleanupError) { failed = new AggregateError([error, cleanupError], 'Billing email and cleanup failed'); }
          }
          throw failed;
        }
      } catch (error) {
        // A refused staff address must not prevent the other recipients from getting the notice.
        if (!staff) throw error;
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async function memberRecipients(gymId: string, householdId: string): Promise<string[]> {
    if (!(await options.settings.get(gymId)).memberEmailsEnabled) return [];
    return scope(gymId, async tx => {
      const recipient = await householdRecipient(tx, gymId, householdId);
      return recipient && !recipient.suppressed ? [recipient.email] : [];
    });
  }
  return {
    async receipt(notice, request) {
      await deliverBillingChannels(() => deliver(notice, 'receipt', { purpose: 'receipt', id: notice.invoice.id }),
        options.sms && !request?.emailOnly ? () => options.sms!.receipt(notice) : undefined);
    },
    // The purpose doesn't name the wording: one failed charge gets one notice, even if its attempt's status changes.
    async dunning(notice) {
      await deliverBillingChannels(() => deliver(notice, notice.actionRequired ? 'action' : 'failed', { purpose: 'dunning', id: notice.invoice.id }),
        options.sms ? () => options.sms!.dunning(notice) : undefined);
    },
    async staffNotice(notice) {
      if (notice.reason === 'refund_failed')
        await deliver(notice, notice.reversed ? 'refundReversed' : 'refundFailed', { purpose: 'refund_failure', id: notice.refund.id }, notice.refund.amountCents,
          notice.reversedCredits);
      else if (notice.reason === 'refund_canceled')
        await deliver(notice, 'refundCanceled', { purpose: 'refund_canceled', id: notice.refund.id }, notice.refund.amountCents);
      else if (notice.reason === 'refund_released')
        await deliver(notice, 'refundReleased', { purpose: 'refund_released', id: notice.refund.id }, notice.refund.amountCents);
      else if (notice.reason === 'refund_missing')
        await deliver(notice, 'refundMissing', { purpose: 'refund_missing', id: notice.refund.id }, notice.refund.amountCents);
      else if (notice.reason === 'refund_found')
        await deliver(notice, 'refundFound', { purpose: 'refund_found', id: notice.refund.id }, notice.refund.amountCents);
      else if (notice.reason === 'refund_arrived')
        await deliver(notice, 'refundArrived', { purpose: 'refund_arrived', id: notice.refund.id }, notice.refund.amountCents);
      else if (notice.reason === 'credits_not_granted')
        await deliver(notice, 'creditsNotGranted', { purpose: 'credits_not_granted', id: notice.invoice.id }, undefined, notice.credits);
      else if (notice.reason === 'duplicate_released')
        await deliver(notice, 'duplicateReleased', { purpose: 'duplicate_released', id: notice.payment?.id ?? notice.invoice.id }, notice.unrefundedCents);
      else await deliver(notice, 'duplicate', { purpose: 'duplicate_payment', id: notice.payment?.id ?? notice.invoice.id });
    },
  };
}

/** Each channel reaches its own durable outcome even when the other channel fails. */
export async function deliverBillingChannels(email: () => Promise<void>, sms?: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  for (const send of [email, sms]) if (send) {
    try { await send(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}
