// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, households, members, type payments } from '@plaingym/db';
import { createTranslator, type Clock, type Translator } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { InvoiceSnapshot } from '../../../core/interfaces/invoice-transitions.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import type { Email, EmailResult } from '../../../infra/email/index.js';
import { clock as defaultClock } from '../../../core/clock.js';
import { createSignedLinksService } from '../../links/service.js';

export interface TransitionNotice {
  gymId: string;
  invoice: InvoiceSnapshot;
  payment?: typeof payments.$inferSelect;
}
export interface TransitionNotifications {
  receipt(notice: TransitionNotice): Promise<void>;
  dunning(notice: TransitionNotice & { actionRequired: boolean }): Promise<void>;
  staffNotice(notice: TransitionNotice): Promise<void>;
}
// TODO(CCR): move this catalog to locales/en/billing/transitions.json when its ownership is extended.
export const transitionMessages = {
  receiptSubject: 'Receipt for invoice {number}',
  receiptBody: 'Payment of {amount} received for invoice {number}. Thank you.',
  failedSubject: 'Payment needed for invoice {number}',
  failedBody: 'The payment for invoice {number} could not be collected. Pay this invoice: {payUrl}\nUpdate your saved card: {updateUrl}',
  actionSubject: 'Authentication needed for invoice {number}',
  actionBody: 'Your bank requires authentication for invoice {number}. Complete payment: {payUrl}\nUpdate your saved card: {updateUrl}',
  duplicateSubject: 'Duplicate payment for invoice {number}',
  duplicateBody: 'An additional card payment of {amount} arrived for invoice {number}, which was already paid. An automatic refund was queued. Check the refund status in billing.',
};
const defaultTranslator = createTranslator({ 'billing/transitions': transitionMessages });
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
  async function deliver(notice: TransitionNotice, kind: 'receipt' | 'failed' | 'action' | 'duplicate') {
    assertNoTransaction('invoice notification');
    const { gymId, invoice } = notice;
    const recipients = kind === 'duplicate' ? await options.staffRecipients(gymId) : await memberRecipients(gymId, invoice.householdId);
    if (!recipients.length) {
      if (kind === 'duplicate') throw new Error('No staff recipient configured for duplicate-payment notices');
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
      if (kind === 'action' || kind === 'failed') {
        const context = { gymId, actor: { kind: 'system' as const } };
        const base = { householdId: invoice.householdId, expiresAt: new Date(clock.now().getTime() + 21 * 86400_000).toISOString() };
        const pay = await links.create(context, { ...base, purpose: 'pay_invoice', invoiceId: invoice.id });
        minted.push(pay.link.id);
        const update = await links.create(context, { ...base, purpose: 'update_card' });
        minted.push(update.link.id);
        payUrl = new URL(`/l/${pay.token}`, origin).href;
        updateUrl = new URL(`/l/${update.token}`, origin).href;
      }
      const values = { number: invoice.number, amount: new Intl.NumberFormat('en', { style: 'currency', currency: invoice.currency })
        .format((notice.payment?.amountCents ?? invoice.amountCents) / 100), payUrl, updateUrl };
      const subject = t(`billing/transitions:${kind}Subject`, values), text = t(`billing/transitions:${kind}Body`, values);
      for (const to of new Set(recipients)) {
        if (!to || /[\r\n\0]/.test(to)) throw new Error('Invalid billing email recipient');
        const sent: EmailResult = await prepared.email.sendEmail({ to, subject, text, html: `<p>${escape(text).replaceAll('\n', '<br>')}</p>` });
        if (sent.status === 'suppressed' && kind === 'duplicate') throw new Error('Staff notice was suppressed');
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
      const household = (await tx.select().from(households).where(eq(households.id, householdId)))[0];
      const email = household?.email?.trim();
      if (!email) return [];
      const family = await tx.select().from(members).where(eq(members.householdId, householdId));
      if (family.some(member => member.email?.trim().toLowerCase() === email.toLowerCase() && (member.emailOptOut || !member.emailDeliverable))) return [];
      return [email];
    });
  }
  return {
    async receipt(notice) { await deliver(notice, 'receipt'); },
    async dunning(notice) { await deliver(notice, notice.actionRequired ? 'action' : 'failed'); },
    async staffNotice(notice) { await deliver(notice, 'duplicate'); },
  };
}
