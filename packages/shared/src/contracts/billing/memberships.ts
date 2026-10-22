// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { membershipStatusSchema } from '../states.js';
import {
  amountCentsSchema, dateSchema, idSchema, instantSchema, listResponseSchema,
  moneySchema, paginationSchema, revisionSchema,
} from '../common.js';
import { billingIntervalSchema } from './catalog.js';

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
// price, interval and commitment. PATCH maps to MembershipLifecycle.update;
// explicit overrides win over changed-plan defaults. Resume maps to activate
// with nextDueOn, while freeze accepts null resumesOn for an indefinite freeze.
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
  planId: idSchema.optional(),
  nextDueOn: dateSchema.optional(),
  interval: billingIntervalSchema.optional(),
  // A price override always includes its currency; the service checks the gym.
  price: moneySchema.extend({ amountCents: amountCentsSchema.nonnegative() }).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'revision'), 'Supply a change.');
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
