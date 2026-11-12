// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, type payments, type refunds } from '@plaingym/db';
import { createTranslator, type Clock, type Translator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { cardChargeIssue } from '@plaingym/shared/money';
import type { InvoiceSnapshot } from '../../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import { createEmailDeliveries, deliveryAcceptance, recipientDigest, type Email, type RecordedEmailResult } from '../../../infra/email/index.js';
import { clock as defaultClock } from '../../../core/clock.js';
import { formatMoney } from '../../../core/money.js';
import { createSignedLinksService } from '../../links/service.js';
import { householdRecipient } from '../../members/household-recipient.js';

export interface TransitionNotice {
  gymId: string;
  /** The persisted work this notice belongs to, stable across its job's retries: the effect, or a resend request's job.
   * Each failed charge and each requested receipt has its own, so a reminder or a resend gets its own send key. */
  generation: string;
  invoice: InvoiceSnapshot;
  payment?: typeof payments.$inferSelect;
}
/** Staff are told about a duplicate card payment (the default), a processor refund that failed (`reversed` when it
 * failed after it was reported successful), or a duplicate payment's reservation released with no processor refund,
 * with what isn't recorded as refunded. A canceled refund was cancelled on purpose and has no notice. */
export type StaffNotice = TransitionNotice & ({ reason?: 'duplicate_payment' }
  /** `reversedCredits`: class pack credits the full refund took back, which staff restore by adjustment if owed. */
  | { reason: 'refund_failed'; refund: typeof refunds.$inferSelect; reversed?: boolean; reversedCredits?: number }
  | { reason: 'duplicate_released'; unrefundedCents: number }
  /** A class pack paid for a member erased before it was paid: its credits weren't granted. */
  | { reason: 'credits_not_granted'; credits: number });
export interface TransitionNotifications {
  receipt(notice: TransitionNotice): Promise<void>;
  dunning(notice: TransitionNotice & { actionRequired: boolean }): Promise<void>;
  staffNotice(notice: StaffNotice): Promise<void>;
}
// English messages live in locales/en/billing/transitions.json.
const defaultTranslator = createTranslator(locales.en ?? {});
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Runtime supplies the gym SMTP resolver (or demo outbox), trusted origin and staff recipients. */
export function createTransitionNotifications(options: {
  scope?: typeof forGym;
  clock?: Clock;
  settings: GymSettingsAccessor;
  prepare(gymId: string): Promise<{ email: Email; origin: string; t?: Translator }>;
  staffRecipients(gymId: string): Promise<readonly string[]>;
}): TransitionNotifications {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const links = createSignedLinksService({ scope, clock });
  const deliveries = createEmailDeliveries({ scope, clock });
  async function deliver(notice: TransitionNotice, kind: 'receipt' | 'failed' | 'action' | 'duplicate' | 'duplicateReleased' | 'refundFailed'
    | 'refundReversed' | 'creditsNotGranted', subject: { purpose: string; id: string }, amountCents?: number, credits?: number) {
    assertNoTransaction('invoice notification');
    const { gymId, invoice } = notice;
    const staff = kind === 'duplicate' || kind === 'duplicateReleased' || kind === 'refundFailed' || kind === 'refundReversed'
      || kind === 'creditsNotGranted';
    const recipients = staff ? await options.staffRecipients(gymId) : await memberRecipients(gymId, invoice.householdId);
    if (!recipients.length) {
      if (staff) throw new Error('No staff recipient configured for billing staff notices');
      return;
    }
    const base = `billing.${subject.purpose}:${subject.id}:${notice.generation}`;
    // Staff notices have one key per recipient, so a retry reaches only those the message provably did not reach. A member
    // notice has one recipient and no address in its key: an erased member's address leaves nothing behind, and an address
    // changed between retries gets no second notice. Rows an earlier release keyed per recipient are adopted first.
    const keyFor = (to: string) => staff ? `${base}:${recipientDigest(to)}` : base;
    if (!staff) await scope(gymId, tx => deliveries.adopt(tx, gymId, base));
    // An accepted or possibly accepted notice is never sent again, so no second link is minted for it.
    const pending: string[] = [];
    for (const to of new Set(recipients)) {
      const state = await deliveries.state(gymId, keyFor(to));
      if (state === 'sending') throw new Error('Billing notice is still being sent');
      if (state !== 'accepted' && state !== 'unknown') pending.push(to);
    }
    if (!pending.length) return;
    const prepared = await options.prepare(gymId);
    const t: Translator = (key, values) => {
      const translated = prepared.t?.(key, values);
      return translated && translated !== key ? translated : defaultTranslator(key, values);
    };
    const origin = new URL(prepared.origin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
      throw new Error('Invalid billing notification origin');
    let payUrl = '', updateUrl = '', uncertain = false;
    const minted: string[] = [];
    const revokeMinted = async () => { for (const linkId of minted) await links.revoke({ gymId, actor: { kind: 'system' } }, linkId); };
    try {
      const manualPayment = (kind === 'action' || kind === 'failed') && !!cardChargeIssue(invoice.amountCents, invoice.currency);
      if ((kind === 'action' || kind === 'failed') && !manualPayment) {
        const context = { gymId, actor: { kind: 'system' as const } };
        const base = { householdId: invoice.householdId, expiresAt: new Date(clock.now().getTime() + 21 * 86400_000).toISOString() };
        const pay = await links.create(context, { ...base, purpose: 'pay_invoice', invoiceId: invoice.id });
        minted.push(pay.link.id);
        const update = await links.create(context, { ...base, purpose: 'update_card' });
        minted.push(update.link.id);
        payUrl = new URL(`/l/${pay.token}`, origin).href;
        updateUrl = new URL(`/l/${update.token}`, origin).href;
      }
      const values = { number: invoice.number, amount: formatMoney(amountCents ?? notice.payment?.amountCents ?? invoice.amountCents, invoice.currency), payUrl, updateUrl,
        credits: credits ?? 0 };
      const message = manualPayment ? 'manual' : kind;
      const title = t(`billing/transitions:${message}Subject`, values);
      // A failed refund of a class pack also names the credits the refund took back, which staff restore if owed.
      const creditsNote = credits && (kind === 'refundFailed' || kind === 'refundReversed') ? '\n\n' + t('billing/transitions:creditsReversedNote', values) : '';
      const text = t(`billing/transitions:${message}Body`, values) + creditsNote;
      let failure: unknown;
      for (const to of pending) {
        try {
          if (!to || /[\r\n\0]/.test(to)) throw new Error('Invalid billing email recipient');
          if (!staff && !(await options.settings.get(gymId)).memberEmailsEnabled) {
            await revokeMinted();
            return;
          }
          let sent: RecordedEmailResult;
          try {
            sent = await deliveries.send(gymId, keyFor(to), prepared.email, { to, subject: title, text, html: `<p>${escape(text).replaceAll('\n', '<br>')}</p>` });
          } catch (error) {
            uncertain = deliveryAcceptance(error) !== 'not_accepted';
            throw error;
          }
          // Another attempt holds the key, so this attempt's links were never sent.
          if (sent.status === 'skipped') await revokeMinted();
          if (sent.status === 'suppressed' && staff) throw new Error('Staff notice was suppressed');
          if (sent.status === 'suppressed' && minted.length) throw new Error('Dunning email was suppressed');
        } catch (error) {
          // One refused staff address doesn't hold up the others: the notice fails once every recipient was tried, and its
          // retry reaches only those it provably missed. A member notice has one recipient (and its links), so it fails at once.
          if (!staff) throw error;
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    } catch (error) {
      // A possibly delivered link stays usable, because it is never sent again.
      if (!uncertain) await revokeMinted();
      throw error;
    }
  }
  async function memberRecipients(gymId: string, householdId: string): Promise<string[]> {
    if (!(await options.settings.get(gymId)).memberEmailsEnabled) return [];
    return scope(gymId, async tx => {
      const recipient = await householdRecipient(tx, gymId, householdId);
      return recipient && !recipient.suppressed ? [recipient.email] : [];
    });
  }
  return {
    async receipt(notice) { await deliver(notice, 'receipt', { purpose: 'receipt', id: notice.invoice.id }); },
    // The purpose doesn't name the wording: one failed charge gets one notice, even if its attempt's status changes.
    async dunning(notice) { await deliver(notice, notice.actionRequired ? 'action' : 'failed', { purpose: 'dunning', id: notice.invoice.id }); },
    async staffNotice(notice) {
      if (notice.reason === 'refund_failed')
        await deliver(notice, notice.reversed ? 'refundReversed' : 'refundFailed', { purpose: 'refund_failure', id: notice.refund.id }, notice.refund.amountCents,
          notice.reversedCredits);
      else if (notice.reason === 'credits_not_granted')
        await deliver(notice, 'creditsNotGranted', { purpose: 'credits_not_granted', id: notice.invoice.id }, undefined, notice.credits);
      else if (notice.reason === 'duplicate_released')
        await deliver(notice, 'duplicateReleased', { purpose: 'duplicate_released', id: notice.payment?.id ?? notice.invoice.id }, notice.unrefundedCents);
      else await deliver(notice, 'duplicate', { purpose: 'duplicate_payment', id: notice.payment?.id ?? notice.invoice.id });
    },
  };
}
