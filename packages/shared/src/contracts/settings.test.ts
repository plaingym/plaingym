// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { gyms } from '../../../db/src/schema/index.js';
import {
  gymSettingsSchema, updateGymSettingsRequestSchema, updateBookingRulesRequestSchema,
  updateGymCurrencyRequestSchema, updateGoLiveRequestSchema, settingsContracts,
  errorResponse, AppError, type GymSettings, type BookingRules, type GoLiveSwitches,
} from './index.js';
import { canStaff, staffRoles } from '../permissions.js';

const settings = {
  id: '019a08bf-1234-7000-8000-000000000001', name: 'The Gym', slug: 'the-gym', timezone: 'America/Vancouver',
  address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null, currency: 'CAD',
  bookingWindowDays: 14, cancellationCutoffMinutes: 60, billingEnabled: false, memberEmailsEnabled: false,
  revision: 1, createdAt: '2026-10-21T20:00:00Z', updatedAt: '2026-10-21T20:00:00Z',
};

describe('gym settings contracts', () => {
  it('returns the same go-live checklist after reads and saves, including billing readiness', () => {
    const response = { data: { revision: 2, billingEnabled: false, memberEmailsEnabled: true,
      items: [{ id: 'webhook_ready', status: 'ready', message: 'Ready' },
        { id: 'reconciliation_complete', status: 'needs_attention', message: 'Resolve pending items' }] } };
    expect(settingsContracts.updateGoLive.response).toBe(settingsContracts.goLiveChecklist.response);
    expect(settingsContracts.updateGoLive.response.parse(response)).toEqual(response);
  });
  it('projects only existing, non-secret gym columns', () => {
    expect(gymSettingsSchema.parse(settings)).toEqual(settings);
    type Row = typeof gyms.$inferSelect;
    expectTypeOf<Omit<GymSettings, 'createdAt' | 'updatedAt'>>().toExtend<
      Pick<Row, Exclude<keyof GymSettings, 'createdAt' | 'updatedAt'>>>();
    expectTypeOf<BookingRules>().toEqualTypeOf<Pick<Row, 'bookingWindowDays' | 'cancellationCutoffMinutes'>>();
    expectTypeOf<GoLiveSwitches>().toEqualTypeOf<Pick<Row, 'billingEnabled' | 'memberEmailsEnabled'>>();
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
      [updateGoLiveRequestSchema, { billingEnabled: true }],
    ] as const) {
      expect(schema.safeParse(body).success).toBe(false);
      expect(schema.safeParse({ ...body, revision: 1 }).success).toBe(true);
      expect(schema.safeParse({ ...body, revision: -1 }).success).toBe(false);
    }
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, currency: 'USD' }).success).toBe(false);
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1, billingEnabled: true }).success).toBe(false);
    expect(updateGymSettingsRequestSchema.safeParse({ revision: 1 }).success).toBe(false);
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
  it.each(Object.entries(settingsContracts))('%s allows managers and denies coaches/front desk', (_operation, contract) => {
    for (const role of staffRoles) expect(canStaff([role], contract.permission.capability)).toBe((contract.permission.capability === 'ownership.transfer' ? ['owner'] : ['owner', 'admin']).includes(role));
  });
});
