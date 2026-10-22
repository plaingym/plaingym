// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { staffProfiles, staffRoles as staffRoleTable } from '../../../db/src/schema/index.js';
import { canStaff, isRoutePermission, staffRoles } from '../permissions.js';
import {
  createStaffProfileRequestSchema, grantStaffRoleRequestSchema, inviteStaffRequestSchema,
  inviteStaffResponseSchema, publicStaffProfileSchema, revokeStaffRoleRequestSchema,
  staffContracts, staffProfileListQuerySchema, staffProfileSchema, staffRoleSchema,
  updateStaffProfileRequestSchema, updateStaffRoleRequestSchema,
  type PublicStaffProfile, type StaffProfile, type StaffRoleRecord,
} from '@plaingym/shared/contracts';

const id = '019a08bf-1234-7000-8000-000000000001';
const createdAt = '2026-10-21T12:00:00Z';
const profile = {
  id, userId: null, memberId: null, displayName: 'Guest coach', bio: null,
  photoKey: null, rank: null, isPublic: false, revision: 1, createdAt,
};
const roleRecord = { id, userId: id, role: 'coach', revision: 1, createdAt };
type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

describe('staff profiles and roles', () => {
  it('supports guest/imported coaches without an auth identity or a member profile', () => {
    expect(createStaffProfileRequestSchema.parse({ displayName: 'Guest coach' })).toEqual({ displayName: 'Guest coach' });
    expect(staffProfileSchema.parse(profile).userId).toBeNull();
    expect(createStaffProfileRequestSchema.parse({ displayName: 'Coach', userId: id, memberId: id }).memberId).toBe(id);
  });
  it('keeps role grants separate from presentation profiles', () => {
    expect(createStaffProfileRequestSchema.safeParse({ displayName: 'Coach', role: 'owner' }).success).toBe(false);
    expect(updateStaffProfileRequestSchema.safeParse({ revision: 1, roles: ['owner'] }).success).toBe(false);
    expect(staffProfileSchema.safeParse({ ...profile, tokenHash: 'secret' }).success).toBe(false);
  });
  it('makes the public projection explicitly exclude login, membership and revision fields', () => {
    const publicProfile = { id, displayName: 'Coach', bio: null, photoKey: null, rank: null };
    expect(publicStaffProfileSchema.parse(publicProfile)).toEqual(publicProfile);
    for (const field of ['userId', 'memberId', 'revision', 'isPublic']) {
      expect(publicStaffProfileSchema.safeParse({ ...publicProfile, [field]: id }).success).toBe(false);
    }
  });
  it('accepts every stored staff role, but reserves owner assignment for ownership transfer', () => {
    for (const role of staffRoles) expect(staffRoleSchema.parse({ ...roleRecord, role }).role).toBe(role);
    for (const role of ['admin', 'coach', 'front_desk']) {
      expect(grantStaffRoleRequestSchema.parse({ userId: id, role }).role).toBe(role);
    }
    expect(grantStaffRoleRequestSchema.safeParse({ userId: id, role: 'owner' }).success).toBe(false);
    expect(updateStaffRoleRequestSchema.safeParse({ revision: 1, role: 'owner' }).success).toBe(false);
    expect(staffRoleSchema.safeParse({ ...roleRecord, role: 'member' }).success).toBe(false);
    expect(grantStaffRoleRequestSchema.safeParse({ userId: id, roles: ['coach', 'admin'] }).success).toBe(false);
  });
  it('requires positive integer revisions for profile updates, role changes and revocation', () => {
    for (const revision of [undefined, 0, -1, 1.5, '1']) {
      expect(updateStaffProfileRequestSchema.safeParse({ revision, displayName: 'New name' }).success).toBe(false);
      expect(updateStaffRoleRequestSchema.safeParse({ revision, role: 'coach' }).success).toBe(false);
      expect(revokeStaffRoleRequestSchema.safeParse({ revision }).success).toBe(false);
    }
    expect(updateStaffProfileRequestSchema.parse({ revision: 2, userId: null }).userId).toBeNull();
    expect(updateStaffRoleRequestSchema.parse({ revision: 2, role: 'admin' }).revision).toBe(2);
  });
  it('supports email and printed invitations without exposing a URL in email results', () => {
    expect(inviteStaffRequestSchema.parse({ email: 'coach@example.com', role: 'coach', delivery: 'print' }).delivery).toBe('print');
    expect(inviteStaffRequestSchema.safeParse({ email: 'not-an-email', role: 'coach', delivery: 'email' }).success).toBe(false);
    expect(inviteStaffRequestSchema.safeParse({ email: 'owner@example.com', role: 'owner', delivery: 'print' }).success).toBe(false);
    expect(inviteStaffResponseSchema.parse({ data: { delivery: 'email', staffRole: roleRecord } }).data.delivery).toBe('email');
    expect(inviteStaffResponseSchema.safeParse({
      data: { delivery: 'email', staffRole: roleRecord, invitationUrl: 'https://gym.example/invite/secret' },
    }).success).toBe(false);
    expect(inviteStaffResponseSchema.safeParse({ data: { delivery: 'print', staffRole: roleRecord } }).success).toBe(false);
    expect(inviteStaffResponseSchema.parse({
      data: { delivery: 'print', staffRole: roleRecord, invitationUrl: 'https://gym.example/invite/secret' },
    }).data.delivery).toBe('print');
  });
  it('shares strict pagination without treating query strings as booleans', () => {
    expect(staffProfileListQuerySchema.parse({ userId: id })).toEqual({ userId: id, limit: 50, offset: 0 });
    expect(staffProfileListQuerySchema.safeParse({ isPublic: 'false' }).success).toBe(false);
  });
  it.each(staffRoles)('limits staff administration to managers for %s', (role) => {
    for (const endpoint of Object.values(staffContracts)) {
      expect(isRoutePermission(endpoint.permission)).toBe(true);
      expect(canStaff([role], endpoint.permission.capability)).toBe(role === 'owner' || role === 'admin');
    }
  });
  it('matches the locked schema without requiring profiles to have a login', () => {
    expectTypeOf<StaffProfile>().toExtend<Wire<Pick<typeof staffProfiles.$inferSelect, keyof StaffProfile>>>();
    expectTypeOf<PublicStaffProfile>().toExtend<Pick<typeof staffProfiles.$inferSelect, keyof PublicStaffProfile>>();
    expectTypeOf<StaffRoleRecord>().toExtend<Wire<Pick<typeof staffRoleTable.$inferSelect, keyof StaffRoleRecord>>>();
  });
});
