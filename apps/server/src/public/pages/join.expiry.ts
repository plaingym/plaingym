// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, localDate } from '@plaingym/shared/time';

/** An admission remains valid through the next calendar day in the gym's timezone. */
export function joinAdmissionExpired(joinedOn: string, now: Date, timezone: string) {
  return addDays(joinedOn, 1) < localDate(now, timezone);
}

/** Gym-local days a submitted join's first invoice stays payable. */
export const unpaidJoinDays = 7;
/** A join submitted on `submittedOn` (gym-local) is unpaid for good from the seventh calendar day after it. */
export function unpaidJoinExpired(submittedOn: string, now: Date, timezone: string) {
  return addDays(submittedOn, unpaidJoinDays) <= localDate(now, timezone);
}
