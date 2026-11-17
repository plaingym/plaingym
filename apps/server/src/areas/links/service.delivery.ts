// SPDX-License-Identifier: AGPL-3.0-only
import { households, invoices, members, type Transaction, type forGym } from '@plaingym/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AppError, type Translator } from '@plaingym/shared';
import { cardChargeIssue } from '@plaingym/shared/money';
import { normalizePhone } from '@plaingym/shared/phone';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { SignedLinkRecord } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Email } from '../../infra/email/index.js';
import { renderSignedLink } from '../../emails/links/service.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { householdRecipient } from '../members/household-recipient.js';
import { householdNoticePhones } from '../members/sms-recipients.js';
import type { SmsResolver } from '../settings/sms.js';
import { DeliveryError } from '../../infra/sms/index.js';

/** MemberSms checks consent and phone; this additionally binds member recipients to the link's household at the last boundary. */
export function householdBoundSmsResolver(base: SmsResolver, scope: typeof forGym, gymId: string, householdId: string, memberIds: string[], purpose: SignedLinkRecord['purpose']): SmsResolver {
  return {
    status: id => base.status(id), configured: id => base.configured(id),
    async resolve(id) {
      const resolved = await base.resolve(id);
      if (!resolved) return null;
      return { ...resolved, sms: {
        verifyAccount: () => resolved.sms.verifyAccount(),
        async sendSms(message) {
          try {
            const found = memberIds.length ? await scope(gymId, tx => tx.select({ id: members.id }).from(members).where(and(
              eq(members.gymId, gymId), eq(members.householdId, householdId), inArray(members.id, memberIds), isNull(members.anonymizedAt)))) : [];
            if (found.length !== memberIds.length) throw new Error('Recipient moved');
            if (purpose === 'pay_invoice' || purpose === 'update_card') {
              const groups = await scope(gymId, tx => householdNoticePhones(tx, gymId, [householdId]));
              if (!groups.some(group => group.phoneE164 === message.to && (memberIds.length
                ? memberIds.every(id => group.consentMemberIds.includes(id))
                : group.consentHouseholdIds.includes(householdId)))) throw new Error('Payer changed');
            }
          } catch { throw new DeliveryError('not_accepted', 'Signed link recipient changed'); }
          return resolved.sms.sendSms(message);
        },
      } };
    },
  };
}

export interface PreparedSignedLinkSmsDelivery {
  readonly gymId: string;
  readonly origin: string;
  readonly resolver: SmsResolver;
  readonly t: Translator;
}
export interface SignedLinkSmsDelivery {
  /** Independent of SMTP configuration and the member email switch. */
  prepare(gymId: string): Promise<PreparedSignedLinkSmsDelivery>;
}
export function validateSignedLinkOrigin(delivery: { gymId: string; origin: string }, gymId: string): void {
  const url = new URL(delivery.origin);
  if (delivery.gymId !== gymId || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash)
    throw new AppError('unavailable', 'Invalid signed link delivery configuration');
}
/** Checked in the transaction that creates the credential, before it can be minted. */
export async function signedLinkSmsRecipient(tx: Transaction, gymId: string, householdId: string,
  recipientMemberId: string | undefined, country: string | null, purpose: SignedLinkRecord['purpose']) {
  const [home] = await tx.select().from(households).where(and(eq(households.gymId, gymId), eq(households.id, householdId))).for('update');
  if (!home) throw new AppError('not_found', 'Household not found');
  const [person] = recipientMemberId ? await tx.select().from(members).where(and(eq(members.gymId, gymId),
    eq(members.householdId, householdId), eq(members.id, recipientMemberId))).for('update') : [];
  if (recipientMemberId && (!person || person.anonymizedAt)) throw new AppError('not_found', 'Member not found');
  const recipient = person ?? home;
  if (!recipient.smsNoticesConsentAt) throw new AppError('invalid_request', 'SMS notices consent is required', { reason: ['sms_no_consent'] });
  const to = normalizePhone(recipient.phone, country);
  if (!to || to !== recipient.phoneE164) throw new AppError('invalid_request', 'SMS phone is invalid', { reason: ['sms_invalid_phone'] });
  if (person && (purpose === 'pay_invoice' || purpose === 'update_card')) {
    const groups = await householdNoticePhones(tx, gymId, [householdId]);
    if (!groups.some(group => group.consentMemberIds.includes(person.id)))
      throw new AppError('invalid_request', 'Billing links can only be texted to the payer', { reason: ['sms_payer_only'] });
  }
  return { to, memberIds: person ? [person.id] : [], householdIds: person ? [] : [home.id] };
}

