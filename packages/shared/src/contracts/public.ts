// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import {
  amountCentsSchema, currencySchema, dateSchema, idSchema,
  listResponseSchema, paginationSchema, revisionSchema,
} from './common.js';
import { waiverSignerSchema, waiverDigestSchema, waiverTemplateSchema, waiverTemplateVersionSchema } from './waivers.js';

export const publicBrandingSchema = z.strictObject({
  name: z.string().min(1), revision: revisionSchema, logoKey: z.string().nullable(),
  primaryColor: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable(),
});
export const publicPlanSchema = z.strictObject({
  id: idSchema, name: z.string().min(1), amountCents: amountCentsSchema.nonnegative(),
  currency: currencySchema, interval: z.enum(['monthly', 'annual']),
  signupFeeCents: amountCentsSchema.nonnegative(), trialDays: z.int32().nonnegative(),
  commitmentMonths: z.int32().positive().nullable(), revision: revisionSchema,
});
export const publicPlanListResponseSchema = listResponseSchema(publicPlanSchema);
export const publicWaiverTemplatesResponseSchema = listResponseSchema(waiverTemplateSchema);
export const publicPageConfigResponseSchema = z.strictObject({ data: z.strictObject({
  gym: publicBrandingSchema,
  // No processor IDs or payment controls: the mat fee is paid at the front desk.
  dropInFee: z.strictObject({ amountCents: amountCentsSchema.nonnegative(), currency: currencySchema }).nullable(),
}) });
export const publicApplicantSchema = z.strictObject({
  firstName: z.string().trim().min(1), lastName: z.string().trim().min(1), dateOfBirth: dateSchema,
});
export const publicContactSchema = z.strictObject({
  name: z.string().trim().min(1), email: z.email().toLowerCase(),
  phone: z.string().trim().min(1).optional(), address: z.record(z.string(), z.string()).optional(),
});
// Rate limiting runs before validation. A filled honeypot is invalid; no client
// timestamp, status, household ID, or existing-member flag is accepted.
export const publicTrialRequestSchema = z.strictObject({
  contact: publicContactSchema, member: publicApplicantSchema, honeypot: z.literal(''),
});
export const publicWaiverAcceptanceSchema = z.strictObject({
  templateId: idSchema, templateVersion: waiverTemplateVersionSchema, signer: waiverSignerSchema,
  signatureImageKey: z.string().min(1), signatureImageHash: waiverDigestSchema, consent: z.literal(true),
});
export const publicDropInRequestSchema = publicTrialRequestSchema.extend({
  waivers: z.array(publicWaiverAcceptanceSchema).min(1),
});
export const publicJoinRequestSchema = z.strictObject({
  planId: idSchema, contact: publicContactSchema,
  members: z.array(z.strictObject({
    member: publicApplicantSchema, waivers: z.array(publicWaiverAcceptanceSchema).min(1),
  })).min(1),
  honeypot: z.literal(''),
});
// Identical status and shape for new, existing, and already-enrolled addresses.
// No existence-dependent redirect, account IDs, login state, or Checkout URL is
// returned by an anonymous submission. Join always creates a new household; the
// submitting browser continues to Checkout through an HttpOnly cookie holding only
// a signed reference to that pending join, and the portal login is created after
// payment only for an account that proves the submitted address.
export const publicSubmissionResponseSchema = z.strictObject({ data: z.strictObject({ status: z.literal('received') }) });


// These core pages work even when the website module is disabled.
export const publicContracts = {
  config: { method: 'get', path: '/api/public/config', permission: { kind: 'public' }, response: publicPageConfigResponseSchema },
  plans: { method: 'get', path: '/api/public/plans', permission: { kind: 'public' }, query: paginationSchema, response: publicPlanListResponseSchema },
  waivers: { method: 'get', path: '/api/public/waivers', permission: { kind: 'public' }, query: paginationSchema, response: publicWaiverTemplatesResponseSchema },
  trial: { method: 'post', path: '/api/public/trial', permission: { kind: 'public' }, body: publicTrialRequestSchema, response: publicSubmissionResponseSchema },
  dropIn: { method: 'post', path: '/api/public/drop-in', permission: { kind: 'public' }, body: publicDropInRequestSchema, response: publicSubmissionResponseSchema },
  join: { method: 'post', path: '/api/public/join', permission: { kind: 'public' }, body: publicJoinRequestSchema, response: publicSubmissionResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type PublicBranding = z.infer<typeof publicBrandingSchema>;
export type PublicPlan = z.infer<typeof publicPlanSchema>;
export type PublicApplicant = z.infer<typeof publicApplicantSchema>;
export type PublicContact = z.infer<typeof publicContactSchema>;
export type PublicTrialRequest = z.infer<typeof publicTrialRequestSchema>;
export type PublicDropInRequest = z.infer<typeof publicDropInRequestSchema>;
export type PublicJoinRequest = z.infer<typeof publicJoinRequestSchema>;
export type PublicSubmissionResponse = z.infer<typeof publicSubmissionResponseSchema>;
