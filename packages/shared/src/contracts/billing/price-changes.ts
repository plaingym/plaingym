// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { membershipStatusSchema } from '../states.js';
import { amountCentsSchema, currencySchema, dateSchema, idSchema, revisionSchema } from '../common.js';
import { billingIntervalSchema } from './catalog.js';

/** The most memberships one price change previews or applies. */
export const planPriceChangeLimit = 2_000;
const countSchema = z.int32().nonnegative();
const priceSchema = amountCentsSchema.nonnegative();
// A JSON integer or a canonical decimal query parameter; null, fractions and exponent notation are refused.
const queryAmountSchema = z.union([z.number(), z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number)]).pipe(priceSchema);

/**
 * Why a listed membership isn't moved: a plan switch to another plan is scheduled (`switch_scheduled`); a price change is
 * already scheduled on it (`price_scheduled`: a downgrade now's, or an earlier plan price change); its currency or
 * interval differs from the plan's (`terms`); or, on apply, it changed, was cancelled or left the plan after the
 * preview (`changed`).
 */
export const planPriceChangeSkipReasonSchema = z.enum(['switch_scheduled', 'price_scheduled', 'terms', 'changed']);
/** Whether the notice can reach its payer; suppressed means opted out of email or undeliverable. */
export const planPriceChangeReachSchema = z.enum(['ok', 'no_address', 'payer_erased', 'suppressed']);

/** The new price (in the plan's currency, on its charge step) and the date, on or after the gym-local today. */
export const planPriceChangePreviewQuerySchema = z.strictObject({
  amountCents: queryAmountSchema,
  effectiveOn: dateSchema,
});
export const planPriceChangeMembershipSchema = z.strictObject({
  id: idSchema,
  revision: revisionSchema,
  householdId: idSchema,
  memberName: z.string(),
  status: membershipStatusSchema,
  amountCents: priceSchema,
  currency: currencySchema,
  interval: billingIntervalSchema,
  commitmentEndsOn: dateSchema.nullable(),
  // The commitment ends after the chosen date.
  inCommitment: z.boolean(),
  // The amount or interval differs from the plan's current price.
  customPrice: z.boolean(),
  // A change already scheduled on the membership, if any.
  scheduled: z.strictObject({ planId: idSchema, amountCents: priceSchema, interval: billingIntervalSchema, on: dateSchema }).nullable(),
  // "Choose members" ticks it: not skipped, not in a commitment after the date, not on a custom price, not frozen.
  tickedByDefault: z.boolean(),
  // "All existing members" moves it: not skipped, not in a commitment after the date, not on a custom price.
  includedByAll: z.boolean(),
  skipReason: planPriceChangeSkipReasonSchema.nullable(),
  householdReach: planPriceChangeReachSchema,
});
export const planPriceChangePreviewSchema = z.strictObject({
  plan: z.strictObject({ id: idSchema, name: z.string(), amountCents: priceSchema, currency: currencySchema,
    interval: billingIntervalSchema, active: z.boolean(), revision: revisionSchema }),
  amountCents: priceSchema,
  effectiveOn: dateSchema,
  // The gym-local today.
  today: dateSchema,
  // The new price against the plan's current one.
  change: z.enum(['increase', 'decrease', 'none']),
  // Memberships on the plan that aren't cancelled, by member name; at most `planPriceChangeLimit` of `total`.
  memberships: z.array(planPriceChangeMembershipSchema).max(planPriceChangeLimit),
  total: countSchema,
  // Households of the memberships that can move (not skipped), and those whose notice can't reach the payer.
  households: countSchema,
  householdsWithoutAddress: countSchema,
  householdsPayerErased: countSchema,
  householdsSuppressed: countSchema,
  // Memberships on other plans with a switch to this plan scheduled: they keep the price quoted when it was scheduled.
  switchesToPlan: countSchema,
  // Member email is turned on and the gym can send it now.
  canEmail: z.boolean(),
});
export const planPriceChangePreviewResponseSchema = z.strictObject({ data: planPriceChangePreviewSchema });

/**
 * Applies the new price to the plan and schedules it, as a price-only change, on the listed memberships from their first
 * cycle on or after `effectiveOn`, with no proration. The client generates `requestKey` once per submit: a retry with
 * it resumes or replays the request, even after the plan's revision moved on, and the same key with another price,
 * date, notice flag or list is a conflict (`request_reused`).
 */
export const applyPlanPriceChangeRequestSchema = z.strictObject({
  requestKey: idSchema,
  planRevision: revisionSchema,
  amountCents: priceSchema,
  effectiveOn: dateSchema,
  // Queue one notice email per household with a membership scheduled.
  notify: z.boolean(),
  memberships: z.array(z.strictObject({ id: idSchema, revision: revisionSchema })).min(1).max(planPriceChangeLimit)
    .refine(list => new Set(list.map(item => item.id)).size === list.length, 'Memberships must be distinct.'),
});
export const planPriceChangeResultSchema = z.strictObject({
  planId: idSchema,
  amountCents: priceSchema,
  effectiveOn: dateSchema,
  scheduled: z.array(idSchema),
  skipped: z.array(z.strictObject({ id: idSchema, reason: planPriceChangeSkipReasonSchema })),
  // Reachable households given a notice job (with `notify`), and households with a membership scheduled whose notice can't reach
  // the payer (the job sends them nothing).
  householdsNotified: countSchema,
  householdsWithoutAddress: countSchema,
  householdsPayerErased: countSchema,
  householdsSuppressed: countSchema,
});
export const planPriceChangeResponseSchema = z.strictObject({ data: planPriceChangeResultSchema });

export type PlanPriceChangeSkipReason = z.infer<typeof planPriceChangeSkipReasonSchema>;
export type PlanPriceChangeReach = z.infer<typeof planPriceChangeReachSchema>;
export type PlanPriceChangePreviewQuery = z.input<typeof planPriceChangePreviewQuerySchema>;
export type PlanPriceChangeMembership = z.infer<typeof planPriceChangeMembershipSchema>;
export type PlanPriceChangePreview = z.infer<typeof planPriceChangePreviewSchema>;
export type ApplyPlanPriceChangeRequest = z.input<typeof applyPlanPriceChangeRequestSchema>;
export type PlanPriceChangeResult = z.infer<typeof planPriceChangeResultSchema>;
