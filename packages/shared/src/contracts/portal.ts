// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { memberStatusSchema, classSessionStatusSchema, membershipStatusSchema, billingIntervalSchema,
  attendanceSourceSchema, classKindSchema, invoiceKindSchema, invoiceStatusSchema } from './states.js';
import type { EndpointContract } from './definition.js';
import { householdParamsSchema, householdUserParamsSchema, householdUserSchema } from './members.js';
import {
  amountCentsSchema, currencySchema, dateSchema, idSchema, instantSchema,
  listResponseSchema, paginationSchema, revisionSchema, taxRateMillionthsSchema,
} from './common.js';
import {
  waiverPdfResponseSchema, waiverSignatureListResponseSchema, waiverSignatureParamsSchema,
  waiverSignatureResponseSchema, waiverSignRequestSchema, waiverTemplateSchema,
  waiverUploadRequestSchema, waiverUploadResponseSchema,
} from './waivers.js';

export const portalMemberParamsSchema = z.strictObject({ memberId: idSchema });
export const portalInvoiceParamsSchema = z.strictObject({ invoiceId: idSchema });
// Context is resolved from the authenticated user, never accepted as request input.
export const portalContextSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('payer'), householdId: idSchema, memberId: idSchema.nullable() }),
  z.strictObject({ role: z.literal('member'), householdId: idSchema, memberId: idSchema }),
]);
export const portalContextResponseSchema = z.strictObject({ data: portalContextSchema });
export const portalEmergencyContactSchema = z.strictObject({
  name: z.string().trim().min(1), relationship: z.string().trim().min(1), phone: z.string().trim().min(1),
  email: z.email().optional(),
});
export const portalMemberSchema = z.strictObject({
  id: idSchema, firstName: z.string().min(1), lastName: z.string().min(1),
  email: z.email().nullable(), phone: z.string().nullable(), dateOfBirth: dateSchema.nullable(),
  photoKey: z.string().nullable(),
  status: memberStatusSchema,
  emergencyContacts: z.array(portalEmergencyContactSchema), revision: revisionSchema,
});
export const portalMemberResponseSchema = z.strictObject({ data: portalMemberSchema });
export const portalMemberListResponseSchema = listResponseSchema(portalMemberSchema);
// Payers edit household contacts and children's profiles; membership state and
// check-in credentials are absent. A stale revision returns the shared conflict error.
export const portalMemberUpdateRequestSchema = portalMemberSchema.pick({
  firstName: true, lastName: true, email: true, phone: true, dateOfBirth: true,
  photoKey: true, emergencyContacts: true,
}).partial().extend({ revision: revisionSchema });
export const portalHouseholdSchema = z.strictObject({
  id: idSchema, name: z.string().min(1), email: z.email().nullable(), phone: z.string().nullable(),
  address: z.record(z.string(), z.string()), billingDay: z.int32().min(1).max(31), revision: revisionSchema,
});
export const portalHouseholdUpdateRequestSchema = portalHouseholdSchema.pick({
  name: true, email: true, phone: true, address: true,
}).partial().extend({ revision: revisionSchema });
export const portalHouseholdResponseSchema = z.strictObject({ data: portalHouseholdSchema });

