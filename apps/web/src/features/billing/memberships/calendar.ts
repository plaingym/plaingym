// SPDX-License-Identifier: AGPL-3.0-only
import { addDays } from '@plaingym/shared/time';
import type { Membership } from '@plaingym/shared/contracts';

/** The billing day in the month `months` after `date`'s, clamped to that month's last day. */
function onBillingDay(date: string, months: number, billingDay: number) {
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  const first = String(Math.floor(index / 12)).padStart(4, '0') + '-' + String(index % 12 + 1).padStart(2, '0') + '-01';
  const last = addDays(onFirstOfNextMonth(first), -1);
  const day = addDays(first, billingDay - 1);
  return day > last ? last : day;
}
const onFirstOfNextMonth = (first: string) => addDays(first, 32).slice(0, 8) + '01';

/** The next billing date the server expects when a member joins a household (mirrors the membership service). */
export function householdBillingDate(startsOn: string, household: readonly Membership[], billingDay: number) {
  const live = household.filter(row => row.status !== 'cancelled');
  if (!live.length) return startsOn;
  const shared = live.filter(row => row.interval === 'monthly' && (row.status === 'active' || row.status === 'pending'))
    .map(row => row.nextDueOn).sort().find(date => date >= startsOn);
  if (shared) return shared;
  const sameMonth = onBillingDay(startsOn, 0, billingDay);
  return sameMonth >= startsOn ? sameMonth : onBillingDay(startsOn, 1, billingDay);
}
