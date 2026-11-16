// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { smsDeliveries, forGym, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';
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
const stillSending = () => new AppError('conflict', 'This sms is still being sent');
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
export function createSmsDeliveries(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const settled = (row: { state: string; updatedAt: Date }): SmsDeliveryState =>
    row.state === 'sending' && row.updatedAt.getTime() <= clock.now().getTime() - smsInFlightMs ? 'unknown' : row.state as SmsDeliveryState;
  async function state(gymId: string, key: string): Promise<SmsDeliveryState | undefined>;
  async function state(tx: Transaction, gymId: string, key: string): Promise<SmsDeliveryState | undefined>;
  async function state(txOrGym: Transaction | string, gymOrKey: string, transactionKey?: string): Promise<SmsDeliveryState | undefined> {
    if (typeof txOrGym === 'string') return scope(txOrGym, tx => state(tx, txOrGym, gymOrKey));
    const tx = txOrGym, gymId = gymOrKey, key = transactionKey!;
    validKey(key);
    const [row] = await tx.select({ state: smsDeliveries.state, updatedAt: smsDeliveries.updatedAt })
      .from(smsDeliveries).where(and(eq(smsDeliveries.gymId, gymId), eq(smsDeliveries.key, key)));
    return row && settled(row);
  }
  async function claim(tx: Transaction, gymId: string, key: string, digest?: string) {
    validKey(key);
    const now = clock.now();
    const [created] = await tx.insert(smsDeliveries).values({ id: uuidv7(now.getTime()), gymId, key, state: 'sending',
      attempts: 1, commandDigest: digest ?? null, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [smsDeliveries.gymId, smsDeliveries.key] })
      .returning({ id: smsDeliveries.id, attempts: smsDeliveries.attempts });
    if (created) return created;
    const [row] = await tx.select().from(smsDeliveries)
      .where(and(eq(smsDeliveries.gymId, gymId), eq(smsDeliveries.key, key))).for('update');
    if (!row) throw new Error('Sms delivery reservation vanished');
    // Checked again under the lock: two requests racing on one generation can both pass `replay`.
    if (digest !== undefined && row.commandDigest !== digest) throw otherRequest();
    const current = settled(row);
    // Another attempt may still be talking to SMS; its outcome decides, so retry later instead of skipping.
    if (current === 'sending') return { inFlight: true as const };
    if (current !== 'not_accepted') return { skipped: current as 'accepted' | 'unknown' };
    await tx.update(smsDeliveries).set({ state: 'sending', attempts: row.attempts + 1, updatedAt: now })
      .where(eq(smsDeliveries.id, row.id));
    return { id: row.id, attempts: row.attempts + 1 };
  }
  /** Retry only the outcome transaction, never the transport. The attempt guard also makes a lost commit reply safe. */
  async function record(reservation: SmsReservation, next: Exclude<SmsDeliveryState, 'sending'>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await scope(reservation.gymId, tx => tx.update(smsDeliveries).set({ state: next, updatedAt: clock.now() })
          .where(and(eq(smsDeliveries.id, reservation.id), eq(smsDeliveries.attempts, reservation.attempts),
            eq(smsDeliveries.state, 'sending'))));
        return;
      } catch {
        if (attempt === 2) throw new Error('SMS outcome write failed');
      }
    }
  }
  /** Calls the transport for a committed reservation and records the outcome. A message builder that throws releases the
   * reservation, since nothing reached the transport. */
  async function attempt(reservation: SmsReservation, sms: Sms,
    message: SmsMessage | (() => SmsMessage | Promise<SmsMessage>)): Promise<SmsResult> {
    assertNoTransaction('sms.deliveries.send');
    let built: SmsMessage;
    try {
      built = typeof message === 'function' ? await message() : message;
    } catch {
      try { await release(reservation); }
      catch { throw new DeliveryError('not_accepted', 'SMS message could not be built or released'); }
      throw new DeliveryError('not_accepted', 'SMS message could not be built');
    }
    let result: SmsResult;
    try {
      result = await sms.sendSms(built);
    } catch (error) {
      try { await record(reservation, deliveryAcceptance(error) === 'not_accepted' ? 'not_accepted' : 'unknown'); }
      catch { throw new DeliveryError(deliveryAcceptance(error), 'SMS delivery outcome could not be recorded'); }
      // An SmsDeliveryError carries only a fixed message and its reason (such as recipient_opted_out); anything else is replaced.
      throw error instanceof SmsDeliveryError ? error : new DeliveryError(deliveryAcceptance(error), 'SMS delivery failed');
    }
    try { await record(reservation, result.status === 'sent' ? 'accepted' : 'not_accepted'); }
    catch { throw new DeliveryError(result.status === 'sent' ? 'unknown' : 'not_accepted', 'SMS delivery outcome could not be recorded'); }
    return result;
  }
  /** Rejects with a `not_accepted` DeliveryError whenever this call did not reach the transport. */
  async function send(gymId: string, key: string, sms: Sms, message: SmsMessage): Promise<RecordedSmsResult> {
    assertNoTransaction('sms.deliveries.send');
    let reserved: Awaited<ReturnType<typeof claim>>;
    try {
      reserved = await scope(gymId, tx => claim(tx, gymId, key));
    } catch {
      throw new DeliveryError('not_accepted', 'SMS delivery could not be reserved');
    }
    if ('inFlight' in reserved) throw new DeliveryError('not_accepted', 'Another attempt is sending this sms');
    if ('skipped' in reserved) return { status: 'skipped', state: reserved.skipped };
    return attempt({ gymId, ...reserved }, sms, message);
  }
  /**
   * What a send command already did. Returns its remembered result when it was accepted or may have been, and nothing when
   * it hasn't run or was definitely not sent (run it). A generation used for another request, or an attempt still in flight,
   * is a conflict.
   */
  async function replay(tx: Transaction, gymId: string, key: string, digest: string): Promise<{ result: unknown; outcome?: 'unknown' } | undefined> {
    validKey(key);
    const [row] = await tx.select().from(smsDeliveries).where(and(eq(smsDeliveries.gymId, gymId), eq(smsDeliveries.key, key)));
    if (!row) return undefined;
    if (row.commandDigest !== digest) throw otherRequest();
    const current = settled(row);
    if (current === 'sending') throw stillSending();
    return current === 'not_accepted' ? undefined : { result: row.commandResult, ...(current === 'unknown' ? { outcome: 'unknown' as const } : {}) };
  }
  /** Reserves a key in the credential transaction. Commands pass their digest after `replay`; losing a race is a conflict.
   * Persisted notices omit the digest and get nothing when an earlier attempt was accepted or uncertain. */
  async function reserve(tx: Transaction, gymId: string, key: string, digest: string): Promise<SmsReservation>;
  async function reserve(tx: Transaction, gymId: string, key: string): Promise<SmsReservation | undefined>;
  async function reserve(tx: Transaction, gymId: string, key: string, digest?: string): Promise<SmsReservation | undefined> {
    const reserved = await claim(tx, gymId, key, digest);
    // A persisted notice has no client command to replay; accepted or uncertain means its work is finished.
    if ('skipped' in reserved && digest === undefined) return undefined;
    if ('inFlight' in reserved || 'skipped' in reserved) throw stillSending();
    return { gymId, ...reserved };
  }
  /** Stores what a replay returns: identifiers and metadata only, never a credential. */
  async function remember(tx: Transaction, reservation: SmsReservation, result: unknown): Promise<void> {
    await tx.update(smsDeliveries).set({ commandResult: result }).where(eq(smsDeliveries.id, reservation.id));
  }
  /** The attempt never reached the transport, so nothing was sent and the command can run again. */
  async function release(reservation: SmsReservation): Promise<void> {
    await record(reservation, 'not_accepted');
  }
  return { state, send, replay, reserve, remember, attempt, release };
}
export type SmsDeliveries = ReturnType<typeof createSmsDeliveries>;
