// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, localDate } from '@plaingym/shared/time';

/** An admission remains valid through the next calendar day in the gym's timezone. */
export function joinAdmissionExpired(joinedOn: string, now: Date, timezone: string) {
  return addDays(joinedOn, 1) < localDate(now, timezone);
}
