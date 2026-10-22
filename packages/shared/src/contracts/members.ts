// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { memberStatusSchema } from './states.js';
import {
  dateSchema, idSchema, instantSchema, listResponseSchema, paginationSchema, revisionSchema,
} from './common.js';

const nameSchema = z.string().trim().min(1);
const nullableTextSchema = z.string().nullable();

export { memberStatusSchema } from './states.js';
export const householdAddressSchema = z.strictObject({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
});
export const emergencyContactSchema = z.strictObject({
  name: nameSchema,
  relationship: nullableTextSchema,
  phone: z.string().trim().min(1),
  email: z.email().nullable(),
});

/** Safe for household grants; never add medical notes or check-in credentials. */
export const householdMemberSchema = z.strictObject({
  id: idSchema,
  householdId: idSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  email: z.email().nullable(),
  phone: nullableTextSchema,
  photoKey: nullableTextSchema,
  dateOfBirth: dateSchema.nullable(),
  status: memberStatusSchema,
  emergencyContacts: z.array(emergencyContactSchema),
  emailOptOut: z.boolean(),
  anonymizedAt: instantSchema.nullable(),
  revision: revisionSchema,
  createdAt: instantSchema,
});
/** Normal staff rosters exclude medical notes, including for front-desk staff. */
export const memberSchema = householdMemberSchema.extend({ emailDeliverable: z.boolean() });
export const memberMedicalNotesSchema = z.strictObject({
  id: idSchema,
  medicalNotes: nullableTextSchema,
  revision: revisionSchema,
});

const memberEditableFieldsSchema = householdMemberSchema.pick({
  firstName: true, lastName: true, email: true, phone: true, photoKey: true,
  dateOfBirth: true, status: true, emergencyContacts: true, emailOptOut: true,
});
export const createMemberRequestSchema = memberEditableFieldsSchema.partial().extend({
  householdId: idSchema,
  firstName: nameSchema,
  lastName: nameSchema,
});
/** The household is immutable here; moving a member needs an explicit service operation. */
export const updateMemberRequestSchema = memberEditableFieldsSchema.partial().extend({
  revision: revisionSchema,
});
export const updateMemberMedicalNotesRequestSchema = z.strictObject({
  medicalNotes: nullableTextSchema,
  revision: revisionSchema,
});
export const anonymizeMemberRequestSchema = z.strictObject({ revision: revisionSchema });
export const memberParamsSchema = z.strictObject({ memberId: idSchema });
export const memberListQuerySchema = paginationSchema.extend({
  search: nameSchema.optional(),
  householdId: idSchema.optional(),
  status: memberStatusSchema.optional(),
  tagId: idSchema.optional(),
});
export const memberResponseSchema = z.strictObject({ data: memberSchema });
export const memberListResponseSchema = listResponseSchema(memberSchema);
export const memberMedicalNotesResponseSchema = z.strictObject({ data: memberMedicalNotesSchema });

/** Contact details only. Billing settings and the household PIN have separate grants. */
export const householdSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  email: z.email().nullable(),
  phone: nullableTextSchema,
  address: householdAddressSchema,
  revision: revisionSchema,
  createdAt: instantSchema,
});
export const householdBillingSettingsSchema = z.strictObject({
  id: idSchema,
  billingDay: z.int32().min(1).max(31),
  familyDiscountBasisPoints: z.int32().min(0).max(10_000),
  revision: revisionSchema,
});
const householdEditableFieldsSchema = householdSchema.pick({
  name: true, email: true, phone: true, address: true,
});
export const createHouseholdRequestSchema = householdEditableFieldsSchema.partial().extend({
  name: nameSchema,
  billingDay: householdBillingSettingsSchema.shape.billingDay.optional(),
  familyDiscountBasisPoints: householdBillingSettingsSchema.shape.familyDiscountBasisPoints.optional(),
});
export const updateHouseholdRequestSchema = householdEditableFieldsSchema.partial().extend({
  revision: revisionSchema,
});
export const updateHouseholdBillingSettingsRequestSchema = householdBillingSettingsSchema.omit({ id: true });
/** A PIN is write-only; neither it nor its hash occurs in any response. */
export const setHouseholdPinRequestSchema = z.strictObject({
  pin: z.string().regex(/^[0-9]{4,8}$/).nullable(),
  revision: revisionSchema,
});
export const householdParamsSchema = z.strictObject({ householdId: idSchema });
export const householdListQuerySchema = paginationSchema.extend({ search: nameSchema.optional() });
export const householdResponseSchema = z.strictObject({ data: householdSchema });
export const householdListResponseSchema = listResponseSchema(householdSchema);
export const householdBillingSettingsResponseSchema = z.strictObject({ data: householdBillingSettingsSchema });

