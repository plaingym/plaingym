// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { kioskDevices, members } from '../../../db/src/schema/index.js';
import { canStaff, isRoutePermission } from '../permissions.js';
import {
  kioskCheckinResponseSchema, kioskContracts, kioskDeviceListResponseSchema, kioskDeviceResponseSchema,
  kioskDeviceSchema, kioskFamilyCheckinResponseSchema, kioskLookupRequestSchema, kioskLookupResponseSchema,
  kioskMemberIdentitySchema, kioskNamePinCheckinRequestSchema, kioskQrCheckinRequestSchema,
  registerKioskDeviceResponseSchema, type KioskDevice, type KioskMemberIdentity,
} from '@plaingym/shared/contracts';

const id = '019a08bf-1234-7000-8000-000000000001';
const otherId = '019a08bf-1234-7000-8000-000000000002';
const now = '2026-10-21T12:00:00Z';
const member = { id, firstName: 'Alex', lastInitial: 'S', photoUrl: null };
const device = { id, name: 'Reception tablet', createdAt: now, revokedAt: null, lastSeenAt: null };
const session = { id, name: 'Evening class', startsAt: now, endsAt: '2026-10-21T13:00:00Z' };
const safeResults = [
  { status: 'checked_in', member }, { status: 'already_checked_in', member },
  { status: 'select_session', member, sessions: [session] }, { status: 'see_front_desk' },
];

