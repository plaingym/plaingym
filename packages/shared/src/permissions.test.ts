// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  canAccessMember,
  canMember,
  canStaff,
  isRoutePermission,
  memberPermissions,
  staffPermissions,
  staffRoles,
  type MemberPermission,
  type MemberRole,
  type StaffPermission,
  type StaffRole,
} from './permissions.js';

const rows: readonly [StaffPermission, readonly StaffRole[]][] = [
  ['integrations.manage', ['owner']],
  ['ownership.transfer', ['owner']],
  ...(
    [
      'settings.manage',
      'plans.manage',
      'taxes.manage',
      'staff.manage',
      'go_live.manage',
      'refunds.create',
      'data.export',
      'members.anonymize',
      'kiosk_devices.manage',
    ] as const
  ).map((permission): [StaffPermission, StaffRole[]] => [permission, ['owner', 'admin']]),
  ...(
    [
      'members.manage',
      'households.manage',
      'tags.manage',
      'links.send',
      'payments.record',
      'billing.read',
      'portal_access.manage',
    ] as const
  ).map((permission): [StaffPermission, StaffRole[]] => [
    permission,
    ['owner', 'admin', 'front_desk'],
  ]),
  ...(['medical.read', 'schedule.manage', 'promotions.manage'] as const).map(
    (permission): [StaffPermission, StaffRole[]] => [permission, ['owner', 'admin', 'coach']],
  ),
  ...(
    [
      'members.read',
      'emergency_contacts.read',
      'attendance.manage',
      'class_notes.manage',
      'bookings.manage',
    ] as const
  ).map((permission): [StaffPermission, StaffRole[]] => [
    permission,
    ['owner', 'admin', 'coach', 'front_desk'],
  ]),
];
describe('staff permissions', () => {
  it('covers the complete map', () => {
    expect(rows.map(([permission]) => permission).sort()).toEqual(
      Object.keys(staffPermissions).sort(),
    );
  });
  for (const [permission, allowed] of rows) {
    for (const role of staffRoles)
      it(`${role}: ${permission}`, () => {
        expect(canStaff([role], permission)).toBe(allowed.includes(role));
      });
    it(`denies unauthenticated access to ${permission}`, () =>
      expect(canStaff([], permission)).toBe(false));
  }
  it('combines explicitly assigned roles', () => {
    expect(canStaff(['coach', 'front_desk'], 'medical.read')).toBe(true);
    expect(canStaff(['coach', 'front_desk'], 'refunds.create')).toBe(false);
  });
});
const memberRows: readonly [MemberPermission, readonly MemberRole[]][] = [
  ...(
    [
      'profile.read',
      'progress.read',
      'attendance.read',
      'checkin.manage',
      'bookings.self',
      'waivers.self',
    ] as const
  ).map((permission): [MemberPermission, MemberRole[]] => [permission, ['payer', 'member']]),
  ...(
    [
      'household.read',
      'bookings.household',
      'billing.manage',
      'waivers.household',
      'household.manage',
    ] as const
  ).map((permission): [MemberPermission, MemberRole[]] => [permission, ['payer']]),
  ['memberships.manage', []],
];
describe('member access', () => {
  it('allows a non-training payer to act for their own household', () => {
    expect(
      canAccessMember(
        { gymId: 'gym', householdId: 'family', role: 'payer' },
        { gymId: 'gym', householdId: 'family', memberId: 'child' },
      ),
    ).toBe(true);
  });
  it('covers the complete map', () =>
    expect(memberRows.map(([p]) => p).sort()).toEqual(Object.keys(memberPermissions).sort()));
  for (const [permission, allowed] of memberRows)
    for (const role of ['payer', 'member'] as const) {
      it(`${role}: ${permission}`, () =>
        expect(canMember(role, permission)).toBe(allowed.includes(role)));
    }
  it('limits payers to their gym and household, and adults to themselves', () => {
    const own = { gymId: 'a', householdId: 'h1', memberId: 'm1' };
    const child = { ...own, memberId: 'm2' };
    const other = { ...own, householdId: 'h2' };
    const gym = { ...own, gymId: 'b' };
    for (const role of ['payer', 'member'] as const) {
      const scope = { ...own, role };
      expect(canAccessMember(scope, own)).toBe(true);
      expect(canAccessMember(scope, child)).toBe(role === 'payer');
      expect(canAccessMember(scope, other)).toBe(false);
      expect(canAccessMember(scope, gym)).toBe(false);
    }
  });
  it('requires explicit valid route access declarations', () => {
    for (const value of [
      undefined,
      {},
      { kind: 'staff' },
      { kind: 'publicly' },
      { kind: 'staff', capability: 'constructor' },
      { kind: 'member', capability: 'refunds.create' },
      { kind: 'kiosk', capability: 'admin' },
      { kind: 'signed_link', purpose: 'everything' },
    ]) {
      expect(isRoutePermission(value)).toBe(false);
    }
    expect(isRoutePermission({ kind: 'public' })).toBe(true);
    expect(isRoutePermission({ kind: 'kiosk', capability: 'checkin' })).toBe(true);
    for (const purpose of ['pay_invoice', 'sign_waiver', 'update_card', 'onboarding']) {
      expect(isRoutePermission({ kind: 'signed_link', purpose })).toBe(true);
    }
  });
});
