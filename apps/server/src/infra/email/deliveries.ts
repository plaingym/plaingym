// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { emailDeliveries, forGym, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';
import { DeliveryError, deliveryAcceptance, type Email, type EmailMessage, type EmailResult } from './index.js';

/** `sending` is an attempt in flight; once older than the in-flight window it reads as `unknown`. */
export type EmailDeliveryState = 'sending' | 'accepted' | 'unknown' | 'not_accepted';
/** `skipped` means an earlier attempt under the key was accepted or may have been; nothing was sent. */
export type RecordedEmailResult = EmailResult | { status: 'skipped'; state: 'accepted' | 'unknown' };
/** Twice the SMTP transport's hard session deadline (`smtpSessionLimitMs`), so a `sending` row this old has finished. */
export const emailInFlightMs = 10 * 60_000;

function validKey(key: string): void {
  if (key.length < 1 || key.length > 300 || /[\r\n\0]/.test(key)) throw new Error('Invalid email delivery key');
}

/**
 * At most one message per key can reach a recipient. An attempt is reserved as `sending` and committed before the
 * transport is called, so a crash, lost reply or lost outcome write never permits a resend; only a definite non-send
 * (`not_accepted`: suppressed, or a DeliveryError proving no recipient got it) can be attempted again.
 * Keys hold identifiers only, never readable personal data.
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
  /** Rejects with a `not_accepted` DeliveryError whenever this call did not reach the transport. */
  async function send(gymId: string, key: string, email: Email, message: EmailMessage): Promise<RecordedEmailResult> {
    assertNoTransaction('email.deliveries.send');
    let reserved: { id: string; attempts: number } | { skipped: 'accepted' | 'unknown' } | { inFlight: true };
    try {
      validKey(key);
      reserved = await scope(gymId, async tx => {
        const now = clock.now();
        const [created] = await tx.insert(emailDeliveries).values({ id: uuidv7(now.getTime()), gymId, key, state: 'sending',
          attempts: 1, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: [emailDeliveries.gymId, emailDeliveries.key] })
          .returning({ id: emailDeliveries.id, attempts: emailDeliveries.attempts });
        if (created) return created;
        const [row] = await tx.select().from(emailDeliveries)
          .where(and(eq(emailDeliveries.gymId, gymId), eq(emailDeliveries.key, key))).for('update');
        if (!row) throw new Error('Email delivery reservation vanished');
        const current = settled(row);
        // Another attempt may still be talking to SMTP; its outcome decides, so retry later instead of skipping.
        if (current === 'sending') return { inFlight: true as const };
        if (current !== 'not_accepted') return { skipped: current as 'accepted' | 'unknown' };
        await tx.update(emailDeliveries).set({ state: 'sending', attempts: row.attempts + 1, updatedAt: now })
          .where(eq(emailDeliveries.id, row.id));
        return { id: row.id, attempts: row.attempts + 1 };
      });
    } catch (error) {
      throw new DeliveryError('not_accepted', 'Email delivery could not be reserved', { cause: error });
    }
    if ('inFlight' in reserved) throw new DeliveryError('not_accepted', 'Another attempt is sending this email');
    if ('skipped' in reserved) return { status: 'skipped', state: reserved.skipped };
    const { id, attempts } = reserved;
    // Only this attempt's reservation may be resolved. A failed write leaves `sending`, which turns `unknown`: safe.
    const record = (next: Exclude<EmailDeliveryState, 'sending'>) => scope(gymId, tx => tx.update(emailDeliveries)
      .set({ state: next, updatedAt: clock.now() }).where(and(eq(emailDeliveries.id, id),
        eq(emailDeliveries.attempts, attempts), eq(emailDeliveries.state, 'sending')))).catch(() => undefined);
    let result: EmailResult;
    try {
      result = await email.sendEmail(message);
    } catch (error) {
      await record(deliveryAcceptance(error) === 'not_accepted' ? 'not_accepted' : 'unknown');
      throw error;
    }
    await record(result.status === 'sent' ? 'accepted' : 'not_accepted');
    return result;
  }
  return { state, send };
}
export type EmailDeliveries = ReturnType<typeof createEmailDeliveries>;