describe('kiosk privacy and device contracts', () => {
  it('shows the bearer token only in the registration response, never in reads or revocation', () => {
    expect(registerKioskDeviceResponseSchema.parse({ data: { device, token: 'opaque-bearer-token' } }).data.token).toBe('opaque-bearer-token');
    expect(registerKioskDeviceResponseSchema.safeParse({ data: { device } }).success).toBe(false);
    expect(registerKioskDeviceResponseSchema.safeParse({ data: { device, token: '' } }).success).toBe(false);
    expect(kioskDeviceResponseSchema.parse({ data: device }).data).toEqual(device);
    for (const secret of [{ token: 'secret' }, { tokenHash: 'a'.repeat(64) }]) {
      expect(kioskDeviceSchema.safeParse({ ...device, ...secret }).success).toBe(false);
      expect(kioskDeviceResponseSchema.safeParse({ data: { ...device, ...secret } }).success).toBe(false);
      expect(kioskDeviceListResponseSchema.safeParse({ data: [{ ...device, ...secret }], pagination: { limit: 50, offset: 0, total: 1 } }).success).toBe(false);
    }
    expect(kioskDeviceResponseSchema.parse({ data: { ...device, revokedAt: now } }).data.revokedAt).toBe(now);
    expect(kioskContracts.revokeDevice.response).toBe(kioskDeviceResponseSchema);
  });
  it('accepts only a first name, a Unicode last initial, and an optional photo for display', () => {
    for (const lastInitial of ['S', '张', 'ع', 'E\u0301', '𐐀']) expect(kioskMemberIdentitySchema.parse({ ...member, lastInitial }).lastInitial).toBe(lastInitial);
    for (const lastInitial of ['', 'Smith', '张三', 'S.']) expect(kioskMemberIdentitySchema.safeParse({ ...member, lastInitial }).success).toBe(false);
    for (const extra of [{ lastName: 'Smith' }, { photoKey: 'gym/members/key' }, { medicalNotes: 'private' }, { householdId: otherId }, { pinHash: 'secret' }, { checkinCodeHash: 'secret' }, { email: 'private@example.test' }, { status: 'active' }]) {
      expect(kioskMemberIdentitySchema.safeParse({ ...member, ...extra }).success).toBe(false);
      expect(kioskLookupResponseSchema.safeParse({ data: { status: 'select_member', members: [{ ...member, ...extra }] } }).success).toBe(false);
    }
  });
  it('closes every check-in outcome against financial details, medical notes, and free-text reasons', () => {
    for (const data of safeResults) {
      expect(kioskCheckinResponseSchema.parse({ data }).data).toEqual(data);
      for (const extra of [{ amountCents: 100 }, { currency: 'CAD' }, { balance: 100 }, { reason: 'past due' }, { message: 'Unpaid invoice' }, { medicalNotes: 'private' }, { tokenHash: 'secret' }]) {
        expect(kioskCheckinResponseSchema.safeParse({ data: { ...data, ...extra } }).success).toBe(false);
        expect(kioskCheckinResponseSchema.safeParse({ data, ...extra }).success).toBe(false);
      }
    }
    for (const status of ['past_due', 'missing_waiver', 'inactive', 'cancelled']) {
      expect(kioskCheckinResponseSchema.safeParse({ data: { status } }).success).toBe(false);
    }
    expect(kioskCheckinResponseSchema.safeParse({ data: { status: 'checked_in', member: { ...member, amountCents: 100 } } }).success).toBe(false);
    expect(kioskCheckinResponseSchema.safeParse({ data: { status: 'select_session', member, sessions: [{ ...session, notes: 'private' }] } }).success).toBe(false);
  });
  it('uses the same neutral response for unrecognized codes and all standing failures', () => {
    expect(kioskCheckinResponseSchema.parse({ data: { status: 'see_front_desk' } })).toEqual({ data: { status: 'see_front_desk' } });
    expect(kioskLookupResponseSchema.parse({ data: { status: 'see_front_desk' } })).toEqual({ data: { status: 'see_front_desk' } });
    expect(kioskFamilyCheckinResponseSchema.parse({ data: safeResults }).data).toHaveLength(4);
  });
  it('keeps leading zeros in PINs and reauthenticates each family submission', () => {
    const credentials = { name: 'Alex', pin: '001234' };
    expect(kioskLookupRequestSchema.parse(credentials).pin).toBe('001234');
    const checkins = [{ memberId: id }, { memberId: otherId, sessionId: null }];
    expect(kioskNamePinCheckinRequestSchema.parse({ ...credentials, checkins }).checkins).toEqual(checkins);
    expect(kioskNamePinCheckinRequestSchema.safeParse({ checkins }).success).toBe(false);
    expect(kioskNamePinCheckinRequestSchema.safeParse({ ...credentials, checkins: [checkins[0], checkins[0]] }).success).toBe(false);
    expect(kioskNamePinCheckinRequestSchema.safeParse({ ...credentials, checkins: [] }).success).toBe(false);
    expect(kioskLookupRequestSchema.safeParse({ ...credentials, pin: 1234 }).success).toBe(false);
    expect(kioskLookupRequestSchema.safeParse({ ...credentials, pin: '' }).success).toBe(false);
    expect(kioskLookupRequestSchema.safeParse({ ...credentials, householdId: otherId }).success).toBe(false);
  });
  it('distinguishes automatic session selection from an explicit open-mat check-in', () => {
    expect(kioskQrCheckinRequestSchema.parse({ code: 'opaque-QR-value' })).not.toHaveProperty('sessionId');
    expect(kioskQrCheckinRequestSchema.parse({ code: 'opaque-QR-value', sessionId: null }).sessionId).toBeNull();
    expect(kioskQrCheckinRequestSchema.parse({ code: 'opaque-QR-value', sessionId: id }).sessionId).toBe(id);
    for (const extra of [{ memberId: otherId }, { gymId: otherId }, { deviceId: otherId }, { source: 'coach' }]) {
      expect(kioskQrCheckinRequestSchema.safeParse({ code: 'opaque-QR-value', ...extra }).success).toBe(false);
    }
    expect(kioskQrCheckinRequestSchema.safeParse({ code: '' }).success).toBe(false);
    expect(kioskQrCheckinRequestSchema.safeParse({ code: 'x'.repeat(2049) }).success).toBe(false);
  });
  it('keeps the device and identity projections tied to persisted fields', () => {
    expectTypeOf<Omit<KioskDevice, 'createdAt' | 'revokedAt' | 'lastSeenAt'>>()
      .toExtend<Omit<typeof kioskDevices.$inferSelect, 'gymId' | 'createdAt' | 'revokedAt' | 'lastSeenAt' | 'tokenHash'>>();
    expectTypeOf<Pick<KioskMemberIdentity, 'id' | 'firstName'>>()
      .toExtend<Pick<typeof members.$inferSelect, 'id' | 'firstName'>>();
  });
  it('reserves device management for owner/admin and check-in for device credentials', () => {
    for (const endpoint of Object.values(kioskContracts)) {
      expect(isRoutePermission(endpoint.permission)).toBe(true);
      if (endpoint.permission.kind === 'staff') {
        for (const role of ['owner', 'admin'] as const) expect(canStaff([role], endpoint.permission.capability)).toBe(true);
        for (const role of ['coach', 'front_desk'] as const) expect(canStaff([role], endpoint.permission.capability)).toBe(false);
        expect(canStaff([], endpoint.permission.capability)).toBe(false);
      } else {
        expect(endpoint.permission).toEqual({ kind: 'kiosk', capability: 'checkin' });
      }
    }
  });
});
