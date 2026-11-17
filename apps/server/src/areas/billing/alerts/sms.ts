// SPDX-License-Identifier: AGPL-3.0-only
import { forGym } from '@plaingym/db';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../../core/clock.js';
import { createBillingSmsSender, type BillingSmsOptions } from '../transitions/notifications.sms.js';
import { cardForCycle, smsCardKey } from './cards.query.js';

/** Passed to createBillingAlerts; its own send job has independent delivery state and links. */
export function createCardExpirySms(options: BillingSmsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, send = createBillingSmsSender(options);
  return {
    async enabled(gymId: string) { return (await options.settings.get(gymId)).memberSmsEnabled; },
    async send(gymId: string, paymentMethodId: string, cycle: string) {
      const gym = await options.settings.get(gymId);
      if (!gym.memberSmsEnabled) return;
      const loaded = await scope(gymId, tx => cardForCycle(tx, paymentMethodId, localDate(clock.now(), gym.timezone)));
      if (!loaded || loaded.cycle !== cycle) return;
      await send({ gymId, householdId: loaded.card.householdId,
        key: first => `${smsCardKey(paymentMethodId, cycle)}:${first}`,
        eligible: async tx => {
          const current = await cardForCycle(tx, paymentMethodId, localDate(clock.now(), gym.timezone));
          return current?.cycle === cycle && current.card.householdId === loaded.card.householdId;
        },
        links: () => [{ purpose: 'update_card', householdId: loaded.card.householdId,
          expiresAt: zonedInstant(addDays(cycle, 7), '09:00', gym.timezone, { gap: 'shift' })!.toISOString() }],
        body: (t, urls, locale) => t('billing/sms:cardExpiry', {
          dueOn: new Intl.DateTimeFormat(locale ?? 'en', { dateStyle: 'long', timeZone: gym.timezone })
            .format(zonedInstant(cycle, '12:00', gym.timezone, { gap: 'shift' })!), updateUrl: urls[0] ?? '',
        }),
      }, gym);
    },
  };
}
export type CardExpirySms = ReturnType<typeof createCardExpirySms>;
