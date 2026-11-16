// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { DeliveryError } from '../email/index.js';
export { DeliveryError, deliveryAcceptance } from '../email/index.js';

export interface SmsMessage { readonly to: string; readonly body: string }
export type SmsResult = { status: 'sent'; messageId: string } | {
  status: 'suppressed'; reason: 'disabled' | 'no_provider' | 'no_consent' | 'phone_changed' | 'cap_reached';
};
export interface Sms {
  sendSms(message: SmsMessage): Promise<SmsResult>;
  /** Checks credentials without sending a message. */
  verifyAccount(): Promise<void>;
}
export class SmsDeliveryError extends DeliveryError {
  constructor(acceptance: 'not_accepted' | 'unknown', readonly reason: 'recipient_opted_out' | 'provider_error' = 'provider_error') {
    super(acceptance, reason === 'recipient_opted_out' ? 'SMS recipient opted out' : 'SMS provider request failed');
  }
}
export function validateSms(message: SmsMessage): void {
  if (!/^[+][1-9][0-9]{1,14}$/.test(message.to) || !message.body || message.body.length > 1600)
    throw new DeliveryError('not_accepted', 'Invalid SMS message');
}
export class FakeSms implements Sms {
  readonly #messages: SmsMessage[] = [];
  #nextResult: SmsResult | Error | undefined;
  get messages(): readonly SmsMessage[] { return structuredClone(this.#messages); }
  respondNext(result: SmsResult | Error): void { this.#nextResult = result; }
  async verifyAccount(): Promise<void> { assertNoTransaction('sms.verifyAccount'); }
  async sendSms(message: SmsMessage): Promise<SmsResult> {
    assertNoTransaction('sms.sendSms');
    validateSms(message);
    const result = this.#nextResult; this.#nextResult = undefined;
    if (result instanceof Error) throw result;
    if (result?.status === 'suppressed') return { ...result };
    this.#messages.push(structuredClone(message));
    return result ?? { status: 'sent', messageId: `sms_${this.#messages.length}` };
  }
}
export { TwilioSms } from './twilio.js';
export { smsDeadlineMs } from './constants.js';
export type { TwilioConfig } from './twilio.js';
export { OutboxSms } from './outbox.js';
export { MemberSms } from './member.js';
export type { MemberSmsOptions, SmsSuppression } from './member.js';
export { createSmsDeliveries, createSmsPhoneDigest } from './deliveries.js';
export type { SmsDeliveries, SmsDeliveryState, SmsReservation, RecordedSmsResult } from './deliveries.js';
