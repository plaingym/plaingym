// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { emailDeliveries, forGym, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';
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
/** Identifies one address in a key, which never holds readable personal data. */
export const recipientDigest = (address: string) => sha256(address.trim().toLowerCase());
/** Identifies a send command's request, so one generation can't be reused for a different one. */
export const commandDigest = (request: readonly unknown[]) => sha256(JSON.stringify(request));
const stillSending = () => new AppError('conflict', 'This email is still being sent');
const otherRequest = () => new AppError('conflict', 'This send generation belongs to another request');

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
  const settled = (row: { state: string; updatedAt: Date }): EmailDeliveryState =>
    row.state === 'sending' && row.updatedAt.getTime() <= clock.now().getTime() - emailInFlightMs ? 'unknown' : row.state as EmailDeliveryState;
  async function state(gymId: string, key: string): Promise<EmailDeliveryState | undefined> {
    validKey(key);
    const [row] = await scope(gymId, tx => tx.select({ state: emailDeliveries.state, updatedAt: emailDeliveries.updatedAt })
      .from(emailDeliveries).where(and(eq(emailDeliveries.gymId, gymId), eq(emailDeliveries.key, key))));
    return row && settled(row);
  }
  async function claim(tx: Transaction, gymId: string, key: string, digest?: string) {
    validKey(key);
    const now = clock.now();
    const [created] = await tx.insert(emailDeliveries).values({ id: uuidv7(now.getTime()), gymId, key, state: 'sending',
      attempts: 1, commandDigest: digest ?? null, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [emailDeliveries.gymId, emailDeliveries.key] })
      .returning({ id: emailDeliveries.id, attempts: emailDeliveries.attempts });
    if (created) return created;
    const [row] = await tx.select().from(emailDeliveries)
      .where(and(eq(emailDeliveries.gymId, gymId), eq(emailDeliveries.key, key))).for('update');
    if (!row) throw new Error('Email delivery reservation vanished');
    // Checked again under the lock: two requests racing on one generation can both pass `replay`.
    if (digest !== undefined && row.commandDigest !== digest) throw otherRequest();
    const current = settled(row);
    // Another attempt may still be talking to SMTP; its outcome decides, so retry later instead of skipping.
    if (current === 'sending') return { inFlight: true as const };
    if (current !== 'not_accepted') return { skipped: current as 'accepted' | 'unknown' };
    await tx.update(emailDeliveries).set({ state: 'sending', attempts: row.attempts + 1, updatedAt: now })
      .where(eq(emailDeliveries.id, row.id));
    return { id: row.id, attempts: row.attempts + 1 };
  }
  /** Only this attempt's reservation may be resolved. A failed write leaves `sending`, which turns `unknown`: safe. */
  const record = (reservation: EmailReservation, next: Exclude<EmailDeliveryState, 'sending'>) =>
    scope(reservation.gymId, tx => tx.update(emailDeliveries).set({ state: next, updatedAt: clock.now() })
      .where(and(eq(emailDeliveries.id, reservation.id), eq(emailDeliveries.attempts, reservation.attempts),
        eq(emailDeliveries.state, 'sending')))).catch(() => undefined);
  /** Calls the transport for a committed reservation and records the outcome. */
  async function attempt(reservation: EmailReservation, email: Email, message: EmailMessage): Promise<EmailResult> {
    assertNoTransaction('email.deliveries.send');
    let result: EmailResult;
    try {
      result = await email.sendEmail(message);
    } catch (error) {
      await record(reservation, deliveryAcceptance(error) === 'not_accepted' ? 'not_accepted' : 'unknown');
      throw error;
    }
    await record(reservation, result.status === 'sent' ? 'accepted' : 'not_accepted');
    return result;
  }
  /** Rejects with a `not_accepted` DeliveryError whenever this call did not reach the transport. */
  async function send(gymId: string, key: string, email: Email, message: EmailMessage): Promise<RecordedEmailResult> {
    assertNoTransaction('email.deliveries.send');
    let reserved: Awaited<ReturnType<typeof claim>>;
    try {
      reserved = await scope(gymId, tx => claim(tx, gymId, key));
    } catch (error) {
      throw new DeliveryError('not_accepted', 'Email delivery could not be reserved', { cause: error });
    }
    if ('inFlight' in reserved) throw new DeliveryError('not_accepted', 'Another attempt is sending this email');
    if ('skipped' in reserved) return { status: 'skipped', state: reserved.skipped };
    return attempt({ gymId, ...reserved }, email, message);
  }
  /**
   * What a send command already did. Returns its remembered result when it was accepted or may have been, and nothing when
   * it hasn't run or was definitely not sent (run it). A generation used for another request, or an attempt still in flight,
   * is a conflict.
   */
  async function replay(tx: Transaction, gymId: string, key: string, digest: string): Promise<{ result: unknown } | undefined> {
    validKey(key);
    const [row] = await tx.select().from(emailDeliveries).where(and(eq(emailDeliveries.gymId, gymId), eq(emailDeliveries.key, key)));
    if (!row) return undefined;
    if (row.commandDigest !== digest) throw otherRequest();
    const current = settled(row);
    if (current === 'sending') throw stillSending();
    return current === 'not_accepted' ? undefined : { result: row.commandResult };
  }
  /** Reserves the key in the caller's transaction, after `replay` found nothing to return. Losing a race to it is a conflict. */
  async function reserve(tx: Transaction, gymId: string, key: string, digest: string): Promise<EmailReservation> {
    const reserved = await claim(tx, gymId, key, digest);
    if ('inFlight' in reserved || 'skipped' in reserved) throw stillSending();
    return { gymId, ...reserved };
  }
  /** Stores what a replay returns: identifiers and metadata only, never a credential. */
  async function remember(tx: Transaction, reservation: EmailReservation, result: unknown): Promise<void> {
    await tx.update(emailDeliveries).set({ commandResult: result }).where(eq(emailDeliveries.id, reservation.id));
  }
  /** The attempt never reached the transport, so nothing was sent and the command can run again. */
  async function release(reservation: EmailReservation): Promise<void> {
    await record(reservation, 'not_accepted');
  }
  return { state, send, replay, reserve, remember, attempt, release };
}
export type EmailDeliveries = ReturnType<typeof createEmailDeliveries>;
