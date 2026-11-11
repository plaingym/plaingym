// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { minorUnitStep, onMinorUnitStep } from '../../money.js';
import { billingIntervalSchema } from '../states.js';
import {
  amountCentsSchema, currencySchema, idSchema, instantSchema, listResponseSchema,
  moneySchema, paginationSchema, revisionSchema, taxRateMillionthsSchema,
} from '../common.js';

export { billingIntervalSchema } from '../states.js';
const nameSchema = z.string().trim().min(1);
const taxRateIdsSchema = z.array(idSchema).refine(
  (ids) => new Set(ids).size === ids.length, 'Tax rates must be distinct.',
);
// Currency is compared with the gym settings accessor by the service. It is
// never inferred from the browser, a processor object, or a related plan.
const priceFields = {
  ...moneySchema.shape,
  amountCents: amountCentsSchema.nonnegative(),
};
/**
 * Refuses a price finer than its currency's charge step (`minorUnitStep`: 100 for ISK and UGX, 10 for the
 * three-decimal currencies), which Stripe would refuse to charge. An update that changes an amount without its
 * currency is checked by the service against the stored one.
 */
export function refinePriceStep(fields: readonly ('amountCents' | 'signupFeeCents')[]) {
  return (value: object, context: z.RefinementCtx) => {
    const prices = value as Partial<Record<'currency' | 'amountCents' | 'signupFeeCents', unknown>>;
    const currency = currencySchema.safeParse(prices.currency);
    if (!currency.success) return;
    for (const field of fields) {
      const amount = prices[field];
      if (typeof amount === 'number' && !onMinorUnitStep(amount, currency.data)) context.addIssue({ code: 'custom', path: [field],
        message: `Amounts in ${currency.data} must be a multiple of ${minorUnitStep(currency.data)} minor units.` });
    }
  };
}
const planPrices = refinePriceStep(['amountCents', 'signupFeeCents']), chargePrices = refinePriceStep(['amountCents']);

const taxRateFieldsSchema = z.strictObject({
  name: nameSchema,
  rateMillionths: taxRateMillionthsSchema,
  inclusive: z.boolean(),
  active: z.boolean(),
});
export const createTaxRateRequestSchema = taxRateFieldsSchema.extend({ active: z.boolean().default(true) });
// Archiving (`active: false`) an active rate still attached to a charge type or plan is
// refused (conflict) unless `detach: true` confirms removing it from every one
// of them in the same step.
export const updateTaxRateRequestSchema = taxRateFieldsSchema.partial().extend({
  revision: revisionSchema,
  detach: z.literal(true).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'revision' && key !== 'detach'), 'Supply a change.')
  .refine((value) => value.detach === undefined || value.active === false,
    { message: 'Detach only when archiving.', path: ['detach'] });
export const taxRateSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  name: nameSchema,
  rateMillionths: taxRateMillionthsSchema,
  inclusive: z.boolean(),
  active: z.boolean(),
  revision: revisionSchema,
});
export const taxRateResponseSchema = z.strictObject({ data: taxRateSchema });
export const taxRateListResponseSchema = listResponseSchema(taxRateSchema);
const countSchema = z.int32().nonnegative();
const usageItemSchema = z.strictObject({ id: idSchema, name: nameSchema, active: z.boolean() });
// Every charge type, class pack and plan the rate is attached to. A plan's memberships
// count when they are not cancelled: their next cycle invoices apply the
// plan's rates as they are then.
export const taxRateUsageSchema = z.strictObject({
  chargeTypes: z.array(usageItemSchema),
  packs: z.array(usageItemSchema),
  plans: z.array(usageItemSchema.extend({ memberships: countSchema })),
  memberships: countSchema,
});
export const taxRateUsageResponseSchema = z.strictObject({ data: taxRateUsageSchema });