export const portalScheduleQuerySchema = paginationSchema.extend({
  from: instantSchema, to: instantSchema,
}).refine((v) => Date.parse(v.to) > Date.parse(v.from), { path: ['to'], message: 'End must follow start' });
// Staff class notes and other members' rosters are never included.
export const portalSessionSchema = z.strictObject({
  id: idSchema, name: z.string().min(1), startsAt: instantSchema, endsAt: instantSchema,
  coachId: idSchema.nullable(), capacity: z.int32().positive().nullable(),
  status: classSessionStatusSchema, revision: revisionSchema,
}).refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), { path: ['endsAt'], message: 'End must follow start' });
export const portalScheduleResponseSchema = listResponseSchema(portalSessionSchema);
export const portalMembershipSchema = z.strictObject({
  id: idSchema, memberId: idSchema, planId: idSchema,
  status: membershipStatusSchema,
  interval: billingIntervalSchema, startsOn: dateSchema, nextDueOn: dateSchema,
  trialEndsOn: dateSchema.nullable(), commitmentEndsOn: dateSchema.nullable(), revision: revisionSchema,
});
export const portalMembershipListResponseSchema = listResponseSchema(portalMembershipSchema);
export const portalAttendanceSchema = z.strictObject({
  id: idSchema, memberId: idSchema, sessionId: idSchema.nullable(), programId: idSchema.nullable(),
  occurredAt: instantSchema, source: attendanceSourceSchema, kind: classKindSchema,
});
export const portalAttendanceQuerySchema = paginationSchema.extend({
  programId: idSchema.optional(), tagId: idSchema.optional(), since: instantSchema.optional(),
});
export const portalAttendanceResponseSchema = listResponseSchema(portalAttendanceSchema);
export const portalRankHistorySchema = z.strictObject({
  id: idSchema, memberId: idSchema, programId: idSchema, rankId: idSchema, rankSystemId: idSchema,
  subRank: z.int32().nonnegative(), promotedAt: instantSchema,
});
export const portalProgressResponseSchema = z.strictObject({ data: z.strictObject({
  history: z.array(portalRankHistorySchema),
  criteria: z.array(z.strictObject({
    programId: idSchema, rankId: idSchema, criterionId: z.string().min(1), labelKey: z.string().min(1),
    current: z.number().nonnegative(), required: z.number().nonnegative(), eligible: z.boolean(),
  })),
}) });
export const portalCheckinCodeResponseSchema = z.strictObject({ data: z.strictObject({
  memberId: idSchema, code: z.string().min(1), version: z.int32().positive(), revision: revisionSchema,
}) });
export const portalRegenerateCheckinRequestSchema = z.strictObject({ revision: revisionSchema });

export const portalInvoiceSchema = z.strictObject({
  id: idSchema, number: z.int32().positive(), kind: invoiceKindSchema,
  status: invoiceStatusSchema.exclude(['draft']),
  dueOn: dateSchema, amountCents: amountCentsSchema.nonnegative(), currency: currencySchema,
  paidAt: instantSchema.nullable(),
});
export const portalInvoiceLineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: idSchema, kind: z.enum(['membership', 'signup_fee', 'charge', 'discount']), description: z.string(), amountCents: amountCentsSchema, currency: currencySchema, quantity: z.int32().positive(), taxRateMillionths: z.null(), taxInclusive: z.null() }),
  z.strictObject({ id: idSchema, kind: z.literal('tax'), description: z.string(), amountCents: amountCentsSchema, currency: currencySchema, quantity: z.int32().positive(), taxRateMillionths: taxRateMillionthsSchema, taxInclusive: z.boolean() }),
]);
export const portalInvoiceListQuerySchema = paginationSchema.extend({ status: portalInvoiceSchema.shape.status.optional() });
export const portalInvoiceListResponseSchema = listResponseSchema(portalInvoiceSchema);
export const portalInvoiceDetailSchema = z.strictObject({
  invoice: portalInvoiceSchema, lines: z.array(portalInvoiceLineSchema),
}).refine((v) => v.lines.every((line) => line.currency === v.invoice.currency), {
  path: ['lines'], message: 'Invoice lines must use the invoice currency',
});
export const portalInvoiceResponseSchema = z.strictObject({ data: portalInvoiceDetailSchema });
export const portalReceiptResponseSchema = z.strictObject({
  data: z.strictObject({ url: z.url({ protocol: /^https?$/ }), expiresAt: instantSchema }),
});
export const portalPaymentMethodSchema = z.strictObject({
  id: idSchema, brand: z.string().nullable(), last4: z.string().regex(/^[0-9]{4}$/).nullable(),
  expiryMonth: z.int32().min(1).max(12).nullable(), expiryYear: z.int32().min(2000).nullable(), isDefault: z.boolean(),
});
export const portalPaymentMethodsResponseSchema = z.strictObject({ data: z.array(portalPaymentMethodSchema)
  .refine((v) => v.filter((card) => card.isDefault).length <= 1, 'Only one card may be the default') });
