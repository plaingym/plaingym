// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { smsDailyUsage, uuidv7, type Transaction } from '@plaingym/db';
import { localDate } from '@plaingym/shared/time';

/** Reserve before the provider. All attempts, including failures, consume their slot conservatively. */
export async function takeSmsSlot(tx: Transaction, gymId: string, now: Date, timezone: string, cap: number): Promise<boolean> {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('Invalid SMS daily cap');
  const day = localDate(now, timezone);
  await tx.insert(smsDailyUsage).values({ gymId, id: uuidv7(now.getTime()), day, createdAt: now })
    .onConflictDoNothing({ target: [smsDailyUsage.gymId, smsDailyUsage.day] });
  const [row] = await tx.select().from(smsDailyUsage).where(and(eq(smsDailyUsage.gymId, gymId), eq(smsDailyUsage.day, day))).for('update');
  if (!row) throw new Error('SMS usage unavailable');
  const allowed = row.sent < cap;
  await tx.update(smsDailyUsage).set(allowed ? { sent: row.sent + 1 } : { refused: row.refused + 1 }).where(eq(smsDailyUsage.id, row.id));
  return allowed;
}

/** Read-only: texts still allowed on a gym-local day, as `takeSmsSlot` decides (a slot is allowed while `sent < cap`). */
export async function remainingSmsSlots(tx: Transaction, gymId: string, day: string, cap: number): Promise<number> {
  const [row] = await tx.select({ sent: smsDailyUsage.sent }).from(smsDailyUsage)
    .where(and(eq(smsDailyUsage.gymId, gymId), eq(smsDailyUsage.day, day)));
  return Math.max(0, cap - (row?.sent ?? 0));
}
