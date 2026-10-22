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
export type { MemberEmailOptions, EmailSuppression, SuppressionReason } from './member.js';
