// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, households, members } from '@plaingym/db';
import { AppError, type Translator } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { SignedLinkRecord } from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { Email } from '../../infra/email/index.js';
import { renderSignedLink } from '../../emails/links/service.js';

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
}): Promise<void> {
  assertNoTransaction('links.send');
  const { scope, context, link, token, delivery } = input;
  validateSignedLinkDelivery(delivery, context.gymId);
  const recipient = await scope(context.gymId, async (tx) => {
    const [household] = await tx.select({ email: households.email }).from(households).where(and(
      eq(households.gymId, context.gymId), eq(households.id, link.householdId),
    ));
    const email = household?.email?.trim();
    if (!email || /[\r\n\0]/.test(email)) throw new AppError('invalid_request', 'Household email is missing or invalid');
    const householdMembers = await tx.select({
      id: members.id, email: members.email, optOut: members.emailOptOut, deliverable: members.emailDeliverable,
    }).from(members).where(and(eq(members.gymId, context.gymId), eq(members.householdId, link.householdId)));
    const recipients = householdMembers.filter((member) => member.email?.trim().toLowerCase() === email.toLowerCase()
      || (link.purpose === 'sign_waiver' && member.id === link.memberId));
    if (recipients.some((member) => member.optOut || !member.deliverable))
      throw new AppError('unavailable', 'Signed link recipient email is suppressed');
    return email;
  });
  const url = new URL(`/l/${token}`, delivery.origin).href;
  const content = await renderSignedLink({ gymName: delivery.gymName, url, purpose: link.purpose }, delivery.t);
  const result = await delivery.email.sendEmail({ to: recipient, ...content });
  if (result.status !== 'sent') throw new AppError('unavailable', 'Signed link email was suppressed');
}