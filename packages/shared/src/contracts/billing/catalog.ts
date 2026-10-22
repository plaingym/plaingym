// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
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

const taxRateFieldsSchema = z.strictObject({
  name: nameSchema,
  rateMillionths: taxRateMillionthsSchema,
  inclusive: z.boolean(),
  active: z.boolean(),
});
export const createTaxRateRequestSchema = taxRateFieldsSchema.extend({ active: z.boolean().default(true) });
export const updateTaxRateRequestSchema = taxRateFieldsSchema.partial().extend({
  revision: revisionSchema,
}).refine((value) => Object.keys(value).some((key) => key !== 'revision'), 'Supply a change.');
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
});
export const updatePlanRequestSchema = planFieldsSchema.partial().extend({
  revision: revisionSchema,
}).refine((value) => Object.keys(value).some((key) => key !== 'revision'), 'Supply a change.');
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
});
export const updateChargeTypeRequestSchema = chargeTypeFieldsSchema.partial().extend({
  revision: revisionSchema,
}).refine((value) => Object.keys(value).some((key) => key !== 'revision'), 'Supply a change.');
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
export type Plan = z.infer<typeof planSchema>;
export type CreatePlanRequest = z.input<typeof createPlanRequestSchema>;
export type UpdatePlanRequest = z.input<typeof updatePlanRequestSchema>;
export type ChargeType = z.infer<typeof chargeTypeSchema>;
export type CreateChargeTypeRequest = z.input<typeof createChargeTypeRequestSchema>;
export type UpdateChargeTypeRequest = z.input<typeof updateChargeTypeRequestSchema>;
export type BillingCatalogListQuery = z.infer<typeof billingCatalogListQuerySchema>;