export const portalCheckoutResponseSchema = z.strictObject({ data: z.strictObject({
  url: z.url({ protocol: /^https?$/ }), expiresAt: instantSchema,
}) });
export const portalWaiverListQuerySchema = paginationSchema.extend({ memberId: idSchema.optional() });
export const portalPendingWaiversResponseSchema = listResponseSchema(z.strictObject({
  memberId: idSchema, template: waiverTemplateSchema,
}));

// Signed links have narrower projections than logged-in users. No contacts,
// medical notes, hashes of credentials, or unrelated household resources escape.
export const portalLinkMemberSchema = portalMemberSchema.pick({ id: true, firstName: true, lastName: true, dateOfBirth: true, revision: true });
export const portalSignedLinkDataSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ purpose: z.literal('pay_invoice'), invoice: portalInvoiceDetailSchema }),
  z.strictObject({ purpose: z.literal('update_card'), paymentMethods: portalPaymentMethodsResponseSchema.shape.data }),
  z.strictObject({ purpose: z.literal('sign_waiver'), member: portalLinkMemberSchema, templates: z.array(waiverTemplateSchema), signatures: z.array(waiverSignatureResponseSchema.shape.data) }),
  z.strictObject({ purpose: z.literal('onboarding'), members: z.array(portalLinkMemberSchema), templates: z.array(waiverTemplateSchema), signatures: z.array(waiverSignatureResponseSchema.shape.data), paymentMethods: portalPaymentMethodsResponseSchema.shape.data }),
]);
export const portalSignedLinkResponseSchema = z.strictObject({ data: portalSignedLinkDataSchema });


