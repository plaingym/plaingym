// SPDX-License-Identifier: AGPL-3.0-only
import { setupTimezoneSchema } from '@plaingym/shared/contracts';

/**
 * The browser's zone for the wizard's timezone field, or `UTC` when it reports none or one the gym step's request
 * schema refuses (an unknown zone, or one without a region such as `CET`).
 */
export function hostTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return setupTimezoneSchema.safeParse(zone).success ? zone : 'UTC';
  } catch { return 'UTC'; }
}
