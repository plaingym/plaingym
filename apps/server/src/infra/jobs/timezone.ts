// SPDX-License-Identifier: AGPL-3.0-only
import { storedTimezoneSchema } from '@plaingym/shared/contracts';

/** Both queues store this zone in the job envelope, so they accept exactly the zones that readers can use. */
export function assertStoredTimezone(zone: string): void {
  if (!storedTimezoneSchema.safeParse(zone).success) throw new Error('Use a supported IANA timezone');
}
