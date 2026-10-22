// SPDX-License-Identifier: AGPL-3.0-only
export const staffRoles = ['owner', 'admin', 'coach', 'front_desk'] as const;
export type StaffRole = (typeof staffRoles)[number];

const owner = ['owner'] as const;
const managers = ['owner', 'admin'] as const;
const desk = ['owner', 'admin', 'front_desk'] as const;
const coaches = ['owner', 'admin', 'coach'] as const;

export const staffPermissions = {
  'integrations.manage': owner,
  'ownership.transfer': owner,
  'settings.manage': managers,
  'plans.manage': managers,
  'taxes.manage': managers,
  'staff.manage': managers,
  'go_live.manage': managers,
  'refunds.create': managers,
  'data.export': managers,
  'members.anonymize': managers,
  'members.read': staffRoles,
  'members.manage': desk,
  'households.manage': desk,
  'tags.manage': desk,
  'links.send': desk,
  'payments.record': desk,
  'billing.read': desk,
  'medical.read': coaches,
  'emergency_contacts.read': staffRoles,
  'attendance.manage': staffRoles,
  'class_notes.manage': staffRoles,
  'bookings.manage': staffRoles,
  'portal_access.manage': desk,
  'schedule.manage': coaches,
  'promotions.manage': coaches,
  'kiosk_devices.manage': managers,
} as const satisfies Record<string, readonly StaffRole[]>;

export type StaffPermission = keyof typeof staffPermissions;
export type MemberRole = 'payer' | 'member';
export const memberPermissions = {
  'profile.read': ['payer', 'member'],
  'progress.read': ['payer', 'member'],
  'attendance.read': ['payer', 'member'],
  'checkin.manage': ['payer', 'member'],
  'bookings.self': ['payer', 'member'],
  'household.read': ['payer'],
  'bookings.household': ['payer'],
  'billing.manage': ['payer'],
  'waivers.self': ['payer', 'member'],
  'waivers.household': ['payer'],
  'household.manage': ['payer'],
  'memberships.manage': [],
} as const satisfies Record<string, readonly MemberRole[]>;
export type MemberPermission = keyof typeof memberPermissions;

export type MemberScope = {
  readonly gymId: string;
  readonly householdId: string;
} & (
  | { readonly role: 'payer'; readonly memberId?: string }
  | { readonly role: 'member'; readonly memberId: string }
);

export type SignedLink =
  | { readonly purpose: 'pay_invoice'; readonly invoiceId: string }
  | { readonly purpose: 'sign_waiver'; readonly memberId: string }
  | { readonly purpose: 'update_card' }
  | { readonly purpose: 'onboarding' };
export type SignedLinkPurpose = SignedLink['purpose'];

const signedLinkPurposes: readonly SignedLinkPurpose[] = [
  'pay_invoice',
  'update_card',
  'sign_waiver',
  'onboarding',
];

export type RoutePermission =
  | { readonly kind: 'staff'; readonly capability: StaffPermission }
  | { readonly kind: 'member'; readonly capability: MemberPermission }
  | { readonly kind: 'kiosk'; readonly capability: 'checkin' }
  | {
      readonly kind: 'signed_link';
      readonly purpose: SignedLinkPurpose;
    }
  | { readonly kind: 'public' };

export function canStaff(roles: readonly StaffRole[], permission: StaffPermission): boolean {
  const allowed: readonly StaffRole[] = staffPermissions[permission];
  return roles.some((role) => allowed.includes(role));
}

export function canMember(role: MemberRole, permission: MemberPermission): boolean {
  const allowed: readonly MemberRole[] = memberPermissions[permission];
  return allowed.includes(role);
}

export function canAccessMember(
  scope: MemberScope,
  resource: { gymId: string; householdId: string; memberId: string },
): boolean {
  return (
    scope.gymId === resource.gymId &&
    scope.householdId === resource.householdId &&
    (scope.role === 'payer' || scope.memberId === resource.memberId)
  );
}

export function isRoutePermission(value: unknown): value is RoutePermission {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  switch (value.kind) {
    case 'public':
      return true;
    case 'staff':
      return (
        'capability' in value &&
        typeof value.capability === 'string' &&
        Object.hasOwn(staffPermissions, value.capability)
      );
    case 'member':
      return (
        'capability' in value &&
        typeof value.capability === 'string' &&
        Object.hasOwn(memberPermissions, value.capability)
      );
    case 'kiosk':
      return 'capability' in value && value.capability === 'checkin';
    case 'signed_link':
      return (
        'purpose' in value &&
        typeof value.purpose === 'string' &&
        signedLinkPurposes.some((purpose) => purpose === value.purpose)
      );
    default:
      return false;
  }
}
