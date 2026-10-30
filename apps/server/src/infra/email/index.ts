// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string;
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
export { createEmailDeliveries } from './deliveries.js';
export type { EmailDeliveries, EmailDeliveryState, RecordedEmailResult } from './deliveries.js';
export type { MemberEmailOptions, EmailSuppression, SuppressionReason } from './member.js';
