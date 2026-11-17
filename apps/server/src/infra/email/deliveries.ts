// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { and, eq, like, lte } from 'drizzle-orm';
import { emailDeliveries, forGym } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { clock as systemClock } from '../../core/clock.js';
import type { JobRegistration } from '../../core/registry.js';
import { createDeliveryState } from '../delivery-state.js';
import { DeliveryError, deliveryAcceptance, type Email, type EmailMessage, type EmailResult } from './index.js';

/** `sending` is an attempt in flight; once older than the in-flight window it reads as `unknown`. */
export type EmailDeliveryState = 'sending' | 'accepted' | 'unknown' | 'not_accepted';
/** `skipped` means an earlier attempt under the key was accepted or may have been; nothing was sent. */
export type RecordedEmailResult = EmailResult | { status: 'skipped'; state: 'accepted' | 'unknown' };
/** A committed `sending` row this attempt owns; `attempt` or `release` resolves it. */
export interface EmailReservation { readonly gymId: string; readonly id: string; readonly attempts: number }
/** Twice the SMTP transport's hard session deadline (`smtpSessionLimitMs`), so a `sending` row this old has finished. */
export const emailInFlightMs = 10 * 60_000;

function validKey(key: string): void {
  if (key.length < 1 || key.length > 300 || /[\r\n\0]/.test(key)) throw new Error('Invalid email delivery key');
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The form an address is compared and digested in. */
export const normalizeAddress = (address: string) => address.trim().toLowerCase();
/**
 * Identifies one staff address in a key, which never holds readable personal data. Only for staff recipients: anyone
 * holding the table can test a known address against it, so a member's address never goes into a key.
 */
export const recipientDigest = (address: string) => sha256(normalizeAddress(address));
/** Identifies a send command's request, so one generation can't be reused for a different one. A plain digest of a
 * member's address must not outlive the member's erasure: use `createKeyedCommandDigest`, or clear it on erasure as
 * announcements and cancellation notices do (`areas/announcements/erasure.ts`). */
export const commandDigest = (request: readonly unknown[]) => sha256(JSON.stringify(request));
/** Version marker for keyed command digests. */
export const keyedDigestPrefix = 'k1:';
/**
 * `commandDigest` keyed with a secret the install already holds (`AUTH_SECRET`), for a request that names a member's
 * address: without the secret, a stored digest can't be tested against a guessed address, in the database or a backup.
 */
export function createKeyedCommandDigest(secret: string) {
  const key = Buffer.from(hkdfSync('sha256', secret, new Uint8Array(0), 'plaingym email command digest v1', 32));
  return (request: readonly unknown[]) => keyedDigestPrefix + createHmac('sha256', key).update(JSON.stringify(request)).digest('base64url');
}
/** Each login link's key (`infra/auth/delivery.ts`); the upkeep sweeps them once the link has expired. */
export const loginLinkKeyPrefix = 'auth.login_link:';
/** Emailed portal invitations (`areas/members/household-users.invitations.ts`), whose digest names the invitee's address. */
export const portalInvitationKeyPrefix = 'portal.invitation:';
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

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
export function createEmailDeliveries(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const delivery = createDeliveryState<EmailMessage, EmailResult>({
    table: emailDeliveries, name: 'email', validKey, inFlightMs: emailInFlightMs,
    errors: {
      acceptance: deliveryAcceptance, record: error => error, build: error => error, transport: error => error,
      buildRelease: (error, cause) => new DeliveryError('not_accepted', 'Email message could not be built or released', {
        cause: new AggregateError([error, cause], 'Message building and reservation release failed'),
      }),
      outcome: (acceptance, cause, transport) => new DeliveryError(acceptance, 'Email delivery outcome could not be recorded', {
        cause: transport ? new AggregateError([transport.error, cause], 'Transport and outcome recording failed') : cause,
      }),
      reserve: cause => new DeliveryError('not_accepted', 'Email delivery could not be reserved', { cause }),
      inFlight: () => new DeliveryError('not_accepted', 'Another attempt is sending this email'),
    },
  }, { scope, clock });
  const send = (gymId: string, key: string, email: Email, message: EmailMessage): Promise<RecordedEmailResult> =>
    delivery.send(gymId, key, built => email.sendEmail(built), message);
  const attempt = (reservation: EmailReservation, email: Email,
    message: EmailMessage | (() => EmailMessage | Promise<EmailMessage>)): Promise<EmailResult> =>
    delivery.attempt(reservation, built => email.sendEmail(built), message);
  /**
   * The hourly upkeep (`createEmailDeliveryJobs`), in short transactions. It deletes login-link rows once their link has
   * expired. Every other row stays. Returns the count, for tests.
   */
  async function upkeep(gymId: string) {
    const settledBefore = new Date(clock.now().getTime() - emailInFlightMs);
    // A login link lives five minutes, so once no attempt can still be in flight its key guards nothing.
    const swept = await scope(gymId, tx => tx.delete(emailDeliveries).where(and(eq(emailDeliveries.gymId, gymId),
      like(emailDeliveries.key, escapeLike(loginLinkKeyPrefix) + '%'), lte(emailDeliveries.updatedAt, settledBefore)))
      .returning({ id: emailDeliveries.id }));
    return { swept: swept.length };
  }
  return { ...delivery, send, attempt, upkeep };
}
export type EmailDeliveries = ReturnType<typeof createEmailDeliveries>;

export const emailDeliveryUpkeepJob = 'email.deliveries.upkeep';
/** Each gym's delivery records get the upkeep once an hour (`upkeep`, above). The runtime registers it. */
export function createEmailDeliveryJobs(deliveries?: Pick<EmailDeliveries, 'upkeep'>): readonly JobRegistration[] {
  return [{ id: emailDeliveryUpkeepJob, cron: '17 * * * *', async handler(_payload, context) {
    await (deliveries ?? createEmailDeliveries({ clock: context.clock })).upkeep(context.gymId);
  } }];
}
