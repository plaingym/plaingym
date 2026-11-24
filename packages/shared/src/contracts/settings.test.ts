// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { gyms } from '../../../db/src/schema/index.js';
import {
  gymBrandingSchema, setupGymDetailsSchema, gymSettingsSchema, gymTimezoneSchema, setupTimezoneSchema,
  updateGymSettingsRequestSchema, updateBookingRulesRequestSchema, updateBankDebitsRequestSchema,
  updateGymCurrencyRequestSchema, updateGoLiveRequestSchema, updateDropInSettingsRequestSchema, settingsContracts,
  errorResponse, AppError, type GymSettings, type BookingRules, type GoLiveSwitches,
} from './index.js';
import { canStaff, staffRoles } from '../permissions.js';

const settings = {
  id: '019a08bf-1234-7000-8000-000000000001', name: 'The Gym', slug: 'the-gym', timezone: 'America/Vancouver',
  address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null, currency: 'CAD',
  bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, billingEnabled: false, memberEmailsEnabled: false, memberSmsEnabled: false, smsDailyCap: 1000, retryDays: [3, 7], dropInChargeTypeId: null,
  bankDebitsEnabled: false, revision: 1, createdAt: '2026-10-21T20:00:00Z', updatedAt: '2026-10-21T20:00:00Z',
};

