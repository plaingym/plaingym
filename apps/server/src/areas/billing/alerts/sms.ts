// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { forGym, memberships, paymentMethods, type Transaction } from '@plaingym/db';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../../core/clock.js';
import { createBillingSmsSender, type BillingSmsOptions } from '../transitions/notifications.sms.js';
import { needsCardExpiryAlert } from './index.js';

/** Passed to createBillingAlerts; shares its scan and send job, with independent delivery state and links. */
export function createCardExpirySms(options: BillingSmsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, send = createBillingSmsSender(options);
  async function candidate(tx: Transaction, id: string, timezone: string) {
    const [card] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.id, id),
      eq(paymentMethods.isDefault, true), isNull(paymentMethods.revokedAt)));
    if (!card) return;
    const [membership] = await tx.select({ cycle: memberships.nextDueOn }).from(memberships).where(and(
      eq(memberships.householdId, card.householdId), inArray(memberships.status, ['active', 'trial', 'pending']),
      gt(memberships.amountCents, 0))).orderBy(asc(memberships.nextDueOn)).limit(1);
    if (membership && needsCardExpiryAlert(card, membership.cycle, localDate(clock.now(), timezone)))
      return { card, cycle: membership.cycle };
  }
  return {
    async enabled(gymId: string) { return (await options.settings.get(gymId)).memberSmsEnabled; },
    async send(gymId: string, paymentMethodId: string, cycle: string) {
      const gym = await options.settings.get(gymId);
      if (!gym.memberSmsEnabled) return;
      const loaded = await scope(gymId, tx => candidate(tx, paymentMethodId, gym.timezone));
      if (!loaded || loaded.cycle !== cycle) return;
      await send({ gymId, householdId: loaded.card.householdId,
        key: first => `billing.alert.sms.card_expiry:${paymentMethodId}:${cycle}:${first}`,
        eligible: async tx => {
          const current = await candidate(tx, paymentMethodId, gym.timezone);
          return current?.cycle === cycle && current.card.householdId === loaded.card.householdId;
        },
        links: () => [{ purpose: 'update_card', householdId: loaded.card.householdId,
          expiresAt: zonedInstant(addDays(cycle, 7), '09:00', gym.timezone, { gap: 'shift' })!.toISOString() }],
        body: (t, urls) => t('billing/sms:cardExpiry', { dueOn: cycle, updateUrl: urls[0] ?? '' }),
      });
    },
  };
}
export type CardExpirySms = ReturnType<typeof createCardExpirySms>;