const planFieldsSchema = z.strictObject({
  name: nameSchema,
  ...priceFields,
  interval: billingIntervalSchema,
  signupFeeCents: amountCentsSchema.nonnegative(),
  trialDays: z.int32().nonnegative(),
  commitmentMonths: z.int32().positive().nullable(),
  active: z.boolean(),
  taxRateIds: taxRateIdsSchema,
});
export const createPlanRequestSchema = planFieldsSchema.extend({
  signupFeeCents: planFieldsSchema.shape.signupFeeCents.default(0),
  trialDays: planFieldsSchema.shape.trialDays.default(0),
  commitmentMonths: planFieldsSchema.shape.commitmentMonths.default(null),
  active: planFieldsSchema.shape.active.default(true),
  taxRateIds: taxRateIdsSchema.default([]),
}).superRefine(planPrices);
export const updatePlanRequestSchema = planFieldsSchema.partial().extend({
  revision: revisionSchema,
}).refine((value) => Object.keys(value).some((key) => key !== 'revision'), 'Supply a change.').superRefine(planPrices);
export const planSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  name: nameSchema,
  ...priceFields,
  interval: billingIntervalSchema,
  signupFeeCents: amountCentsSchema.nonnegative(),
  trialDays: z.int32().nonnegative(),
  commitmentMonths: z.int32().positive().nullable(),
  active: z.boolean(),
  revision: revisionSchema,
  taxRateIds: taxRateIdsSchema,
});
export const planResponseSchema = z.strictObject({ data: planSchema });
export const planListResponseSchema = listResponseSchema(planSchema);

const chargeTypeFieldsSchema = z.strictObject({
  name: nameSchema,
  ...priceFields,
  active: z.boolean(),
  taxRateIds: taxRateIdsSchema,
});
export const createChargeTypeRequestSchema = chargeTypeFieldsSchema.extend({
  active: z.boolean().default(true), taxRateIds: taxRateIdsSchema.default([]),
}).superRefine(chargePrices);
export const updateChargeTypeRequestSchema = chargeTypeFieldsSchema.partial().extend({
  revision: revisionSchema,
}).refine((value) => Object.keys(value).some((key) => key !== 'revision'), 'Supply a change.').superRefine(chargePrices);
export const chargeTypeSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  name: nameSchema,
  ...priceFields,
  active: z.boolean(),
  revision: revisionSchema,
  taxRateIds: taxRateIdsSchema,
});
export const chargeTypeResponseSchema = z.strictObject({ data: chargeTypeSchema });
export const chargeTypeListResponseSchema = listResponseSchema(chargeTypeSchema);

// Query strings use explicit booleans; an empty string must not become false.
export const billingCatalogListQuerySchema = paginationSchema.extend({
  active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  currency: currencySchema.optional(),
});
export const billingTaxRateListQuerySchema = paginationSchema.extend({
  active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});

export type BillingInterval = z.infer<typeof billingIntervalSchema>;
export type TaxRate = z.infer<typeof taxRateSchema>;
export type CreateTaxRateRequest = z.input<typeof createTaxRateRequestSchema>;
export type UpdateTaxRateRequest = z.input<typeof updateTaxRateRequestSchema>;
export type TaxRateUsage = z.infer<typeof taxRateUsageSchema>;
export type Plan = z.infer<typeof planSchema>;
export type CreatePlanRequest = z.input<typeof createPlanRequestSchema>;
export type UpdatePlanRequest = z.input<typeof updatePlanRequestSchema>;
export type ChargeType = z.infer<typeof chargeTypeSchema>;
export type CreateChargeTypeRequest = z.input<typeof createChargeTypeRequestSchema>;
export type UpdateChargeTypeRequest = z.input<typeof updateChargeTypeRequestSchema>;
export type BillingCatalogListQuery = z.infer<typeof billingCatalogListQuerySchema>;

const classPackFieldsSchema = z.strictObject({
  name: nameSchema, ...priceFields, credits: z.int32().min(1).max(100),
  expiryDays: z.int32().min(1).max(3650).nullable(), active: z.boolean(), taxRateIds: taxRateIdsSchema,
});
export const createClassPackRequestSchema = classPackFieldsSchema.extend({
  expiryDays: classPackFieldsSchema.shape.expiryDays.default(null),
  active: z.boolean().default(true), taxRateIds: taxRateIdsSchema.default([]),
}).superRefine(chargePrices);
export const updateClassPackRequestSchema = classPackFieldsSchema.partial().extend({ revision: revisionSchema })
  .refine(value => Object.keys(value).some(key => key !== 'revision'), 'Supply a change.').superRefine(chargePrices);
export const classPackSchema = classPackFieldsSchema.extend({ id: idSchema, createdAt: instantSchema, revision: revisionSchema });
export const classPackResponseSchema = z.strictObject({ data: classPackSchema });
export const classPackListResponseSchema = listResponseSchema(classPackSchema);
export type ClassPack = z.infer<typeof classPackSchema>;
export type CreateClassPackRequest = z.input<typeof createClassPackRequestSchema>;
export type UpdateClassPackRequest = z.input<typeof updateClassPackRequestSchema>;
