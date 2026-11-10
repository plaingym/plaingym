// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string;
  /** One absolute HTTPS URL without credentials, at most 2,048 characters once serialized; never raw header content. */
  readonly listUnsubscribe?: string;
}
export type EmailResult =
  | { status: 'sent'; messageId: string }
  | { status: 'suppressed'; reason: 'opt_out' | 'undeliverable' | 'disabled' };
export interface Email {
  sendEmail(message: EmailMessage): Promise<EmailResult>;
}

/** `not_accepted` is proof that no recipient received the message; anything less is `unknown`. */
export type DeliveryAcceptance = 'not_accepted' | 'unknown';
/** Provider-neutral send failure. The message never quotes recipients or server replies. */
export class DeliveryError extends Error {
  override readonly name = 'DeliveryError';
  /** Mirrors `acceptance` so structured logs, which record error codes only, show the classification. */
  readonly code: DeliveryAcceptance;
  constructor(readonly acceptance: DeliveryAcceptance, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = acceptance;
  }
}
/** Only a DeliveryError can prove a non-send; every other failure may have followed acceptance. */
export function deliveryAcceptance(error: unknown): DeliveryAcceptance {
  return error instanceof DeliveryError ? error.acceptance : 'unknown';
}

/** Validate before any transport connects; return the URL serialization for Nodemailer's list option. */
export function listUnsubscribeUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // eslint-disable-next-line no-control-regex -- Refuse controls before URL parsing can silently strip them.
  if (value.length <= 2048 && /^https:\/\//i.test(value) && !/[\s<>\x00-\x1f\x7f]/.test(value)) {
    try {
      const url = new URL(value);
      // The serialized URL is what the header carries: percent-encoding can lengthen it, and it never holds credentials.
      if (url.protocol === 'https:' && url.hostname && !url.username && !url.password && url.href.length <= 2048) return url.href;
    } catch { /* Invalid URL: refuse it before the transport is called. */ }
  }
  throw new DeliveryError('not_accepted', 'Invalid email listUnsubscribe');
}

export class FakeEmail implements Email {
  readonly #messages: EmailMessage[] = [];
  #nextResult: EmailResult | Error | undefined;
  get messages(): readonly EmailMessage[] {
    return structuredClone(this.#messages);
  }
  respondNext(result: EmailResult | Error): void {
    this.#nextResult = result;
  }
  async sendEmail(message: EmailMessage): Promise<EmailResult> {
    assertNoTransaction('email.sendEmail');
    listUnsubscribeUrl(message.listUnsubscribe);
    const result = this.#nextResult;
    this.#nextResult = undefined;
    if (result instanceof Error) throw result;
    if (result?.status === 'suppressed') return { ...result };
    this.#messages.push(structuredClone(message));
    return result ?? { status: 'sent', messageId: `mail_${this.#messages.length}` };
  }
}

export { SmtpEmail, smtpOptions } from './smtp.js';
export type { SmtpConfig } from './smtp.js';
export { MemberEmail } from './member.js';
export { commandDigest, createEmailDeliveries, recipientDigest } from './deliveries.js';
export type { EmailDeliveries, EmailDeliveryState, EmailReservation, RecordedEmailResult } from './deliveries.js';
export type { MemberEmailOptions, EmailSuppression, SuppressionReason } from './member.js';
