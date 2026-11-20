// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { storedTimezoneSchema } from '@plaingym/shared/contracts';
import { assertStoredTimezone } from './timezone.js';

it('accepts exactly the stored timezone schema zones and refuses the rest with its message', () => {
  for (const zone of ['UTC', 'America/Vancouver', 'CET', 'Etc/GMT+5', 'Asia/Calcutta']) {
    expect(storedTimezoneSchema.safeParse(zone).success, zone).toBe(true);
    expect(() => assertStoredTimezone(zone), zone).not.toThrow();
  }
  for (const zone of ['Not/AZone', '', ' America/Vancouver', 'America/Vancouver ']) {
    expect(storedTimezoneSchema.safeParse(zone).success, zone).toBe(false);
    expect(() => assertStoredTimezone(zone), zone).toThrow('Use a supported IANA timezone');
  }
});