export interface PreparedSignedLinkDelivery {
  readonly gymId: string;
  readonly gymName: string;
  /** Trusted configuration; never derive an emailed URL from an incoming Host header. */
  readonly origin: string;
  readonly email: Email;
  readonly memberEmailsEnabled: boolean;
  readonly t: Translator;
}
export interface SignedLinkDelivery {
  /** Load configuration outside the token transaction. */
  prepare(gymId: string): Promise<PreparedSignedLinkDelivery>;
}
export function validateSignedLinkDelivery(delivery: PreparedSignedLinkDelivery, gymId: string): void {
  validateSignedLinkOrigin(delivery, gymId);
  if (!delivery.memberEmailsEnabled) throw new AppError('unavailable', 'Member email is disabled');
}
export async function deliverSignedLink(input: {
  scope: typeof forGym;
  context: MutationContext;
  link: SignedLinkRecord;
  token: string;
  delivery: PreparedSignedLinkDelivery;
  noticeKey?: string;
  /** A send's preflight already refused the card amount and revoked its credential. */
  manualPayment?: boolean;
  /** Runs outside a transaction after selecting the mode; false cancels delivery. */
  prepareSelected?(mode: 'link' | 'manual' | 'skip'): Promise<boolean>;
}): Promise<boolean> {
  assertNoTransaction('links.send');
  const { scope, context, link, token, delivery } = input;
  if (link.purpose === 'unsubscribe') throw new AppError('not_found', 'Signed link not found');
  validateSignedLinkDelivery(delivery, context.gymId);
  const mode = link.purpose === 'pay_invoice' ? await scope(context.gymId, async tx => {
    const [invoice] = await tx.select({ amountCents: invoices.amountCents, currency: invoices.currency, status: invoices.status }).from(invoices)
      .where(and(eq(invoices.id, link.invoiceId!), eq(invoices.householdId, link.householdId)));
    if (!invoice) throw new AppError('not_found', 'Invoice not found');
    if (!['open', 'past_due'].includes(invoice.status) || invoice.amountCents === 0) {
      if (input.prepareSelected) return 'skip';
      if (!['open', 'past_due'].includes(invoice.status)) throw new AppError('conflict', 'Invoice cannot be paid');
      throw new AppError('conflict', 'No payment is needed', { reason: ['zero_invoice'] });
    }
    return input.manualPayment || !!cardChargeIssue(invoice.amountCents, invoice.currency) ? 'manual' : 'link';
  }) : 'link';
  if (await input.prepareSelected?.(mode) === false || mode === 'skip') return false;
  const manualPayment = mode === 'manual';
  const recipient = await scope(context.gymId, async (tx) => {
    // A waiver link also goes nowhere if its signer can't receive email.
    const found = await householdRecipient(tx, context.gymId, link.householdId,
      link.purpose === 'sign_waiver' ? link.memberId ?? undefined : undefined);
    if (!found || /[\r\n\0]/.test(found.email)) throw new AppError('invalid_request', 'Household email is missing or invalid');
    if (found.suppressed) throw new AppError('unavailable', 'Signed link recipient email is suppressed');
    return found.email;
  });
  const url = manualPayment ? '' : new URL(`/l/${token}`, delivery.origin).href;
  const content = await renderSignedLink({ gymName: delivery.gymName, url, purpose: link.purpose, manualPayment,
    ...(input.noticeKey ? { noticeKey: input.noticeKey } : {}) }, delivery.t);
  if (!(await createGymSettingsAccessor({ scope }).get(context.gymId)).memberEmailsEnabled)
    throw new AppError('unavailable', 'Member email is disabled');
  const result = await delivery.email.sendEmail({ to: recipient, ...content });
  if (result.status !== 'sent') throw new AppError('unavailable', 'Signed link email was suppressed');
  return !manualPayment;
}