describe('gym settings contracts', () => {
  it('requires the SMS switch and cap in settings replies and the switch in go-live replies', () => {
    for (const field of ['memberSmsEnabled', 'smsDailyCap']) {
      const missing = { ...settings } as Record<string, unknown>;
      delete missing[field];
      expect(gymSettingsSchema.safeParse(missing).success).toBe(false);
    }
    expect(settingsContracts.goLiveChecklist.response.safeParse({ data: {
      revision: 1, billingEnabled: false, memberEmailsEnabled: false, items: [],
    } }).success).toBe(false);
    expect(updateGoLiveRequestSchema.parse({ revision: 1, memberEmailsEnabled: true })).toEqual({ revision: 1, memberEmailsEnabled: true });
  });
  it('returns the same go-live checklist after reads and saves, including billing readiness', () => {
    const response = { data: { revision: 2, billingEnabled: false, memberEmailsEnabled: true, memberSmsEnabled: false,
      items: [{ id: 'webhook_ready', status: 'ready', message: 'Ready' },
        { id: 'reconciliation_complete', status: 'needs_attention', message: 'Resolve pending items' }] } };
    expect(settingsContracts.updateGoLive.response).toBe(settingsContracts.goLiveChecklist.response);
    expect(settingsContracts.updateGoLive.response.parse(response)).toEqual(response);
  });
  it('projects only existing, non-secret gym columns', () => {
    expect(gymSettingsSchema.parse(settings)).toEqual(settings);
    expect(settingsContracts.get.response.parse({ data: settings }).data.bankDebitsEnabled).toBe(false);
    type Row = typeof gyms.$inferSelect;
    expectTypeOf<Omit<GymSettings, 'createdAt' | 'updatedAt'>>().toExtend<
      Pick<Row, Exclude<keyof GymSettings, 'createdAt' | 'updatedAt'>>>();
    expectTypeOf<BookingRules>().toEqualTypeOf<Pick<Row, 'bookingWindowDays' | 'cancellationCutoffMinutes' | 'openMatCountsAsClass'>>();
    expectTypeOf<GoLiveSwitches>().toEqualTypeOf<Pick<Row, 'billingEnabled' | 'memberEmailsEnabled' | 'memberSmsEnabled'>>();
  });
  it.each(['stripeConfig', 'smtpConfig', 's3Config', 'qrKey', 'backupBlobKey', 'settings', 'pinHash', 'tokenHash'])(
    'rejects secret or opaque field %s instead of returning it', (field) => {
      expect(gymSettingsSchema.safeParse({ ...settings, [field]: 'hidden' }).success).toBe(false);
      expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, name: 'New', [field]: 'hidden' }).success).toBe(false);
    },
  );
  it('requires revisions on each settings edit and keeps switches/currency out of the general patch', () => {
    for (const [schema, body] of [
      [updateGymSettingsRequestSchema, { name: 'New' }],
      [updateBookingRulesRequestSchema, { bookingWindowDays: 0 }],
      [updateGymCurrencyRequestSchema, { currency: 'CAD' }],
      [updateDropInSettingsRequestSchema, { dropInChargeTypeId: null }],
      [updateGoLiveRequestSchema, { billingEnabled: true }],
      [updateBankDebitsRequestSchema, { bankDebitsEnabled: true }],
    ] as const) {
      expect(schema.safeParse(body).success).toBe(false);
      expect(schema.safeParse({ ...body, revision: 1 }).success).toBe(true);
      expect(schema.safeParse({ ...body, revision: -1 }).success).toBe(false);
    }
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, currency: 'USD' }).success).toBe(false);
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, billingEnabled: true }).success).toBe(false);
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, name: 'New', bankDebitsEnabled: true }).success).toBe(false);
    expect(updateBankDebitsRequestSchema.safeParse({ revision: 1, bankDebitsEnabled: true, billingEnabled: true }).success).toBe(false);
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1 }).success).toBe(false);
    // The drop-in setting names a charge type; there is no separate price, and the general patch can't set it.
    expect(updateDropInSettingsRequestSchema.safeParse({ revision: 1 }).success).toBe(false);
    expect(updateDropInSettingsRequestSchema.safeParse({ revision: 1, dropInChargeTypeId: 'drop-in' }).success).toBe(false);
    expect(updateDropInSettingsRequestSchema.safeParse({ revision: 1, dropInChargeTypeId: null, amountCents: 2500 }).success).toBe(false);
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, dropInChargeTypeId: null }).success).toBe(false);
    // Freshness and referenced-currency checks happen atomically in the service.
    expect(errorResponse(new AppError('conflict', 'Reload before saving.'), 'request').error.code).toBe('conflict');
  });
  it('validates booking bounds, timezone, and HTTP URLs without coercing inputs', () => {
    expect(updateBookingRulesRequestSchema.parse({ revision: 1, cancellationCutoffMinutes: 0 }).cancellationCutoffMinutes).toBe(0);
    for (const bookingWindowDays of [-1, 1.5, '14', 2_147_483_648]) {
      expect(updateBookingRulesRequestSchema.safeParse({ revision: 1, bookingWindowDays }).success).toBe(false);
    }
    expect(gymSettingsSchema.safeParse({ ...settings, timezone: 'not/a-zone' }).success).toBe(false);
    expect(gymSettingsSchema.safeParse({ ...settings, existingSiteUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(gymSettingsSchema.safeParse({ ...settings, currency: 'cad' }).success).toBe(false);
    expect(gymSettingsSchema.parse({ ...settings, existingSiteUrl: 'https://example.com' }).existingSiteUrl).toBe('https://example.com');
  });
  it('validates a new timezone with the shared rule and stores its canonical name', () => {
    const request = (timezone: unknown) => updateGymSettingsRequestSchema.safeParse({ revision: 1, timezone });
    // A region and `UTC` are stored as they are; the request schema is the shared rule, not `Intl`'s broad list.
    for (const zone of ['America/Vancouver', 'UTC']) expect(request(zone)).toMatchObject({ success: true, data: { timezone: zone } });
    // Case variants become the canonical spelling, so equal zones compare equal as strings.
    expect(request('america/vancouver')).toMatchObject({ success: true, data: { timezone: 'America/Vancouver' } });
    expect(request('utc')).toMatchObject({ success: true, data: { timezone: 'UTC' } });
    expect(gymTimezoneSchema.parse('AMERICA/VANCOUVER')).toBe('America/Vancouver');
    // Spaces around a pasted zone are dropped, so setup, settings and `gyms create` accept the same input.
    expect(gymTimezoneSchema.parse(' America/Vancouver\t')).toBe('America/Vancouver');
    expect(setupTimezoneSchema.parse(' utc ')).toBe('UTC');
    expect(request('   ').success).toBe(false);
    // Current names are kept, though `Intl` resolves them to retired ones (`Asia/Calcutta`, `Europe/Kiev`); a link stays as given.
    for (const [typed, stored] of [['asia/kolkata', 'Asia/Kolkata'], ['Europe/Kyiv', 'Europe/Kyiv'], ['America/Nuuk', 'America/Nuuk'], ['us/pacific', 'US/Pacific']] as const)
      expect(gymTimezoneSchema.parse(typed)).toBe(stored);
    // The sign of `Etc/GMT±N` is inverted and every offset has a region form, so it is refused in any case.
    for (const zone of ['Etc/GMT+5', 'Etc/GMT-5', 'etc/gmt+5', 'Etc/GMT-14', 'Etc/GMT+0']) expect(request(zone).success).toBe(false);
    // Abbreviations, unknown names, offsets and non-strings are refused, with the rule's message on the field.
    for (const zone of ['PST', 'CET', 'EST5EDT', 'Mars/Olympus', '+01:00', '', 5, null]) {
      const result = request(zone);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.every((issue) => issue.path[0] === 'timezone')).toBe(true);
    }
    const refused = gymTimezoneSchema.safeParse('PST');
    expect(!refused.success && refused.error.issues.map((issue) => issue.message)).toEqual(['Use UTC or a region such as America/Vancouver']);
    // `timezone` stays optional, so a general save that leaves it out keeps a stored zone such as `CET`.
    expect(updateGymSettingsRequestSchema.parse({ revision: 1, name: 'New' })).toEqual({ revision: 1, name: 'New' });
    expect(gymSettingsSchema.parse({ ...settings, timezone: 'CET' }).timezone).toBe('CET');
  });
  it('requires a supported region on new or changed gym countries while keeping stored countries readable', () => {
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, address: { country: 'UK' } }).success).toBe(false);
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, address: { country: 'GB' } }).success).toBe(true);
    expect(gymSettingsSchema.parse({ ...settings, address: { country: 'UK' } }).address.country).toBe('UK');
    const setupDetails = { name: 'Gym', timezone: 'UTC', currency: 'USD', address: { country: 'UK' }, branding: { logoKey: null, primaryColor: null }, revision: 1 };
    expect(setupGymDetailsSchema.safeParse(setupDetails).success).toBe(false);
    expect(setupGymDetailsSchema.safeParse({ ...setupDetails, address: { country: 'GB' } }).success).toBe(true);
  });
  it.each(Object.entries(settingsContracts))('%s applies its declared staff capability', (_operation, contract) => {
    const ownerOnly = contract.permission.capability === 'ownership.transfer' || contract.permission.capability === 'integrations.manage';
    for (const role of staffRoles) expect(canStaff([role], contract.permission.capability)).toBe((ownerOnly ? ['owner'] : ['owner', 'admin']).includes(role));
  });
});

describe('settings response validation', () => {
  it('accepts the same null brand color in setup and settings', () => {
    const branding = { logoKey: null, primaryColor: null };
    const details = { name: 'Gym', timezone: 'UTC', currency: 'USD', address: {}, branding, revision: 1 };
    expect(setupGymDetailsSchema.parse(details).branding).toEqual(gymBrandingSchema.parse(branding));
    expect(gymBrandingSchema.safeParse({ primaryColor: '#12345g' }).success).toBe(false);
  });
});
