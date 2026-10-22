// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { idSchema, instantSchema, listResponseSchema, paginationSchema } from './common.js';
import type { RoutePermission } from '../permissions.js';

const manageDevices = { kind: 'staff', capability: 'kiosk_devices.manage' } as const satisfies RoutePermission;
const checkin = { kind: 'kiosk', capability: 'checkin' } as const satisfies RoutePermission;
export const kioskDeviceIdParamsSchema = z.strictObject({ id: idSchema });
export const registerKioskDeviceRequestSchema = z.strictObject({ name: z.string().trim().min(1) });
/** Registration and revocation are the only mutations; the locked device table has no revision. */
export const kioskDeviceSchema = z.strictObject({
  id: idSchema, name: z.string().min(1), createdAt: instantSchema,
  revokedAt: instantSchema.nullable(), lastSeenAt: instantSchema.nullable(),
});
export const kioskDeviceResponseSchema = z.strictObject({ data: kioskDeviceSchema });
export const kioskDeviceListResponseSchema = listResponseSchema(kioskDeviceSchema);
/** The raw bearer token is shown exactly once. Reads and revocation never return it or its hash. */
export const registerKioskDeviceResponseSchema = z.strictObject({
  data: z.strictObject({ device: kioskDeviceSchema, token: z.string().min(1) }),
});
const nameAndPinSchema = z.strictObject({
  name: z.string().trim().min(1), pin: z.string().regex(/^[0-9]{4,12}$/),
});
export const kioskLookupRequestSchema = nameAndPinSchema;
/** One Unicode grapheme, preserving initials in scripts outside the Latin alphabet. */
const lastInitialSchema = z.string().refine(
  (value) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length === 1,
  'Only the last initial may be displayed',
);
export const kioskMemberIdentitySchema = z.strictObject({
  id: idSchema, firstName: z.string().min(1), lastInitial: lastInitialSchema, photoKey: z.string().min(1).nullable(),
});
export const kioskLookupResponseSchema = z.strictObject({
  data: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('select_member'), members: z.array(kioskMemberIdentitySchema).min(1) }),
    z.strictObject({ status: z.literal('see_front_desk') }),
  ]),
});
/** Omitted session selects a booking or prompts; null explicitly chooses open mat. */
export const kioskMemberCheckinSelectionSchema = z.strictObject({
  memberId: idSchema, sessionId: idSchema.nullable().optional(),
});
/** Recheck the PIN and each member's household on submission; cached search results are not authority. */
export const kioskNamePinCheckinRequestSchema = nameAndPinSchema.extend({
  checkins: z.array(kioskMemberCheckinSelectionSchema).min(1).refine(
    (items) => new Set(items.map((item) => item.memberId)).size === items.length,
    'A family request must select each member only once',
  ),
});
export const kioskQrCheckinRequestSchema = z.strictObject({
  code: z.string().min(1).max(2048), sessionId: idSchema.nullable().optional(),
});
export const kioskSessionChoiceSchema = z.strictObject({
  id: idSchema, name: z.string().min(1), startsAt: instantSchema, endsAt: instantSchema,
}).refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
  path: ['endsAt'], message: 'Session must end after it starts',
});
/** Shared-screen results are a closed union: no free-text reason, billing state, amount, or private notes. */
export const kioskCheckinResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('checked_in'), member: kioskMemberIdentitySchema }),
  z.strictObject({ status: z.literal('already_checked_in'), member: kioskMemberIdentitySchema }),
  z.strictObject({ status: z.literal('select_session'), member: kioskMemberIdentitySchema, sessions: z.array(kioskSessionChoiceSchema).min(1) }),
  z.strictObject({ status: z.literal('see_front_desk') }),
]);
export const kioskCheckinResponseSchema = z.strictObject({ data: kioskCheckinResultSchema });
/** Results retain the order of the requested family selections. */
export const kioskFamilyCheckinResponseSchema = z.strictObject({ data: z.array(kioskCheckinResultSchema).min(1) });
export const kioskContracts = {
  listDevices: { method: 'get', path: '/api/kiosk/devices', permission: manageDevices, query: paginationSchema, response: kioskDeviceListResponseSchema },
  registerDevice: { method: 'post', path: '/api/kiosk/devices', permission: manageDevices, body: registerKioskDeviceRequestSchema, response: registerKioskDeviceResponseSchema },
  revokeDevice: { method: 'post', path: '/api/kiosk/devices/{id}/revoke', permission: manageDevices, params: kioskDeviceIdParamsSchema, response: kioskDeviceResponseSchema },
  lookup: { method: 'post', path: '/api/kiosk/lookup', permission: checkin, body: kioskLookupRequestSchema, response: kioskLookupResponseSchema },
  checkinNamePin: { method: 'post', path: '/api/kiosk/checkin', permission: checkin, body: kioskNamePinCheckinRequestSchema, response: kioskFamilyCheckinResponseSchema },
  checkinQr: { method: 'post', path: '/api/kiosk/checkin/qr', permission: checkin, body: kioskQrCheckinRequestSchema, response: kioskCheckinResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type KioskDevice = z.infer<typeof kioskDeviceSchema>;
export type RegisterKioskDeviceRequest = z.infer<typeof registerKioskDeviceRequestSchema>;
export type RegisterKioskDeviceResponse = z.infer<typeof registerKioskDeviceResponseSchema>;
export type KioskMemberIdentity = z.infer<typeof kioskMemberIdentitySchema>;
export type KioskLookupRequest = z.infer<typeof kioskLookupRequestSchema>;
export type KioskLookupResponse = z.infer<typeof kioskLookupResponseSchema>;
export type KioskNamePinCheckinRequest = z.infer<typeof kioskNamePinCheckinRequestSchema>;
export type KioskQrCheckinRequest = z.infer<typeof kioskQrCheckinRequestSchema>;
export type KioskCheckinResult = z.infer<typeof kioskCheckinResultSchema>;
export type KioskSessionChoice = z.infer<typeof kioskSessionChoiceSchema>;

export type KioskDeviceResponse = z.infer<typeof kioskDeviceResponseSchema>;
export type KioskDeviceListResponse = z.infer<typeof kioskDeviceListResponseSchema>;
export type KioskCheckinResponse = z.infer<typeof kioskCheckinResponseSchema>;
export type KioskFamilyCheckinResponse = z.infer<typeof kioskFamilyCheckinResponseSchema>;
