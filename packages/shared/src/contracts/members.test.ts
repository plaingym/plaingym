// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { households, householdUsers, members, memberTags, memberTagLinks } from '../../../db/src/schema/index.js';
import { canStaff, isRoutePermission, staffRoles } from '../permissions.js';
import {
  anonymizeMemberRequestSchema, createHouseholdRequestSchema, createHouseholdUserRequestSchema,
  createMemberRequestSchema, createMemberTagRequestSchema, householdBillingSettingsSchema,
  householdMemberSchema, householdResponseSchema, householdSchema, householdUserListResponseSchema,
  householdUserSchema, memberListQuerySchema, memberListResponseSchema, memberMedicalNotesSchema,
  memberSchema, membersContracts, setHouseholdPinRequestSchema, updateHouseholdBillingSettingsRequestSchema,
  updateHouseholdRequestSchema, updateMemberMedicalNotesRequestSchema, updateMemberRequestSchema,
  updateMemberTagRequestSchema,
  type Household, type HouseholdBillingSettings, type HouseholdMember, type HouseholdUser,
  type Member, type MemberMedicalNotes, type MemberTag, type MemberTagLink,
} from '@plaingym/shared/contracts';

const id = '019a08bf-1234-7000-8000-000000000001';
const householdId = '019a08bf-1234-7000-8000-000000000002';
const createdAt = '2026-10-21T12:00:00Z';
const member = {
  id, householdId, firstName: '明', lastName: '山田', email: null, phone: null, photoKey: null,
  dateOfBirth: '2014-02-28', status: 'active', emergencyContacts: [
    { name: 'أحمد', relationship: 'Parent', phone: '+1 555 0100', email: null },
  ],
  emailOptOut: true, anonymizedAt: null, revision: 2, createdAt,
};
const household = {
  id: householdId, name: 'Family', email: null, phone: null, address: {}, revision: 1, createdAt,
};
type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