// Selectors identify resources only. forHousehold resolves the grant on every
// operation; self waiver endpoints restrict to the linked member, while
// household endpoints require the payer grant. An ID outside the grant returns not_found, including another household's ID.
// Booking endpoints and projections are owned by bookings.ts.
export const portalContracts = {
  context: { method: 'get', path: '/api/portal/context', permission: { kind: 'member', capability: 'profile.read' }, response: portalContextResponseSchema },
  profile: { method: 'get', path: '/api/portal/members/{memberId}', permission: { kind: 'member', capability: 'profile.read' }, params: portalMemberParamsSchema, response: portalMemberResponseSchema },
  members: { method: 'get', path: '/api/portal/members', permission: { kind: 'member', capability: 'household.read' }, query: paginationSchema, response: portalMemberListResponseSchema },
  updateMember: { method: 'patch', path: '/api/portal/members/{memberId}', permission: { kind: 'member', capability: 'household.manage' }, params: portalMemberParamsSchema, body: portalMemberUpdateRequestSchema, response: portalMemberResponseSchema },
  household: { method: 'get', path: '/api/portal/household', permission: { kind: 'member', capability: 'household.read' }, response: portalHouseholdResponseSchema },
  updateHousehold: { method: 'patch', path: '/api/portal/household', permission: { kind: 'member', capability: 'household.manage' }, body: portalHouseholdUpdateRequestSchema, response: portalHouseholdResponseSchema },
  schedule: { method: 'get', path: '/api/portal/schedule', permission: { kind: 'member', capability: 'bookings.self' }, query: portalScheduleQuerySchema, response: portalScheduleResponseSchema },
  memberships: { method: 'get', path: '/api/portal/members/{memberId}/memberships', permission: { kind: 'member', capability: 'profile.read' }, params: portalMemberParamsSchema, query: paginationSchema, response: portalMembershipListResponseSchema },
  attendance: { method: 'get', path: '/api/portal/members/{memberId}/attendance', permission: { kind: 'member', capability: 'attendance.read' }, params: portalMemberParamsSchema, query: portalAttendanceQuerySchema, response: portalAttendanceResponseSchema },
  progress: { method: 'get', path: '/api/portal/members/{memberId}/progress', permission: { kind: 'member', capability: 'progress.read' }, params: portalMemberParamsSchema, response: portalProgressResponseSchema },
  checkinCode: { method: 'get', path: '/api/portal/members/{memberId}/checkin-code', permission: { kind: 'member', capability: 'checkin.manage' }, params: portalMemberParamsSchema, response: portalCheckinCodeResponseSchema },
  regenerateCheckin: { method: 'post', path: '/api/portal/members/{memberId}/checkin-code', permission: { kind: 'member', capability: 'checkin.manage' }, params: portalMemberParamsSchema, body: portalRegenerateCheckinRequestSchema, response: portalCheckinCodeResponseSchema },
  invoices: { method: 'get', path: '/api/portal/invoices', permission: { kind: 'member', capability: 'billing.manage' }, query: portalInvoiceListQuerySchema, response: portalInvoiceListResponseSchema },
  invoice: { method: 'get', path: '/api/portal/invoices/{invoiceId}', permission: { kind: 'member', capability: 'billing.manage' }, params: portalInvoiceParamsSchema, response: portalInvoiceResponseSchema },
  receipt: { method: 'get', path: '/api/portal/invoices/{invoiceId}/receipt', permission: { kind: 'member', capability: 'billing.manage' }, params: portalInvoiceParamsSchema, response: portalReceiptResponseSchema },
  payInvoice: { method: 'post', path: '/api/portal/invoices/{invoiceId}/checkout', permission: { kind: 'member', capability: 'billing.manage' }, params: portalInvoiceParamsSchema, response: portalCheckoutResponseSchema },
  paymentMethods: { method: 'get', path: '/api/portal/payment-methods', permission: { kind: 'member', capability: 'billing.manage' }, response: portalPaymentMethodsResponseSchema },
  updateCard: { method: 'post', path: '/api/portal/payment-methods/checkout', permission: { kind: 'member', capability: 'billing.manage' }, response: portalCheckoutResponseSchema },
  pendingWaivers: { method: 'get', path: '/api/portal/waivers/pending', permission: { kind: 'member', capability: 'waivers.self' }, query: portalWaiverListQuerySchema, response: portalPendingWaiversResponseSchema },
  signedWaivers: { method: 'get', path: '/api/portal/waivers', permission: { kind: 'member', capability: 'waivers.self' }, query: portalWaiverListQuerySchema, response: waiverSignatureListResponseSchema },
  signWaiver: { method: 'post', path: '/api/portal/waivers', permission: { kind: 'member', capability: 'waivers.self' }, body: waiverSignRequestSchema, response: waiverSignatureResponseSchema },
  pendingHouseholdWaivers: { method: 'get', path: '/api/portal/household/waivers/pending', permission: { kind: 'member', capability: 'waivers.household' }, query: portalWaiverListQuerySchema, response: portalPendingWaiversResponseSchema },
  signedHouseholdWaivers: { method: 'get', path: '/api/portal/household/waivers', permission: { kind: 'member', capability: 'waivers.household' }, query: portalWaiverListQuerySchema, response: waiverSignatureListResponseSchema },
  signHouseholdWaiver: { method: 'post', path: '/api/portal/household/waivers', permission: { kind: 'member', capability: 'waivers.household' }, body: waiverSignRequestSchema, response: waiverSignatureResponseSchema },
  householdWaiverPdf: { method: 'get', path: '/api/portal/household/waivers/{signatureId}/pdf', permission: { kind: 'member', capability: 'waivers.household' }, params: waiverSignatureParamsSchema, response: waiverPdfResponseSchema },
  waiverPdf: { method: 'get', path: '/api/portal/waivers/{signatureId}/pdf', permission: { kind: 'member', capability: 'waivers.self' }, params: waiverSignatureParamsSchema, response: waiverPdfResponseSchema },
} as const satisfies Record<string, EndpointContract>;

