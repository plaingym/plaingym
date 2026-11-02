// SPDX-License-Identifier: AGPL-3.0-only
import { setupTimezoneSchema } from '@plaingym/shared/contracts';

/**
 * The browser's zone for the wizard's timezone field, or `UTC` (with `fallback` set) when it reports none or one the
 * gym step's request schema refuses (an unknown zone, or one without a region such as `CET`).
 */
export function hostTimezone(): { zone: string; fallback: boolean } {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (setupTimezoneSchema.safeParse(zone).success) return { zone, fallback: false };
  } catch { /* fall through to UTC */ }
  return { zone: 'UTC', fallback: true };
}