export const memberTagSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  revision: revisionSchema,
  createdAt: instantSchema,
});
export const createMemberTagRequestSchema = memberTagSchema.pick({ name: true, color: true }).partial().extend({
  name: nameSchema,
});
export const updateMemberTagRequestSchema = memberTagSchema.pick({ name: true, color: true }).partial().extend({
  revision: revisionSchema,
});
export const memberTagParamsSchema = z.strictObject({ tagId: idSchema });
export const memberTagLinkSchema = z.strictObject({
  id: idSchema, memberId: idSchema, tagId: idSchema, createdAt: instantSchema,
});
/** Tag links are append-only associations, so they have no editable revision. */
export const addMemberTagRequestSchema = z.strictObject({ tagId: idSchema });
export const memberTagLinkParamsSchema = z.strictObject({ memberId: idSchema, tagId: idSchema });
export const memberTagResponseSchema = z.strictObject({ data: memberTagSchema });
export const memberTagListResponseSchema = listResponseSchema(memberTagSchema);
export const memberTagLinkResponseSchema = z.strictObject({ data: memberTagLinkSchema });

const householdUserFields = {
  id: idSchema, householdId: idSchema, userId: idSchema, createdAt: instantSchema,
};
/** Uniqueness of memberId and household membership are checked by the database/service. */
export const householdUserSchema = z.discriminatedUnion('scope', [
  z.strictObject({ ...householdUserFields, scope: z.literal('payer'), memberId: idSchema.nullable() }),
  z.strictObject({ ...householdUserFields, scope: z.literal('member'), memberId: idSchema }),
]);
export const createHouseholdUserRequestSchema = z.discriminatedUnion('scope', [
  z.strictObject({ userId: idSchema, scope: z.literal('payer'), memberId: idSchema.nullable().optional() }),
  z.strictObject({ userId: idSchema, scope: z.literal('member'), memberId: idSchema }),
]);
export const householdUserParamsSchema = z.strictObject({ householdId: idSchema, householdUserId: idSchema });
export const householdUserResponseSchema = z.strictObject({ data: householdUserSchema });
export const householdUserListResponseSchema = listResponseSchema(householdUserSchema);

/**
 * API declarations only; paths include /api. Handlers scope IDs to the resolved gym.
 * RevisionConflictError uses the shared conflict (409) convention for every revisioned save.
 * Medical writes require BOTH permissions, checked before reading or changing the record.
 */
