// SPDX-License-Identifier: AGPL-3.0-only
import { smsDeliveries, type forGym } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { createDeliveryState } from '../delivery-state.js';
import { createKeyedCommandDigest } from '../email/deliveries.js';
import { smsDeadlineMs } from './constants.js';
import { DeliveryError, SmsDeliveryError, deliveryAcceptance, type Sms, type SmsMessage, type SmsResult } from './index.js';

/** `sending` is an attempt in flight; once older than the in-flight window it reads as `unknown`. */
export type SmsDeliveryState = 'sending' | 'accepted' | 'unknown' | 'not_accepted';
/** `skipped` means an earlier attempt under the key was accepted or may have been; nothing was sent. */
export type RecordedSmsResult = SmsResult | { status: 'skipped'; state: 'accepted' | 'unknown' };
/** A committed `sending` row this attempt owns; `attempt` or `release` resolves it. */
export interface SmsReservation { readonly gymId: string; readonly id: string; readonly attempts: number }
/** Twice the SMS transport's hard session deadline (`smsDeadlineMs`), so a `sending` row this old has finished. */
export const smsInFlightMs = 2 * smsDeadlineMs;

function validKey(key: string): void {
  if (key.length < 1 || key.length > 300 || !/^[A-Za-z0-9_.:-]+$/.test(key)) throw new Error('Invalid sms delivery key');
}
/** A phone is represented in delivery keys only by an HMAC under AUTH_SECRET. */
export function createSmsPhoneDigest(secret: string) {
  const digest = createKeyedCommandDigest(secret);
  return (phone: string) => digest(['sms.phone', phone]);
}

/**
 * At most one message per key can reach a recipient. An attempt is reserved as `sending` and committed before the
 * transport is called, so a crash, lost reply or lost outcome write never permits a resend; only a definite non-send
 * (`not_accepted`: suppressed, or a DeliveryError proving no recipient got it) can be attempted again.
 * Keys hold identifiers only, never readable personal data.
 *
 * `send` is a whole attempt. A send command that issues a credential uses the parts instead, because the credential and
 * the reservation must commit together: `replay` first, then `reserve` and `remember` in the transaction that issues the
 * credential, then `attempt` (or `release`, when it never reaches the transport) after that transaction.
 */
export function createSmsDeliveries(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const delivery = createDeliveryState<SmsMessage, SmsResult>({
    table: smsDeliveries, name: 'sms', validKey, inFlightMs: smsInFlightMs,
    errors: {
      acceptance: deliveryAcceptance,
      record: () => new Error('SMS outcome write failed'),
      build: () => new DeliveryError('not_accepted', 'SMS message could not be built'),
      buildRelease: () => new DeliveryError('not_accepted', 'SMS message could not be built or released'),
      // Only SmsDeliveryError has a fixed message and safe provider reason.
      transport: error => error instanceof SmsDeliveryError ? error : new DeliveryError(deliveryAcceptance(error), 'SMS delivery failed'),
      outcome: acceptance => new DeliveryError(acceptance, 'SMS delivery outcome could not be recorded'),
      reserve: () => new DeliveryError('not_accepted', 'SMS delivery could not be reserved'),
      inFlight: () => new DeliveryError('not_accepted', 'Another attempt is sending this sms'),
    },
  }, options);
  const send = (gymId: string, key: string, sms: Sms, message: SmsMessage): Promise<RecordedSmsResult> =>
    delivery.send(gymId, key, built => sms.sendSms(built), message);
  const attempt = (reservation: SmsReservation, sms: Sms,
    message: SmsMessage | (() => SmsMessage | Promise<SmsMessage>)): Promise<SmsResult> =>
    delivery.attempt(reservation, built => sms.sendSms(built), message);
  return { ...delivery, send, attempt };
}
export type SmsDeliveries = ReturnType<typeof createSmsDeliveries>;
