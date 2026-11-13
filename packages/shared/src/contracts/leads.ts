// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { isCalendarDate } from '../time.js';
import { dateSchema, idSchema, instantSchema, paginationSchema, paginationMetaSchema } from './common.js';
import { memberStatusSchema } from './states.js';
import type { EndpointContract } from './definition.js';

export const leadSources = ['trial_form', 'join', 'drop_in', 'walk_in', 'referral', 'phone', 'other'] as const;
export const leadStages = ['new', 'contacted', 'trial_booked', 'trial_attended', 'won', 'lost'] as const;
export const leadSourceSchema = z.enum(leadSources);
export const leadStageSchema = z.enum(leadStages);
const leadRevisionSchema = z.int32().nonnegative();
const positiveYearDateSchema = dateSchema.regex(/^(?!0000)/, 'Year must be positive');
const queryBoolean = z.union([z.boolean(), z.enum(['true', 'false']).transform(value => value === 'true')]);
export const leadListQuerySchema = paginationSchema.extend({
  stage: z.union([leadStageSchema, z.array(leadStageSchema).min(1).max(6)]).optional(),
  includeLost: queryBoolean.default(false), source: z.union([leadSourceSchema, z.literal('unknown')]).optional(),
  due: queryBoolean.default(false), search: z.string().trim().min(1).max(200).optional(),
});
export const leadSchema = z.strictObject({
  memberId: idSchema, householdId: idSchema, firstName: z.string(), lastName: z.string(),
  email: z.string().nullable(), phone: z.string().nullable(), status: memberStatusSchema,
  source: leadSourceSchema.nullable(), stage: leadStageSchema, nextFollowUpOn: positiveYearDateSchema.nullable(),
  lastContactedAt: instantSchema.nullable(), createdAt: instantSchema, revision: leadRevisionSchema,
});
export const leadDetailSchema = leadSchema.extend({ lostReason: z.string().nullable() });
export const leadResponseSchema = z.strictObject({ data: leadDetailSchema });
const countSchema = z.int().nonnegative();
export const leadListResponseSchema = z.strictObject({ data: z.array(leadSchema), pagination: paginationMetaSchema,
  counts: z.strictObject({ new: countSchema, contacted: countSchema, trial_booked: countSchema,
    trial_attended: countSchema, won: countSchema, lost: countSchema }),
});
export const updateLeadRequestSchema = z.strictObject({ revision: leadRevisionSchema,
  source: leadSourceSchema.nullable().optional(), stage: leadStageSchema.optional(),
  nextFollowUpOn: positiveYearDateSchema.nullable().optional(),
}).refine(value => value.source !== undefined || value.stage !== undefined || value.nextFollowUpOn !== undefined, 'No changes supplied');
export const loseLeadRequestSchema = z.strictObject({ revision: leadRevisionSchema,
  reason: z.string().trim().min(1).refine(value => [...value].length <= 500, 'Reason is too long') });
export const reopenLeadRequestSchema = z.strictObject({ revision: leadRevisionSchema });
const leadParamsSchema = z.strictObject({ memberId: idSchema });
const manage = { kind: 'staff', capability: 'leads.manage' } as const;
/** Inclusive gym-local dates, covering at most 24 calendar months. */
export const leadFunnelQuerySchema = z.strictObject({ from: positiveYearDateSchema, to: positiveYearDateSchema })
  .refine(value => value.from <= value.to, 'Range ends before it starts')
  .refine(value => {
    if (!isCalendarDate(value.from) || !isCalendarDate(value.to)) return true; // The date schemas report these errors.
    if (Number(value.from.slice(0, 4)) > 9997) return true;
    // A leap-day cohort includes February 28 two years later.
    const anniversary = String(Number(value.from.slice(0, 4)) + 2).padStart(4, '0') + value.from.slice(4);
    const end = isCalendarDate(anniversary) ? anniversary : anniversary.slice(0, 5) + '03-01';
    return value.to < end;
  }, 'Range exceeds 24 months');
