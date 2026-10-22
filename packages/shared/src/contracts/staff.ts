// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { staffRoles } from '../permissions.js';
import {
  idSchema, instantSchema, listResponseSchema, paginationSchema, revisionSchema,
} from './common.js';

export const staffRoleNameSchema = z.enum(staffRoles);
/** Owner changes go through the separate ownership-transfer permission. */
export const assignableStaffRoleSchema = staffRoleNameSchema.exclude(['owner']);
export const staffRoleSchema = z.strictObject({
  id: idSchema, userId: idSchema, role: staffRoleNameSchema,
  revision: revisionSchema, createdAt: instantSchema,
});
export const grantStaffRoleRequestSchema = z.strictObject({
  userId: idSchema, role: assignableStaffRoleSchema,
});
export const updateStaffRoleRequestSchema = z.strictObject({
  role: assignableStaffRoleSchema, revision: revisionSchema,
});
export const revokeStaffRoleRequestSchema = z.strictObject({ revision: revisionSchema });
export const staffRoleParamsSchema = z.strictObject({ staffRoleId: idSchema });
export const staffRoleResponseSchema = z.strictObject({ data: staffRoleSchema });
export const staffRoleListResponseSchema = listResponseSchema(staffRoleSchema);

/** A profile is for scheduling/presentation; a null userId is valid and grants no access. */
export const staffProfileSchema = z.strictObject({
  id: idSchema,
  userId: idSchema.nullable(),
  memberId: idSchema.nullable(),
  displayName: z.string().trim().min(1),
  bio: z.string().nullable(),
  photoKey: z.string().nullable(),
  rank: z.string().nullable(),
  isPublic: z.boolean(),
  revision: revisionSchema,
  createdAt: instantSchema,
});
export const publicStaffProfileSchema = staffProfileSchema.pick({
  id: true, displayName: true, bio: true, photoKey: true, rank: true,
});
const staffProfileEditableSchema = staffProfileSchema.omit({ id: true, revision: true, createdAt: true });
export const createStaffProfileRequestSchema = staffProfileEditableSchema.partial().extend({
  displayName: staffProfileSchema.shape.displayName,
});
export const updateStaffProfileRequestSchema = staffProfileEditableSchema.partial().extend({
  revision: revisionSchema,
});
export const staffProfileParamsSchema = z.strictObject({ staffProfileId: idSchema });
export const staffProfileListQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).optional(),
  userId: idSchema.optional(),
  memberId: idSchema.optional(),
});
export const staffProfileResponseSchema = z.strictObject({ data: staffProfileSchema });
export const staffProfileListResponseSchema = listResponseSchema(staffProfileSchema);

export const inviteStaffRequestSchema = z.strictObject({
  email: z.email(),
  role: assignableStaffRoleSchema,
  delivery: z.enum(['email', 'print']),
});
/** Printed invitation URLs are returned once at creation and never in a profile or role list. */
export const inviteStaffResponseSchema = z.strictObject({
  data: z.discriminatedUnion('delivery', [
    z.strictObject({ delivery: z.literal('email'), staffRole: staffRoleSchema }),
    z.strictObject({ delivery: z.literal('print'), staffRole: staffRoleSchema, invitationUrl: z.url() }),
  ]),
});
export const resetStaffPasswordRequestSchema = z.strictObject({
  newPassword: z.string().min(12).max(128),
});
export const staffUserParamsSchema = z.strictObject({ userId: idSchema });

/**
 * API declarations only. Password resets require single tenancy + password mode, end all
 * target sessions, and reject owners or targets whose roles are not below the caller's.
 * Role mutation also rejects an existing owner; a profile never substitutes for a role.
 * Revisioned mutations use the shared conflict (409) response on a stale save.
 */
export const staffContracts = {
  listProfiles: { method: 'get', path: '/api/staff/profiles', permission: { kind: 'staff', capability: 'staff.manage' },
    query: staffProfileListQuerySchema, response: staffProfileListResponseSchema },
  getProfile: { method: 'get', path: '/api/staff/profiles/{staffProfileId}', permission: { kind: 'staff', capability: 'staff.manage' },
    params: staffProfileParamsSchema, response: staffProfileResponseSchema },
  createProfile: { method: 'post', path: '/api/staff/profiles', permission: { kind: 'staff', capability: 'staff.manage' },
    body: createStaffProfileRequestSchema, response: staffProfileResponseSchema },
  updateProfile: { method: 'patch', path: '/api/staff/profiles/{staffProfileId}', permission: { kind: 'staff', capability: 'staff.manage' },
    params: staffProfileParamsSchema, body: updateStaffProfileRequestSchema, response: staffProfileResponseSchema },
  listRoles: { method: 'get', path: '/api/staff/roles', permission: { kind: 'staff', capability: 'staff.manage' },
    query: paginationSchema, response: staffRoleListResponseSchema },
  grantRole: { method: 'post', path: '/api/staff/roles', permission: { kind: 'staff', capability: 'staff.manage' },
    body: grantStaffRoleRequestSchema, response: staffRoleResponseSchema },
  updateRole: { method: 'patch', path: '/api/staff/roles/{staffRoleId}', permission: { kind: 'staff', capability: 'staff.manage' },
    params: staffRoleParamsSchema, body: updateStaffRoleRequestSchema, response: staffRoleResponseSchema },
  revokeRole: { method: 'delete', path: '/api/staff/roles/{staffRoleId}', permission: { kind: 'staff', capability: 'staff.manage' },
    params: staffRoleParamsSchema, body: revokeStaffRoleRequestSchema, response: z.strictObject({ data: z.null() }) },
  inviteStaff: { method: 'post', path: '/api/staff/invitations', permission: { kind: 'staff', capability: 'staff.manage' },
    body: inviteStaffRequestSchema, response: inviteStaffResponseSchema },
  resetPassword: { method: 'post', path: '/api/staff/users/{userId}/reset-password', permission: { kind: 'staff', capability: 'staff.manage' },
    params: staffUserParamsSchema, body: resetStaffPasswordRequestSchema, response: z.strictObject({ data: z.null() }) },
} as const satisfies Record<string, EndpointContract>;

export type StaffRoleName = z.infer<typeof staffRoleNameSchema>;
export type AssignableStaffRole = z.infer<typeof assignableStaffRoleSchema>;
export type StaffRoleRecord = z.infer<typeof staffRoleSchema>;
export type GrantStaffRoleRequest = z.infer<typeof grantStaffRoleRequestSchema>;
export type UpdateStaffRoleRequest = z.infer<typeof updateStaffRoleRequestSchema>;
export type RevokeStaffRoleRequest = z.infer<typeof revokeStaffRoleRequestSchema>;
export type StaffProfile = z.infer<typeof staffProfileSchema>;
export type PublicStaffProfile = z.infer<typeof publicStaffProfileSchema>;
export type CreateStaffProfileRequest = z.infer<typeof createStaffProfileRequestSchema>;
export type UpdateStaffProfileRequest = z.infer<typeof updateStaffProfileRequestSchema>;
export type StaffProfileListQuery = z.infer<typeof staffProfileListQuerySchema>;
export type StaffProfileResponse = z.infer<typeof staffProfileResponseSchema>;
export type StaffProfileListResponse = z.infer<typeof staffProfileListResponseSchema>;
export type InviteStaffRequest = z.infer<typeof inviteStaffRequestSchema>;
export type InviteStaffResponse = z.infer<typeof inviteStaffResponseSchema>;
export type ResetStaffPasswordRequest = z.infer<typeof resetStaffPasswordRequestSchema>;
