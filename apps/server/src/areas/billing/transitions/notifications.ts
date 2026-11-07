// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, type payments, type refunds } from '@plaingym/db';
import { createTranslator, type Clock, type Translator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { cardChargeIssue } from '@plaingym/shared/money';
import type { InvoiceSnapshot } from '../../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import type { Email, EmailResult } from '../../../infra/email/index.js';
import { clock as defaultClock } from '../../../core/clock.js';
import { formatMoney } from '../../../core/money.js';
import { createSignedLinksService } from '../../links/service.js';
import { householdRecipient } from '../../members/household-recipient.js';

export interface TransitionNotice {
  gymId: string;
  invoice: InvoiceSnapshot;
  payment?: typeof payments.$inferSelect;
}
/** Staff are told about a duplicate card payment (the default), a processor refund that failed (`reversed` when it
 * failed after it was reported successful), or a duplicate payment's reservation released with no processor refund,
 * with what isn't recorded as refunded. A canceled refund was cancelled on purpose and has no notice. */
export type StaffNotice = TransitionNotice & ({ reason?: 'duplicate_payment' }
  | { reason: 'refund_failed'; refund: typeof refunds.$inferSelect; reversed?: boolean }
  | { reason: 'duplicate_released'; unrefundedCents: number });
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
  async function deliver(notice: TransitionNotice, kind: 'receipt' | 'failed' | 'action' | 'duplicate' | 'duplicateReleased' | 'refundFailed' | 'refundReversed',
    amountCents?: number) {
    assertNoTransaction('invoice notification');
    const { gymId, invoice } = notice;
    const staff = kind === 'duplicate' || kind === 'duplicateReleased' || kind === 'refundFailed' || kind === 'refundReversed';
    const recipients = staff ? await options.staffRecipients(gymId) : await memberRecipients(gymId, invoice.householdId);
    if (!recipients.length) {
      if (staff) throw new Error('No staff recipient configured for billing staff notices');
      return;
    }
    const prepared = await options.prepare(gymId);
    const t: Translator = (key, values) => {
      const translated = prepared.t?.(key, values);
      return translated && translated !== key ? translated : defaultTranslator(key, values);
    };
    const origin = new URL(prepared.origin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
      throw new Error('Invalid billing notification origin');
    let payUrl = '', updateUrl = '';
    const minted: string[] = [];
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
      const values = { number: invoice.number, amount: formatMoney(amountCents ?? notice.payment?.amountCents ?? invoice.amountCents, invoice.currency), payUrl, updateUrl };
      const message = manualPayment ? 'manual' : kind;
      const subject = t(`billing/transitions:${message}Subject`, values), text = t(`billing/transitions:${message}Body`, values);
      for (const to of new Set(recipients)) {
        if (!to || /[\r\n\0]/.test(to)) throw new Error('Invalid billing email recipient');
        if (!staff && !(await options.settings.get(gymId)).memberEmailsEnabled) {
          for (const linkId of minted) await links.revoke({ gymId, actor: { kind: 'system' } }, linkId);
          return;
        }
        const sent: EmailResult = await prepared.email.sendEmail({ to, subject, text, html: `<p>${escape(text).replaceAll('\n', '<br>')}</p>` });
        if (sent.status === 'suppressed' && staff) throw new Error('Staff notice was suppressed');
        if (sent.status === 'suppressed' && minted.length) throw new Error('Dunning email was suppressed');
      }
    } catch (error) {
      for (const linkId of minted) await links.revoke({ gymId, actor: { kind: 'system' } }, linkId);
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
    async receipt(notice) { await deliver(notice, 'receipt'); },
    async dunning(notice) { await deliver(notice, notice.actionRequired ? 'action' : 'failed'); },
    async staffNotice(notice) {
      if (notice.reason === 'refund_failed')
        await deliver(notice, notice.reversed ? 'refundReversed' : 'refundFailed', notice.refund.amountCents);
      else if (notice.reason === 'duplicate_released') await deliver(notice, 'duplicateReleased', notice.unrefundedCents);
      else await deliver(notice, 'duplicate');
    },
  };
}
