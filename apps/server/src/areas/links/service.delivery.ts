// SPDX-License-Identifier: AGPL-3.0-only
import { invoices, type forGym } from '@plaingym/db';
import { and, eq } from 'drizzle-orm';
import { AppError, type Translator } from '@plaingym/shared';
import { cardChargeIssue } from '@plaingym/shared/money';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { SignedLinkRecord } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Email } from '../../infra/email/index.js';
import { renderSignedLink } from '../../emails/links/service.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { householdRecipient } from '../members/household-recipient.js';

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
  const url = new URL(delivery.origin);
  if (delivery.gymId !== gymId || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash)
    throw new AppError('unavailable', 'Invalid signed link email configuration');
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
  prepareSelected?(mode: 'link' | 'manual'): Promise<boolean>;
}): Promise<boolean> {
  assertNoTransaction('links.send');
  const { scope, context, link, token, delivery } = input;
  validateSignedLinkDelivery(delivery, context.gymId);
  const manualPayment = link.purpose === 'pay_invoice' && await scope(context.gymId, async tx => {
    const [invoice] = await tx.select({ amountCents: invoices.amountCents, currency: invoices.currency }).from(invoices)
      .where(and(eq(invoices.id, link.invoiceId!), eq(invoices.householdId, link.householdId)));
    if (!invoice) throw new AppError('not_found', 'Invoice not found');
    return input.manualPayment || !!cardChargeIssue(invoice.amountCents, invoice.currency);
  });
  if (await input.prepareSelected?.(manualPayment ? 'manual' : 'link') === false) return false;
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
