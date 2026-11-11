// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { isCalendarDate } from '../time.js';
import { dateSchema } from './common.js';
import type { EndpointContract } from './definition.js';

export const leadSourceSchema = z.enum(['trial_form', 'join', 'drop_in', 'walk_in', 'referral', 'phone', 'other']);
export const leadStageSchema = z.enum(['new', 'contacted', 'trial_booked', 'trial_attended', 'won', 'lost']);
/** Inclusive gym-local dates, covering at most 24 calendar months. */
const funnelDateSchema = dateSchema.regex(/^(?!0000)/, 'Year must be positive');
export const leadFunnelQuerySchema = z.strictObject({ from: funnelDateSchema, to: funnelDateSchema })
  .refine(value => value.from <= value.to, 'Range ends before it starts')
  .refine(value => {
    if (!isCalendarDate(value.from) || !isCalendarDate(value.to)) return true; // The date schemas report these errors.
    if (Number(value.from.slice(0, 4)) > 9997) return true;
    // Clamp the anniversary of February 29 in a non-leap year.
    const anniversary = String(Number(value.from.slice(0, 4)) + 2).padStart(4, '0') + value.from.slice(4);
    const end = isCalendarDate(anniversary) ? anniversary : anniversary.slice(0, 8) + '28';
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
export const leadsContracts = {
  funnel: { method: 'get', path: '/api/leads/funnel', permission: { kind: 'staff', capability: 'leads.manage' },
    query: leadFunnelQuerySchema, response: leadFunnelResponseSchema },
} as const satisfies Record<string, EndpointContract>;

export type LeadSource = z.infer<typeof leadSourceSchema>;
export type LeadStage = z.infer<typeof leadStageSchema>;
export type LeadFunnelQuery = z.infer<typeof leadFunnelQuerySchema>;
export type LeadFunnelResponse = z.infer<typeof leadFunnelResponseSchema>;