// A verified link principal supplies linkId and the resource; no body may choose
// a different household, invoice, or member. Middleware consumes the raw token.
export const portalSignedLinkContracts = {
  invoice: { method: 'get', path: '/api/links/pay-invoice', permission: { kind: 'signed_link', purpose: 'pay_invoice' }, response: z.strictObject({ data: portalSignedLinkDataSchema.options[0] }) },
  payInvoice: { method: 'post', path: '/api/links/pay-invoice/checkout', permission: { kind: 'signed_link', purpose: 'pay_invoice' }, response: portalCheckoutResponseSchema },
  card: { method: 'get', path: '/api/links/update-card', permission: { kind: 'signed_link', purpose: 'update_card' }, response: z.strictObject({ data: portalSignedLinkDataSchema.options[1] }) },
  updateCard: { method: 'post', path: '/api/links/update-card/checkout', permission: { kind: 'signed_link', purpose: 'update_card' }, response: portalCheckoutResponseSchema },
  waiver: { method: 'get', path: '/api/links/sign-waiver', permission: { kind: 'signed_link', purpose: 'sign_waiver' }, response: z.strictObject({ data: portalSignedLinkDataSchema.options[2] }) },
  signWaiver: { method: 'post', path: '/api/links/sign-waiver', permission: { kind: 'signed_link', purpose: 'sign_waiver' }, body: waiverSignRequestSchema.omit({ memberId: true }), response: waiverSignatureResponseSchema },
  onboarding: { method: 'get', path: '/api/links/onboarding', permission: { kind: 'signed_link', purpose: 'onboarding' }, response: z.strictObject({ data: portalSignedLinkDataSchema.options[3] }) },
  onboardWaiver: { method: 'post', path: '/api/links/onboarding/waivers', permission: { kind: 'signed_link', purpose: 'onboarding' }, body: waiverSignRequestSchema, response: waiverSignatureResponseSchema },
  onboardCard: { method: 'post', path: '/api/links/onboarding/checkout', permission: { kind: 'signed_link', purpose: 'onboarding' }, response: portalCheckoutResponseSchema },
} as const satisfies Record<string, EndpointContract>;

/** Additive signed-link actions. A browser receipt binds Checkout completion to its link. */
export const signedLinkCardUnavailableSchema = z.strictObject({ cardSetupUnavailable: z.literal(true) });
export const signedLinkActionContracts = {
  uploadWaiver: { method: 'post', path: '/api/links/sign-waiver/signature-images', permission: { kind: 'signed_link', purpose: 'sign_waiver' }, body: waiverUploadRequestSchema.omit({ memberId: true }), response: waiverUploadResponseSchema },
  uploadOnboarding: { method: 'post', path: '/api/links/onboarding/signature-images', permission: { kind: 'signed_link', purpose: 'onboarding' }, body: waiverUploadRequestSchema, response: waiverUploadResponseSchema },
  completeInvoice: { method: 'post', path: '/api/links/pay-invoice/complete', permission: { kind: 'signed_link', purpose: 'pay_invoice' }, response: z.strictObject({ data: z.strictObject({ completed: z.boolean() }) }) },
  completeCard: { method: 'post', path: '/api/links/update-card/complete', permission: { kind: 'signed_link', purpose: 'update_card' }, response: z.strictObject({ data: z.strictObject({ completed: z.boolean() }) }) },
  completeOnboarding: { method: 'post', path: '/api/links/onboarding/complete', permission: { kind: 'signed_link', purpose: 'onboarding' }, response: z.strictObject({ data: z.strictObject({ completed: z.boolean() }) }) },
} as const satisfies Record<string, EndpointContract>;