export const leadFunnelSourceSchema = z.strictObject({
  source: z.union([leadSourceSchema, z.literal('unknown')]),
  leads: z.int().nonnegative(), trialAttended: z.int().nonnegative(),
  won: z.int().nonnegative(), lost: z.int().nonnegative(), open: z.int().nonnegative(),
});
export const leadFunnelResponseSchema = z.strictObject({ data: z.strictObject({
  from: dateSchema, to: dateSchema, timezone: z.string(), sources: z.array(leadFunnelSourceSchema),
}) });
export const leadContactChannelSchema = z.enum(['call', 'text', 'email', 'in_person', 'other']);
/** Counted in code points, as the database counts it; a blank note is stored as none. */
const contactNoteSchema = z.string().trim().refine(value => [...value].length <= 2000, 'Note is too long');
export const leadContactSchema = z.strictObject({
  id: idSchema, occurredAt: instantSchema, channel: leadContactChannelSchema, note: z.string().nullable(),
  createdBy: idSchema, createdByName: z.string().nullable(),
});
export const leadContactListQuerySchema = paginationSchema;
export const leadContactListResponseSchema = z.strictObject({ data: z.array(leadContactSchema), pagination: paginationMetaSchema });
export const createLeadContactRequestSchema = z.strictObject({ revision: leadRevisionSchema, channel: leadContactChannelSchema,
  note: contactNoteSchema.nullable().optional(), nextFollowUpOn: positiveYearDateSchema.nullable().optional() });
export const leadContactResponseSchema = z.strictObject({ data: z.strictObject({ lead: leadDetailSchema, contact: leadContactSchema }) });
export const leadsContracts = {
  funnel: { method: 'get', path: '/api/leads/funnel', permission: { kind: 'staff', capability: 'leads.manage' },
    query: leadFunnelQuerySchema, response: leadFunnelResponseSchema },
  list: { method: 'get', path: '/api/leads', permission: manage, query: leadListQuerySchema, response: leadListResponseSchema },
  read: { method: 'get', path: '/api/leads/{memberId}', permission: manage, params: leadParamsSchema, response: leadResponseSchema },
  edit: { method: 'patch', path: '/api/leads/{memberId}', permission: manage, params: leadParamsSchema,
    body: updateLeadRequestSchema, response: leadResponseSchema },
  lost: { method: 'post', path: '/api/leads/{memberId}/lost', permission: manage, params: leadParamsSchema,
    body: loseLeadRequestSchema, response: leadResponseSchema },
  reopen: { method: 'post', path: '/api/leads/{memberId}/reopen', permission: manage, params: leadParamsSchema,
    body: reopenLeadRequestSchema, response: leadResponseSchema },
  contacts: { method: 'get', path: '/api/leads/{memberId}/contacts', permission: manage, params: leadParamsSchema,
    query: leadContactListQuerySchema, response: leadContactListResponseSchema },
  logContact: { method: 'post', path: '/api/leads/{memberId}/contacts', permission: manage, params: leadParamsSchema,
    body: createLeadContactRequestSchema, response: leadContactResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type LeadSource = z.infer<typeof leadSourceSchema>;
export type LeadStage = z.infer<typeof leadStageSchema>;
export type LeadFunnelQuery = z.infer<typeof leadFunnelQuerySchema>;
export type LeadFunnelResponse = z.infer<typeof leadFunnelResponseSchema>;
export type LeadListQuery = z.input<typeof leadListQuerySchema>;
export type UpdateLeadRequest = z.infer<typeof updateLeadRequestSchema>;
export type LoseLeadRequest = z.infer<typeof loseLeadRequestSchema>;
export type ReopenLeadRequest = z.infer<typeof reopenLeadRequestSchema>;
export type LeadContactChannel = z.infer<typeof leadContactChannelSchema>;
export type LeadContact = z.infer<typeof leadContactSchema>;
export type LeadContactListQuery = z.input<typeof leadContactListQuerySchema>;
export type CreateLeadContactRequest = z.infer<typeof createLeadContactRequestSchema>;
