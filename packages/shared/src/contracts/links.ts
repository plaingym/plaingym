// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import {
  idSchema, instantSchema, listResponseSchema, paginationSchema,
} from './common.js';

export const signedLinkPurposeSchema = z.enum(['onboarding', 'pay_invoice', 'update_card', 'sign_waiver']);
const signedLinkFields = {
  id: idSchema,
  householdId: idSchema,
  campaignId: idSchema.nullable(),
  expiresAt: instantSchema,
  usedAt: instantSchema.nullable(),
  revokedAt: instantSchema.nullable(),
  createdBy: idSchema.nullable(),
  createdAt: instantSchema,
};
/** Typed resources match the database CHECK; metadata never includes a token or its hash. */
export const signedLinkSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ ...signedLinkFields, purpose: z.literal('pay_invoice'), invoiceId: idSchema, memberId: z.null() }),
  z.strictObject({ ...signedLinkFields, purpose: z.literal('sign_waiver'), invoiceId: z.null(), memberId: idSchema }),
  z.strictObject({ ...signedLinkFields, purpose: z.literal('update_card'), invoiceId: z.null(), memberId: z.null() }),
  z.strictObject({ ...signedLinkFields, purpose: z.literal('onboarding'), invoiceId: z.null(), memberId: z.null() }),
]);
const createLinkFields = {
  householdId: idSchema,
  expiresAt: instantSchema,
  campaignId: idSchema.nullable().optional(),
};
/** The service checks expiry with its clock and resolves each resource through its household. */
export const createSignedLinkRequestSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ ...createLinkFields, purpose: z.literal('pay_invoice'), invoiceId: idSchema }),
  z.strictObject({ ...createLinkFields, purpose: z.literal('sign_waiver'), memberId: idSchema }),
  z.strictObject({ ...createLinkFields, purpose: z.literal('update_card') }),
  z.strictObject({ ...createLinkFields, purpose: z.literal('onboarding') }),
]);
/** Only this creation result exposes the opaque secret, for a front-desk tablet or printed link. */
export const createSignedLinkResponseSchema = z.strictObject({
  data: z.strictObject({
    link: signedLinkSchema,
    token: z.string().min(32).regex(/^[A-Za-z0-9_-]+$/),
  }),
});
export const signedLinkResponseSchema = z.strictObject({ data: signedLinkSchema });
export const signedLinkListResponseSchema = listResponseSchema(signedLinkSchema);
export const signedLinkParamsSchema = z.strictObject({ linkId: idSchema });
export const signedLinkListQuerySchema = paginationSchema.extend({
  householdId: idSchema.optional(),
  campaignId: idSchema.optional(),
  purpose: signedLinkPurposeSchema.optional(),
});
export const signedLinkTokenParamsSchema = z.strictObject({
  token: createSignedLinkResponseSchema.shape.data.shape.token,
});

/** Days after campaign creation, strictly increasing; [] disables automatic reminders. */
export const campaignReminderScheduleSchema = z.array(z.int32().positive())
  .refine((days) => days.every((day, index) => index === 0 || day > days[index - 1]!),
    'Reminder days must be unique and increasing');
export const linkCampaignSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1),
  purpose: signedLinkPurposeSchema,
  createdBy: idSchema.nullable(),
  reminderSchedule: campaignReminderScheduleSchema,
  completedAt: instantSchema.nullable(),
  createdAt: instantSchema,
});
const campaignFields = {
  name: linkCampaignSchema.shape.name,
  expiresAt: instantSchema,
  reminderSchedule: campaignReminderScheduleSchema,
};
const householdRecipientSchema = z.strictObject({ householdId: idSchema });
const invoiceRecipientSchema = z.strictObject({ householdId: idSchema, invoiceId: idSchema });
const waiverRecipientSchema = z.strictObject({ householdId: idSchema, memberId: idSchema });
const householdRecipientsSchema = z.array(householdRecipientSchema).min(1)
  .refine((recipients) => new Set(recipients.map((recipient) => recipient.householdId)).size === recipients.length,
    'A household may appear only once');
const invoiceRecipientsSchema = z.array(invoiceRecipientSchema).min(1)
  .refine((recipients) => new Set(recipients.map((recipient) => recipient.invoiceId)).size === recipients.length,
    'An invoice may appear only once');
const waiverRecipientsSchema = z.array(waiverRecipientSchema).min(1)
  .refine((recipients) => new Set(recipients.map((recipient) => recipient.memberId)).size === recipients.length,
    'A member may appear only once');
/** A campaign uses one purpose. Recipients specify exactly the resource that purpose grants. */
export const createLinkCampaignRequestSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ ...campaignFields, purpose: z.literal('onboarding'), recipients: householdRecipientsSchema }),
  z.strictObject({ ...campaignFields, purpose: z.literal('update_card'), recipients: householdRecipientsSchema }),
  z.strictObject({ ...campaignFields, purpose: z.literal('pay_invoice'), recipients: invoiceRecipientsSchema }),
  z.strictObject({ ...campaignFields, purpose: z.literal('sign_waiver'), recipients: waiverRecipientsSchema }),
]);
export const campaignRecipientStateSchema = z.enum(['pending', 'completed', 'expired', 'revoked']);
/** Counts partition link rows: used first, then revoked, then expired, otherwise pending. */
export const linkCampaignProgressSchema = z.strictObject({
  total: z.int().nonnegative(),
  pending: z.int().nonnegative(),
  completed: z.int().nonnegative(),
  expired: z.int().nonnegative(),
  revoked: z.int().nonnegative(),
}).refine((counts) => counts.total === counts.pending + counts.completed + counts.expired + counts.revoked,
  'Campaign counts must add up to the total');
