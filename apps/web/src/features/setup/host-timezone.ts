// SPDX-License-Identifier: AGPL-3.0-only
import { gymTimezoneSchema } from '@plaingym/shared/contracts';

/** The browser's zone for the wizard's timezone field, or `UTC` when it reports none or one the gym schema refuses. */
export function hostTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return gymTimezoneSchema.safeParse(zone).success ? zone : 'UTC';
  } catch { return 'UTC'; }
}