export const membersContracts = {
  listMembers: { method: 'get', path: '/api/members', permission: { kind: 'staff', capability: 'members.read' },
    query: memberListQuerySchema, response: memberListResponseSchema },
  getMember: { method: 'get', path: '/api/members/{memberId}', permission: { kind: 'staff', capability: 'members.read' },
    params: memberParamsSchema, response: memberResponseSchema },
  createMember: { method: 'post', path: '/api/members', permission: { kind: 'staff', capability: 'members.manage' },
    body: createMemberRequestSchema, response: memberResponseSchema },
  updateMember: { method: 'patch', path: '/api/members/{memberId}', permission: { kind: 'staff', capability: 'members.manage' },
    params: memberParamsSchema, body: updateMemberRequestSchema, response: memberResponseSchema },
  anonymizeMember: { method: 'post', path: '/api/members/{memberId}/anonymize', permission: { kind: 'staff', capability: 'members.anonymize' },
    params: memberParamsSchema, body: anonymizeMemberRequestSchema, response: memberResponseSchema },
  getMedicalNotes: { method: 'get', path: '/api/members/{memberId}/medical-notes', permission: { kind: 'staff', capability: 'medical.read' },
    params: memberParamsSchema, response: memberMedicalNotesResponseSchema },
  updateMedicalNotes: { method: 'patch', path: '/api/members/{memberId}/medical-notes', permission: { kind: 'staff', capability: 'members.manage' },
    additionalPermissions: [{ kind: 'staff', capability: 'medical.read' }],
    params: memberParamsSchema, body: updateMemberMedicalNotesRequestSchema, response: memberMedicalNotesResponseSchema },
  listHouseholds: { method: 'get', path: '/api/households', permission: { kind: 'staff', capability: 'households.manage' },
    query: householdListQuerySchema, response: householdListResponseSchema },
  getHousehold: { method: 'get', path: '/api/households/{householdId}', permission: { kind: 'staff', capability: 'households.manage' },
    params: householdParamsSchema, response: householdResponseSchema },
  createHousehold: { method: 'post', path: '/api/households', permission: { kind: 'staff', capability: 'households.manage' },
    body: createHouseholdRequestSchema, response: householdResponseSchema },
  updateHousehold: { method: 'patch', path: '/api/households/{householdId}', permission: { kind: 'staff', capability: 'households.manage' },
    params: householdParamsSchema, body: updateHouseholdRequestSchema, response: householdResponseSchema },
  getHouseholdBilling: { method: 'get', path: '/api/households/{householdId}/billing-settings', permission: { kind: 'staff', capability: 'billing.read' },
    params: householdParamsSchema, response: householdBillingSettingsResponseSchema },
  updateHouseholdBilling: { method: 'patch', path: '/api/households/{householdId}/billing-settings', permission: { kind: 'staff', capability: 'households.manage' },
    params: householdParamsSchema, body: updateHouseholdBillingSettingsRequestSchema, response: householdBillingSettingsResponseSchema },
  setHouseholdPin: { method: 'put', path: '/api/households/{householdId}/pin', permission: { kind: 'staff', capability: 'households.manage' },
    params: householdParamsSchema, body: setHouseholdPinRequestSchema, response: householdResponseSchema },
  listTags: { method: 'get', path: '/api/member-tags', permission: { kind: 'staff', capability: 'members.read' },
    query: paginationSchema, response: memberTagListResponseSchema },
  createTag: { method: 'post', path: '/api/member-tags', permission: { kind: 'staff', capability: 'tags.manage' },
    body: createMemberTagRequestSchema, response: memberTagResponseSchema },
  updateTag: { method: 'patch', path: '/api/member-tags/{tagId}', permission: { kind: 'staff', capability: 'tags.manage' },
    params: memberTagParamsSchema, body: updateMemberTagRequestSchema, response: memberTagResponseSchema },
  addTag: { method: 'post', path: '/api/members/{memberId}/tags', permission: { kind: 'staff', capability: 'tags.manage' },
    params: memberParamsSchema, body: addMemberTagRequestSchema, response: memberTagLinkResponseSchema },
  removeTag: { method: 'delete', path: '/api/members/{memberId}/tags/{tagId}', permission: { kind: 'staff', capability: 'tags.manage' },
    params: memberTagLinkParamsSchema, response: z.strictObject({ data: z.null() }) },
  listHouseholdUsers: { method: 'get', path: '/api/households/{householdId}/users', permission: { kind: 'staff', capability: 'portal_access.manage' },
    params: householdParamsSchema, query: paginationSchema, response: householdUserListResponseSchema },
  createHouseholdUser: { method: 'post', path: '/api/households/{householdId}/users', permission: { kind: 'staff', capability: 'portal_access.manage' },
    params: householdParamsSchema, body: createHouseholdUserRequestSchema, response: householdUserResponseSchema },
  revokeHouseholdUser: { method: 'delete', path: '/api/households/{householdId}/users/{householdUserId}', permission: { kind: 'staff', capability: 'portal_access.manage' },
    params: householdUserParamsSchema, response: z.strictObject({ data: z.null() }) },
} as const satisfies Record<string, EndpointContract>;

export type MemberStatus = z.infer<typeof memberStatusSchema>;
export type HouseholdAddress = z.infer<typeof householdAddressSchema>;
export type EmergencyContact = z.infer<typeof emergencyContactSchema>;
export type HouseholdMember = z.infer<typeof householdMemberSchema>;
export type Member = z.infer<typeof memberSchema>;
export type MemberMedicalNotes = z.infer<typeof memberMedicalNotesSchema>;
export type CreateMemberRequest = z.infer<typeof createMemberRequestSchema>;
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;
export type UpdateMemberMedicalNotesRequest = z.infer<typeof updateMemberMedicalNotesRequestSchema>;
export type AnonymizeMemberRequest = z.infer<typeof anonymizeMemberRequestSchema>;
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;
export type MemberResponse = z.infer<typeof memberResponseSchema>;
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;
export type Household = z.infer<typeof householdSchema>;
export type HouseholdBillingSettings = z.infer<typeof householdBillingSettingsSchema>;
export type CreateHouseholdRequest = z.infer<typeof createHouseholdRequestSchema>;
export type UpdateHouseholdRequest = z.infer<typeof updateHouseholdRequestSchema>;
export type UpdateHouseholdBillingSettingsRequest = z.infer<typeof updateHouseholdBillingSettingsRequestSchema>;
export type SetHouseholdPinRequest = z.infer<typeof setHouseholdPinRequestSchema>;
export type HouseholdListQuery = z.infer<typeof householdListQuerySchema>;
export type HouseholdResponse = z.infer<typeof householdResponseSchema>;
export type HouseholdListResponse = z.infer<typeof householdListResponseSchema>;
export type MemberTag = z.infer<typeof memberTagSchema>;
export type CreateMemberTagRequest = z.infer<typeof createMemberTagRequestSchema>;
export type UpdateMemberTagRequest = z.infer<typeof updateMemberTagRequestSchema>;
export type MemberTagLink = z.infer<typeof memberTagLinkSchema>;
export type AddMemberTagRequest = z.infer<typeof addMemberTagRequestSchema>;
export type HouseholdUser = z.infer<typeof householdUserSchema>;
export type CreateHouseholdUserRequest = z.infer<typeof createHouseholdUserRequestSchema>;
