// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { memberships, paymentMethods, type Transaction } from '@plaingym/db';
import { addDays } from '@plaingym/shared/time';

/** The card text's job key; each recipient's delivery key appends its recipient ID. */
export const smsCardKey = (paymentMethodId: string, cycle: string) => `billing.alert.sms.card_expiry:${paymentMethodId}:${cycle}`;

/** Cards remain valid through their expiry month; billing dates are gym-local calendar dates. */
export function needsCardExpiryAlert(card: Pick<typeof paymentMethods.$inferSelect, 'expiryMonth' | 'expiryYear'>, cycle: string, today: string) {
  if (card.expiryMonth === null || card.expiryYear === null) return false;
  const expiresMonth = `${String(card.expiryYear).padStart(4, '0')}-${String(card.expiryMonth).padStart(2, '0')}`;
  return cycle.slice(0, 7) > expiresMonth && today >= addDays(cycle, -30) && today <= cycle;
}

/** Both channels recheck the same current default card and earliest payable membership cycle. */
export async function cardForCycle(tx: Transaction, paymentMethodId: string, today: string) {
  const [card] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.id, paymentMethodId),
    eq(paymentMethods.isDefault, true), isNull(paymentMethods.revokedAt)));
  if (!card) return;
  const [membership] = await tx.select({ cycle: memberships.nextDueOn }).from(memberships).where(and(
    eq(memberships.householdId, card.householdId), inArray(memberships.status, ['active', 'trial', 'pending']),
    gt(memberships.amountCents, 0))).orderBy(asc(memberships.nextDueOn)).limit(1);
  if (membership && needsCardExpiryAlert(card, membership.cycle, today)) return { card, cycle: membership.cycle };
}
