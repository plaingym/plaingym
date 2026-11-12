// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, like, lte, ne, notLike, or } from 'drizzle-orm';
import { emailDeliveries, forGym, uuidv7, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';
import type { JobRegistration } from '../../core/registry.js';
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
/** Marks a keyed command digest, so the upkeep job can tell it from an unkeyed one written by an earlier release. */
export const keyedDigestPrefix = 'k1:';
/**
 * `commandDigest` keyed with a secret the install already holds (`AUTH_SECRET`), for a request that names a member's
 * address: without the secret, a stored digest can't be tested against a guessed address, in the database or a backup.
 */
export function createKeyedCommandDigest(secret: string) {
  const key = Buffer.from(hkdfSync('sha256', secret, new Uint8Array(0), 'plaingym email command digest v1', 32));
  return (request: readonly unknown[]) => keyedDigestPrefix + createHmac('sha256', key).update(JSON.stringify(request)).digest('base64url');
}
/** A key an earlier release wrote for one member recipient: the notice's key followed by `:` and a `recipientDigest`. */
const legacyRecipientKey = /^(.+):[0-9a-f]{64}$/;
/** The member notices whose keys an earlier release wrote per recipient (billing receipts and dunning notices). */
const memberNoticeKeyPrefixes = ['billing.receipt:', 'billing.dunning:'];
/** Each login link's key (`infra/auth/delivery.ts`); the upkeep sweeps them once the link has expired. */
export const loginLinkKeyPrefix = 'auth.login_link:';
/** Emailed portal invitations (`areas/members/household-users.invitations.ts`), whose digest names the invitee's address. */
export const portalInvitationKeyPrefix = 'portal.invitation:';
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');
const legacyLike = (key: string) => escapeLike(key) + ':' + '_'.repeat(64);
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
  async function state(gymId: string, key: string): Promise<EmailDeliveryState | undefined>;
  async function state(tx: Transaction, gymId: string, key: string): Promise<EmailDeliveryState | undefined>;
  async function state(txOrGym: Transaction | string, gymOrKey: string, transactionKey?: string): Promise<EmailDeliveryState | undefined> {
    if (typeof txOrGym === 'string') return scope(txOrGym, tx => state(tx, txOrGym, gymOrKey));
    const tx = txOrGym, gymId = gymOrKey, key = transactionKey!;
    validKey(key);
    const [row] = await tx.select({ state: emailDeliveries.state, updatedAt: emailDeliveries.updatedAt })
      .from(emailDeliveries).where(and(eq(emailDeliveries.gymId, gymId), eq(emailDeliveries.key, key)));
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
  /** Only this attempt's reservation may be resolved. Failed writes are visible to the caller. */
  const record = (reservation: EmailReservation, next: Exclude<EmailDeliveryState, 'sending'>) =>
    scope(reservation.gymId, tx => tx.update(emailDeliveries).set({ state: next, updatedAt: clock.now() })
      .where(and(eq(emailDeliveries.id, reservation.id), eq(emailDeliveries.attempts, reservation.attempts),
        eq(emailDeliveries.state, 'sending'))));
  /** Calls the transport for a committed reservation and records the outcome. A message builder that throws releases the
   * reservation, since nothing reached the transport. */
  async function attempt(reservation: EmailReservation, email: Email,
    message: EmailMessage | (() => EmailMessage | Promise<EmailMessage>)): Promise<EmailResult> {
    assertNoTransaction('email.deliveries.send');
    let built: EmailMessage;
    try {
      built = typeof message === 'function' ? await message() : message;
    } catch (error) {
      await release(reservation);
      throw error;
    }
    let result: EmailResult;
    try {
      result = await email.sendEmail(built);
    } catch (error) {
      try { await record(reservation, deliveryAcceptance(error) === 'not_accepted' ? 'not_accepted' : 'unknown'); }
      catch (cause) { throw new DeliveryError(deliveryAcceptance(error), 'Email delivery outcome could not be recorded', { cause }); }
      throw error;
    }
    try { await record(reservation, result.status === 'sent' ? 'accepted' : 'not_accepted'); }
    catch (cause) { throw new DeliveryError(result.status === 'sent' ? 'unknown' : 'not_accepted', 'Email delivery outcome could not be recorded', { cause }); }
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
  async function replay(tx: Transaction, gymId: string, key: string, digest: string): Promise<{ result: unknown; outcome?: 'unknown' } | undefined> {
    validKey(key);
    const [row] = await tx.select().from(emailDeliveries).where(and(eq(emailDeliveries.gymId, gymId), eq(emailDeliveries.key, key)));
    if (!row) return undefined;
    if (row.commandDigest !== digest) throw otherRequest();
    const current = settled(row);
    if (current === 'sending') throw stillSending();
    return current === 'not_accepted' ? undefined : { result: row.commandResult, ...(current === 'unknown' ? { outcome: 'unknown' as const } : {}) };
  }
  /** Reserves a key in the credential transaction. Commands pass their digest after `replay`; losing a race is a conflict.
   * Persisted notices omit the digest and get nothing when an earlier attempt was accepted or uncertain. */
  async function reserve(tx: Transaction, gymId: string, key: string, digest: string): Promise<EmailReservation>;
  async function reserve(tx: Transaction, gymId: string, key: string): Promise<EmailReservation | undefined>;
  async function reserve(tx: Transaction, gymId: string, key: string, digest?: string): Promise<EmailReservation | undefined> {
    const reserved = await claim(tx, gymId, key, digest);
    // A persisted notice has no client command to replay; accepted or uncertain means its work is finished.
    if ('skipped' in reserved && digest === undefined) return undefined;
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
  const rank = (row: { state: string; updatedAt: Date }) => {
    const current = settled(row);
    return current === 'accepted' ? 3 : current === 'not_accepted' ? 1 : 2;
  };
  /**
   * Moves a notice's per-recipient rows from an earlier release (`<key>:<recipientDigest>`) under `key`, in the caller's
   * transaction. It keeps the row that decides the most (accepted, then possibly sent or still in flight, then not accepted)
   * and deletes the others, so a retry of the notice still finds what was sent and no digest of the address stays behind.
   */
  async function adopt(tx: Transaction, gymId: string, key: string): Promise<void> {
    validKey(key);
    const rows = await tx.select().from(emailDeliveries).where(and(eq(emailDeliveries.gymId, gymId),
      or(eq(emailDeliveries.key, key), like(emailDeliveries.key, legacyLike(key))))).orderBy(asc(emailDeliveries.id)).for('update');
    const legacy = rows.filter(row => row.key !== key && legacyRecipientKey.exec(row.key)?.[1] === key);
    if (!legacy.length) return;
    const best = legacy.reduce((kept, row) => rank(row) > rank(kept) ? row : kept);
    const current = rows.find(row => row.key === key);
    // The current row decides, unless an earlier row decides more (it was sent, or may have been while the current wasn't).
    const keep = current && rank(current) >= rank(best) ? current : best;
    const drop = [...(current ? [current] : []), ...legacy].filter(row => row.id !== keep.id).map(row => row.id);
    if (drop.length) await tx.delete(emailDeliveries).where(inArray(emailDeliveries.id, drop));
    if (keep.key !== key) await tx.update(emailDeliveries).set({ key }).where(eq(emailDeliveries.id, keep.id));
  }
  /**
   * The hourly upkeep (`createEmailDeliveryJobs`), in short transactions. It deletes login-link rows once their link has
   * expired, clears the unkeyed portal invitation digests an earlier release stored, and adopts the per-recipient member
   * notice keys an earlier release wrote. Every other row stays. Returns the counts, for tests.
   */
  async function upkeep(gymId: string, batch = 500) {
    const settledBefore = new Date(clock.now().getTime() - emailInFlightMs);
    // A login link lives five minutes, so once no attempt can still be in flight its key guards nothing.
    const swept = await scope(gymId, tx => tx.delete(emailDeliveries).where(and(eq(emailDeliveries.gymId, gymId),
      like(emailDeliveries.key, escapeLike(loginLinkKeyPrefix) + '%'), lte(emailDeliveries.updatedAt, settledBefore)))
      .returning({ id: emailDeliveries.id }));
    // A replay of such an invitation's generation is refused as another request; a deliberate resend has a new one.
    const cleared = await scope(gymId, tx => tx.update(emailDeliveries).set({ commandDigest: null }).where(and(
      eq(emailDeliveries.gymId, gymId), like(emailDeliveries.key, escapeLike(portalInvitationKeyPrefix) + '%'),
      isNotNull(emailDeliveries.commandDigest), notLike(emailDeliveries.commandDigest, escapeLike(keyedDigestPrefix) + '%'),
      or(ne(emailDeliveries.state, 'sending'), lte(emailDeliveries.updatedAt, settledBefore)))).returning({ id: emailDeliveries.id }));
    let adopted = 0;
    for (let cursor: string | undefined; ;) {
      const after = cursor;
      const rows = await scope(gymId, tx => tx.select({ id: emailDeliveries.id, key: emailDeliveries.key }).from(emailDeliveries)
        .where(and(eq(emailDeliveries.gymId, gymId), or(...memberNoticeKeyPrefixes.map(prefix =>
          like(emailDeliveries.key, escapeLike(prefix) + '%:%:' + '_'.repeat(64)))), after ? gt(emailDeliveries.id, after) : undefined))
        .orderBy(asc(emailDeliveries.id)).limit(batch));
      const targets = new Set(rows.flatMap(row => legacyRecipientKey.exec(row.key)?.[1] ?? []));
      for (const target of targets) await scope(gymId, tx => adopt(tx, gymId, target));
      adopted += targets.size;
      if (rows.length < batch) break;
      cursor = rows.at(-1)!.id;
    }
    return { swept: swept.length, cleared: cleared.length, adopted };
  }
  return { state, send, replay, reserve, remember, attempt, release, adopt, upkeep };
}
export type EmailDeliveries = ReturnType<typeof createEmailDeliveries>;

export const emailDeliveryUpkeepJob = 'email.deliveries.upkeep';
/** Each gym's delivery records get the upkeep once an hour (`upkeep`, above). The runtime registers it. */
export function createEmailDeliveryJobs(deliveries?: Pick<EmailDeliveries, 'upkeep'>): readonly JobRegistration[] {
  return [{ id: emailDeliveryUpkeepJob, cron: '17 * * * *', async handler(_payload, context) {
    await (deliveries ?? createEmailDeliveries({ clock: context.clock })).upkeep(context.gymId);
  } }];
}