export type PortalContext = z.infer<typeof portalContextSchema>;
export type PortalEmergencyContact = z.infer<typeof portalEmergencyContactSchema>;
export type PortalMember = z.infer<typeof portalMemberSchema>;
export type PortalMemberUpdateRequest = z.infer<typeof portalMemberUpdateRequestSchema>;
export type PortalHousehold = z.infer<typeof portalHouseholdSchema>;
export type PortalHouseholdUpdateRequest = z.infer<typeof portalHouseholdUpdateRequestSchema>;
export type PortalScheduleQuery = z.infer<typeof portalScheduleQuerySchema>;
export type PortalSession = z.infer<typeof portalSessionSchema>;
export type PortalMembership = z.infer<typeof portalMembershipSchema>;
export type PortalAttendance = z.infer<typeof portalAttendanceSchema>;
export type PortalRankHistory = z.infer<typeof portalRankHistorySchema>;
export type PortalProgressResponse = z.infer<typeof portalProgressResponseSchema>;
export type PortalCheckinCodeResponse = z.infer<typeof portalCheckinCodeResponseSchema>;
export type PortalInvoice = z.infer<typeof portalInvoiceSchema>;
export type PortalInvoiceDetail = z.infer<typeof portalInvoiceDetailSchema>;
export type PortalPaymentMethod = z.infer<typeof portalPaymentMethodSchema>;
export type PortalCheckoutResponse = z.infer<typeof portalCheckoutResponseSchema>;
export type PortalSignedLinkData = z.infer<typeof portalSignedLinkDataSchema>;

export type PortalReceiptResponse = z.infer<typeof portalReceiptResponseSchema>;

const portalInviteFields = { email: z.email().max(254), delivery: z.enum(['email', 'print']) };
export const portalInvitationRequestSchema = z.discriminatedUnion('scope', [
  z.strictObject({ ...portalInviteFields, scope: z.literal('payer'), memberId: idSchema.nullable().optional() }),
  z.strictObject({ ...portalInviteFields, scope: z.literal('member'), memberId: idSchema }),
]);
export const portalInvitationResponseSchema = z.strictObject({ data: z.discriminatedUnion('delivery', [
  z.strictObject({ delivery: z.literal('email'), login: householdUserSchema }),
  z.strictObject({ delivery: z.literal('print'), login: householdUserSchema, invitationUrl: z.url({ protocol: /^https?$/ }) }),
]) });
export const portalClaimRequestSchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(12).max(128).optional() });
export const portalOnboardingClaimRequestSchema = z.strictObject({ email: z.email().max(254), password: z.string().min(12).max(128).optional() });
export const portalAccessContracts = {
  logins: { method: 'get', path: '/api/households/{householdId}/portal-logins', permission: { kind: 'staff', capability: 'portal_access.manage' }, params: householdParamsSchema, query: paginationSchema, response: listResponseSchema(z.discriminatedUnion('scope', [householdUserSchema.options[0].extend({ email: z.email().optional() }), householdUserSchema.options[1].extend({ email: z.email().optional() })])) },
  resetPassword: { method: 'post', path: '/api/households/{householdId}/users/{householdUserId}/password', permission: { kind: 'staff', capability: 'portal_access.manage' }, params: householdUserParamsSchema, body: z.strictObject({ newPassword: z.string().min(12).max(128) }), response: z.strictObject({ data: z.null() }) },
  invite: { method: 'post', path: '/api/households/{householdId}/portal-invitations', permission: { kind: 'staff', capability: 'portal_access.manage' }, params: householdParamsSchema, body: portalInvitationRequestSchema, response: portalInvitationResponseSchema },
  claim: { method: 'post', path: '/api/portal/invitations/accept', permission: { kind: 'public' }, body: portalClaimRequestSchema, response: z.strictObject({ data: z.null() }) },
  claimOnboarding: { method: 'post', path: '/api/links/onboarding/portal', permission: { kind: 'signed_link', purpose: 'onboarding' }, body: portalOnboardingClaimRequestSchema, response: z.strictObject({ data: z.null() }) },
} as const satisfies Record<string, EndpointContract>;
export type PortalInvitationRequest = z.infer<typeof portalInvitationRequestSchema>;