describe('member contracts', () => {
  it('accepts household-visible emergency contacts and names in any script', () => {
    expect(householdMemberSchema.parse(member)).toEqual(member);
    expect(memberSchema.parse({ ...member, emailDeliverable: true }).emergencyContacts).toEqual(member.emergencyContacts);
  });
  it.each(['medicalNotes', 'pinHash', 'checkinCodeHash', 'checkinCodeVersion', 'tokenHash', 'encryptedConfig'])(
    'rejects sensitive field %s in household members', (field) => {
      expect(householdMemberSchema.safeParse({ ...member, [field]: 'secret' }).success).toBe(false);
    },
  );
  it('keeps deliverability and medical notes out of household shapes and normal staff rosters', () => {
    expect(householdMemberSchema.safeParse({ ...member, emailDeliverable: false }).success).toBe(false);
    expect(memberSchema.safeParse({ ...member, emailDeliverable: true, medicalNotes: 'Private' }).success).toBe(false);
    expect(memberMedicalNotesSchema.parse({ id, medicalNotes: 'Private', revision: 2 })).toEqual({
      id, medicalNotes: 'Private', revision: 2,
    });
  });
  it('allows minimal creation while rejecting server-owned fields and medical writes', () => {
    const request = { householdId, firstName: 'Ada', lastName: 'Lovelace' };
    expect(createMemberRequestSchema.parse(request)).toEqual(request);
    for (const extra of [{ id }, { emailDeliverable: false }, { medicalNotes: 'Private' }, { checkinCodeHash: 'hash' }]) {
      expect(createMemberRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });
  it.each(['unknown', '', 'ACTIVE'])('rejects unsupported status %j', (status) => {
    expect(updateMemberRequestSchema.safeParse({ revision: 1, status }).success).toBe(false);
  });
  it('requires an exact positive database revision on every revisioned mutation', () => {
    const schemas = [
      updateMemberRequestSchema, updateHouseholdRequestSchema, updateMemberTagRequestSchema,
      anonymizeMemberRequestSchema,
    ];
    for (const schema of schemas) {
      expect(schema.safeParse({ revision: 1 }).success).toBe(true);
      for (const revision of [undefined, null, '1', 0, -1, 1.5, 2_147_483_648]) {
        expect(schema.safeParse({ revision }).success).toBe(false);
      }
    }
    // Freshness is a compare-and-set service check, not something a JSON shape can decide.
    expect(updateMemberMedicalNotesRequestSchema.safeParse({ medicalNotes: null }).success).toBe(false);
    expect(updateMemberMedicalNotesRequestSchema.parse({ medicalNotes: null, revision: 3 }).revision).toBe(3);
  });
  it('rejects reparenting, personal-data read-only fields and invalid birth dates', () => {
    for (const change of [{ householdId }, { anonymizedAt: createdAt }, { emailDeliverable: true }, { dateOfBirth: '2026-02-29' }]) {
      expect(updateMemberRequestSchema.safeParse({ revision: 1, ...change }).success).toBe(false);
    }
  });
  it('composes roster filters with strict shared pagination', () => {
    expect(memberListQuerySchema.parse({ status: 'visitor', tagId: id, householdId, limit: '25', offset: '50' }))
      .toEqual({ status: 'visitor', tagId: id, householdId, limit: 25, offset: 50 });
    expect(memberListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(memberListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(memberListQuerySchema.safeParse({ filter: 'everything' }).success).toBe(false);
    expect(memberListResponseSchema.parse({
      data: [{ ...member, emailDeliverable: false }], pagination: { limit: 50, offset: 0, total: 1 },
    }).data).toHaveLength(1);
    expect(memberListResponseSchema.safeParse({ data: [] }).success).toBe(false);
  });
});

describe('household, tag and login contracts', () => {
  it('keeps PINs, processor references and billing settings out of contact responses', () => {
    expect(householdResponseSchema.parse({ data: household }).data.address).toEqual({});
    for (const field of ['pin', 'pinHash', 'stripeCustomerId', 'billingDay', 'familyDiscountBasisPoints']) {
      expect(householdSchema.safeParse({ ...household, [field]: 'secret' }).success).toBe(false);
    }
  });
  it('validates household billing bounds and requires a revision on later changes', () => {
    expect(createHouseholdRequestSchema.parse({ name: 'Family', billingDay: 31, familyDiscountBasisPoints: 10_000 }).billingDay).toBe(31);
    expect(householdBillingSettingsSchema.parse({ id, revision: 1, billingDay: 1, familyDiscountBasisPoints: 0 }).billingDay).toBe(1);
    for (const billingDay of [0, 32, 1.5, '1']) {
      expect(createHouseholdRequestSchema.safeParse({ name: 'Family', billingDay }).success).toBe(false);
    }
    for (const familyDiscountBasisPoints of [-1, 10_001, 1.5]) {
      expect(createHouseholdRequestSchema.safeParse({ name: 'Family', familyDiscountBasisPoints }).success).toBe(false);
    }
    expect(updateHouseholdBillingSettingsRequestSchema.safeParse({ billingDay: 5, familyDiscountBasisPoints: 0 }).success).toBe(false);
  });
  it('preserves leading zeroes in write-only PINs and permits revocation', () => {
    expect(setHouseholdPinRequestSchema.parse({ pin: '0012', revision: 1 }).pin).toBe('0012');
    expect(setHouseholdPinRequestSchema.parse({ pin: null, revision: 1 }).pin).toBeNull();
    for (const pin of [1234, '123', '123456789', '12a4', '１２３４']) {
      expect(setHouseholdPinRequestSchema.safeParse({ pin, revision: 1 }).success).toBe(false);
    }
    expect(setHouseholdPinRequestSchema.safeParse({ pin: '1234' }).success).toBe(false);
  });
  it('does not grant access implicitly to a member login without its member resource', () => {
    expect(createHouseholdUserRequestSchema.safeParse({ userId: id, scope: 'member' }).success).toBe(false);
    expect(createHouseholdUserRequestSchema.safeParse({ userId: id, scope: 'member', memberId: null }).success).toBe(false);
    expect(createHouseholdUserRequestSchema.parse({ userId: id, scope: 'member', memberId: id }).memberId).toBe(id);
    expect(createHouseholdUserRequestSchema.parse({ userId: id, scope: 'payer' }).scope).toBe('payer');
    expect(createHouseholdUserRequestSchema.parse({ userId: id, scope: 'payer', memberId: null }).scope).toBe('payer');
    expect(createHouseholdUserRequestSchema.safeParse({ userId: id, scope: 'admin', memberId: id }).success).toBe(false);
  });
  it('supports several payer accounts without making a payer member link mandatory', () => {
    const user = { id, householdId, userId: id, scope: 'payer', memberId: null, createdAt };
    expect(householdUserSchema.parse(user).memberId).toBeNull();
    const page = { data: [user, { ...user, id: householdId, userId: householdId }], pagination: { limit: 50, offset: 0, total: 2 } };
    expect(householdUserListResponseSchema.parse(page).data).toHaveLength(2);
    // One-login-per-member uniqueness and same-household membership are enforced by scoped persistence.
  });
  it('accepts tag colors but rejects malformed names, colors and revisionless edits', () => {
    expect(createMemberTagRequestSchema.parse({ name: 'Competition', color: '#AAbb00' }).name).toBe('Competition');
    expect(createMemberTagRequestSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(createMemberTagRequestSchema.safeParse({ name: 'Team', color: 'red' }).success).toBe(false);
    expect(updateMemberTagRequestSchema.safeParse({ name: 'Team' }).success).toBe(false);
  });
});

describe('people contract permissions and schema compatibility', () => {
  it('declares valid permissions and unique method/path pairs for all endpoints', () => {
    const endpoints = Object.values(membersContracts);
    expect(new Set(endpoints.map((endpoint) => endpoint.method + ' ' + endpoint.path)).size).toBe(endpoints.length);
    for (const endpoint of endpoints) expect(isRoutePermission(endpoint.permission)).toBe(true);
  });
  it.each(staffRoles)('enforces medical, anonymization and member-edit boundaries for %s', (role) => {
    expect(canStaff([role], membersContracts.getMember.permission.capability)).toBe(true);
    expect(canStaff([role], membersContracts.getMedicalNotes.permission.capability)).toBe(role !== 'front_desk');
    const medicalWrite = membersContracts.updateMedicalNotes;
    const canWrite = canStaff([role], medicalWrite.permission.capability)
      && medicalWrite.additionalPermissions.every((permission) => canStaff([role], permission.capability));
    expect(canWrite).toBe(role === 'owner' || role === 'admin');
    expect(canStaff([role], membersContracts.anonymizeMember.permission.capability)).toBe(role === 'owner' || role === 'admin');
    expect(canStaff([role], membersContracts.updateMember.permission.capability)).toBe(role !== 'coach');
    expect(canStaff([role], membersContracts.createHouseholdUser.permission.capability)).toBe(role !== 'coach');
  });
  it('exposes only columns present in the locked tables, with timestamps serialized as strings', () => {
    expectTypeOf<Member>().toExtend<Wire<Pick<typeof members.$inferSelect, keyof Member>>>();
    expectTypeOf<HouseholdMember>().toExtend<Wire<Pick<typeof members.$inferSelect, keyof HouseholdMember>>>();
    expectTypeOf<MemberMedicalNotes>().toExtend<Pick<typeof members.$inferSelect, keyof MemberMedicalNotes>>();
    expectTypeOf<Household>().toExtend<Wire<Pick<typeof households.$inferSelect, keyof Household>>>();
    expectTypeOf<HouseholdBillingSettings>().toExtend<Pick<typeof households.$inferSelect, keyof HouseholdBillingSettings>>();
    expectTypeOf<MemberTag>().toExtend<Wire<Pick<typeof memberTags.$inferSelect, keyof MemberTag>>>();
    expectTypeOf<MemberTagLink>().toExtend<Wire<Pick<typeof memberTagLinks.$inferSelect, keyof MemberTagLink>>>();
    expectTypeOf<HouseholdUser>().toExtend<Wire<Pick<typeof householdUsers.$inferSelect, keyof HouseholdUser>>>();
  });
});