export const linkCampaignDetailSchema = z.strictObject({
  campaign: linkCampaignSchema,
  progress: linkCampaignProgressSchema,
});
export const campaignRecipientSchema = z.strictObject({
  link: signedLinkSchema,
  state: campaignRecipientStateSchema,
});
export const linkCampaignParamsSchema = z.strictObject({ campaignId: idSchema });
export const linkCampaignListQuerySchema = paginationSchema.extend({
  purpose: signedLinkPurposeSchema.optional(),
});
export const campaignRecipientListQuerySchema = paginationSchema.extend({
  state: campaignRecipientStateSchema.optional(),
});
export const linkCampaignResponseSchema = z.strictObject({ data: linkCampaignDetailSchema });
export const linkCampaignListResponseSchema = listResponseSchema(linkCampaignDetailSchema);
export const campaignRecipientListResponseSchema = listResponseSchema(campaignRecipientSchema);
export const remindLinkCampaignResponseSchema = z.strictObject({
  data: z.strictObject({ queued: z.int().nonnegative() }),
});

/**
 * API declarations only. Creation and sending mint a fresh single-use link; later metadata
 * reads and campaign results cannot recover its token. Reminders stop after completion.
 * Campaign definitions and link resources are immutable: there is no revisionless edit API.
 * Redeemers use the matching signed_link permission and forHousehold, rechecking expiry,
 * usedAt and revokedAt in the transaction. Onboarding grants members, waivers and cards,
 * never invoices; update_card grants masked cards, never invoices or household profiles.
 */
export const linksContracts = {
  createLink: { method: 'post', path: '/api/links', permission: { kind: 'staff', capability: 'links.send' },
    body: createSignedLinkRequestSchema, response: createSignedLinkResponseSchema },
  sendLink: { method: 'post', path: '/api/links/send', permission: { kind: 'staff', capability: 'links.send' },
    body: createSignedLinkRequestSchema, response: signedLinkResponseSchema },
  listLinks: { method: 'get', path: '/api/links', permission: { kind: 'staff', capability: 'links.send' },
    query: signedLinkListQuerySchema, response: signedLinkListResponseSchema },
  getLink: { method: 'get', path: '/api/links/{linkId}', permission: { kind: 'staff', capability: 'links.send' },
    params: signedLinkParamsSchema, response: signedLinkResponseSchema },
  revokeLink: { method: 'post', path: '/api/links/{linkId}/revoke', permission: { kind: 'staff', capability: 'links.send' },
    params: signedLinkParamsSchema, response: signedLinkResponseSchema },
  createCampaign: { method: 'post', path: '/api/link-campaigns', permission: { kind: 'staff', capability: 'links.send' },
    body: createLinkCampaignRequestSchema, response: linkCampaignResponseSchema },
  listCampaigns: { method: 'get', path: '/api/link-campaigns', permission: { kind: 'staff', capability: 'links.send' },
    query: linkCampaignListQuerySchema, response: linkCampaignListResponseSchema },
  getCampaign: { method: 'get', path: '/api/link-campaigns/{campaignId}', permission: { kind: 'staff', capability: 'links.send' },
    params: linkCampaignParamsSchema, response: linkCampaignResponseSchema },
  listCampaignRecipients: { method: 'get', path: '/api/link-campaigns/{campaignId}/recipients', permission: { kind: 'staff', capability: 'links.send' },
    params: linkCampaignParamsSchema, query: campaignRecipientListQuerySchema, response: campaignRecipientListResponseSchema },
  remindCampaign: { method: 'post', path: '/api/link-campaigns/{campaignId}/remind', permission: { kind: 'staff', capability: 'links.send' },
    params: linkCampaignParamsSchema, response: remindLinkCampaignResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type SignedLinkPurposeName = z.infer<typeof signedLinkPurposeSchema>;
export type SignedLinkRecord = z.infer<typeof signedLinkSchema>;
export type CreateSignedLinkRequest = z.infer<typeof createSignedLinkRequestSchema>;
export type CreateSignedLinkResponse = z.infer<typeof createSignedLinkResponseSchema>;
export type SignedLinkResponse = z.infer<typeof signedLinkResponseSchema>;
export type SignedLinkListResponse = z.infer<typeof signedLinkListResponseSchema>;
export type SignedLinkListQuery = z.infer<typeof signedLinkListQuerySchema>;
export type CampaignReminderSchedule = z.infer<typeof campaignReminderScheduleSchema>;
export type LinkCampaign = z.infer<typeof linkCampaignSchema>;
export type CreateLinkCampaignRequest = z.infer<typeof createLinkCampaignRequestSchema>;
export type LinkCampaignProgress = z.infer<typeof linkCampaignProgressSchema>;
export type LinkCampaignDetail = z.infer<typeof linkCampaignDetailSchema>;
export type CampaignRecipientState = z.infer<typeof campaignRecipientStateSchema>;
export type CampaignRecipient = z.infer<typeof campaignRecipientSchema>;
export type LinkCampaignResponse = z.infer<typeof linkCampaignResponseSchema>;
export type LinkCampaignListResponse = z.infer<typeof linkCampaignListResponseSchema>;
export type CampaignRecipientListResponse = z.infer<typeof campaignRecipientListResponseSchema>;
