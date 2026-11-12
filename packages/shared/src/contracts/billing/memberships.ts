// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { membershipStatusSchema } from '../states.js';
import {
  amountCentsSchema, currencySchema, dateSchema, idSchema, instantSchema, listResponseSchema,
  moneySchema, paginationSchema, revisionSchema,
} from '../common.js';
import { billingIntervalSchema, refinePriceStep } from './catalog.js';

export { membershipStatusSchema } from '../states.js';
export const membershipSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  householdId: idSchema,
  memberId: idSchema,
  planId: idSchema,
  status: membershipStatusSchema,
  interval: billingIntervalSchema,
  ...moneySchema.shape,
  amountCents: amountCentsSchema.nonnegative(),
  nextDueOn: dateSchema,
  startsOn: dateSchema,
  trialEndsOn: dateSchema.nullable(),
  frozenAt: instantSchema.nullable(),
  resumesOn: dateSchema.nullable(),
  cancelledAt: instantSchema.nullable(),
  // Assigned from the original plan; changing plans preserves this date.
  commitmentEndsOn: dateSchema.nullable(),
  // A scheduled plan switch (read-only): all four set or all null. The plan's price and interval are quoted when it is
  // scheduled, and it applies at the first cycle billed on or after `scheduledOn`.
  scheduledPlanId: idSchema.nullable(),
  scheduledAmountCents: amountCentsSchema.nonnegative().nullable(),
  scheduledInterval: billingIntervalSchema.nullable(),
  scheduledOn: dateSchema.nullable(),
  revision: revisionSchema,
});
export const membershipResponseSchema = z.strictObject({ data: membershipSchema });
export const membershipListResponseSchema = listResponseSchema(membershipSchema);
export const membershipListQuerySchema = paginationSchema.extend({
  householdId: idSchema.optional(),
  memberId: idSchema.optional(),
  status: membershipStatusSchema.optional(),
  dueOnOrBefore: dateSchema.optional(),
});
// The service checks member/household/plan ownership and snapshots the plan's
// price, interval and commitment. PATCH maps to MembershipLifecycle.update and
// changes only the price or the next due date: a plan or interval changes only
// through the plan switch. Resume maps to activate with nextDueOn, while freeze
// accepts null resumesOn for an indefinite freeze.
export const assignMembershipRequestSchema = z.strictObject({
  householdId: idSchema,
  memberId: idSchema,
  planId: idSchema,
  startsOn: dateSchema,
  nextDueOn: dateSchema,
  firstPeriod: z.enum(['prorate_now', 'next_billing_date']).default('prorate_now'),
});
export const updateMembershipRequestSchema = z.strictObject({
  revision: revisionSchema,
  nextDueOn: dateSchema.optional(),
  // A price override always includes its currency; the service checks the gym.
  price: moneySchema.extend({ amountCents: amountCentsSchema.nonnegative() }).superRefine(refinePriceStep(['amountCents'])).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'revision'), 'Supply a change.');
/** `next_billing_date` schedules the switch for the next due date; `now` switches at once (active memberships only). */
export const planSwitchTimingSchema = z.enum(['next_billing_date', 'now']);
/** Compared per year (a monthly price × 12) against the membership's current price. */
export const planSwitchKindSchema = z.enum(['upgrade', 'downgrade', 'equal']);
// The client generates `requestId` once per submit: a retry with it replays the recorded result, even after the
// revision moved on, and the same ID with another plan, timing or override flag is a conflict.
export const switchMembershipPlanRequestSchema = z.strictObject({
  revision: revisionSchema,
  requestId: idSchema,
  planId: idSchema,
  timing: planSwitchTimingSchema.default('next_billing_date'),
  // Needed only for a downgrade before the commitment ends; stored on the membership, never returned or audited.
  override: z.strictObject({ reason: z.string().trim().min(1).max(500) }).optional(),
});
export const membershipSwitchResponseSchema = z.strictObject({
  // The upgrade's proration invoice when one was issued (an upgrade now with days left), otherwise null.
  data: z.strictObject({ membership: membershipSchema, invoiceId: idSchema.nullable() }),
});
export const cancelMembershipSwitchRequestSchema = z.strictObject({ revision: revisionSchema });
export const membershipSwitchPreviewQuerySchema = z.strictObject({
  planId: idSchema,
  timing: planSwitchTimingSchema.default('next_billing_date'),
});
export const membershipSwitchPreviewSchema = z.strictObject({
  planId: idSchema,
  timing: planSwitchTimingSchema,
  kind: planSwitchKindSchema,
  currency: currencySchema,
  // The day the membership starts paying the new plan's price: today for an upgrade now, otherwise the next due date.
  priceStartsOn: dateSchema,
  // A downgrade before the commitment ends; the switch then needs an override reason.
  commitmentBlocks: z.boolean(),
  // For an upgrade now with days left in the current period: the days charged, the period's length and the
  // invoice total (0 when the rounded proration or the discounted total is zero, so no invoice is issued).
  proration: z.strictObject({
    periodStartsOn: dateSchema,
    periodEndsOn: dateSchema,
    billedDays: z.int().nonnegative(),
    periodDays: z.int().positive(),
    totalCents: amountCentsSchema.nonnegative(),
  }).nullable(),
});
export const membershipSwitchPreviewResponseSchema = z.strictObject({ data: membershipSwitchPreviewSchema });
export const activateMembershipRequestSchema = z.strictObject({ revision: revisionSchema });
export const freezeMembershipRequestSchema = z.strictObject({
  revision: revisionSchema,
  resumesOn: dateSchema.nullable(),
});
export const resumeMembershipRequestSchema = z.strictObject({
  revision: revisionSchema,
  nextDueOn: dateSchema,
});
export const cancelMembershipRequestSchema = z.strictObject({ revision: revisionSchema });

export type MembershipStatus = z.infer<typeof membershipStatusSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type MembershipListQuery = z.infer<typeof membershipListQuerySchema>;
export type AssignMembershipRequest = z.input<typeof assignMembershipRequestSchema>;
export type UpdateMembershipRequest = z.input<typeof updateMembershipRequestSchema>;
export type ActivateMembershipRequest = z.infer<typeof activateMembershipRequestSchema>;
export type FreezeMembershipRequest = z.infer<typeof freezeMembershipRequestSchema>;
export type ResumeMembershipRequest = z.infer<typeof resumeMembershipRequestSchema>;
export type CancelMembershipRequest = z.infer<typeof cancelMembershipRequestSchema>;
export type PlanSwitchTiming = z.infer<typeof planSwitchTimingSchema>;
export type PlanSwitchKind = z.infer<typeof planSwitchKindSchema>;
export type SwitchMembershipPlanRequest = z.input<typeof switchMembershipPlanRequestSchema>;
export type MembershipSwitchResult = z.infer<typeof membershipSwitchResponseSchema>['data'];
export type CancelMembershipSwitchRequest = z.infer<typeof cancelMembershipSwitchRequestSchema>;
export type MembershipSwitchPreviewQuery = z.input<typeof membershipSwitchPreviewQuerySchema>;
export type MembershipSwitchPreview = z.infer<typeof membershipSwitchPreviewSchema>;
