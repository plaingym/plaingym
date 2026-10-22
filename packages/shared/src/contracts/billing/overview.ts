// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import {
  amountCentsSchema, dateSchema, idSchema,
  listResponseSchema, moneySchema, paginationSchema,
} from '../common.js';

export const billingUpcomingQuerySchema = paginationSchema.extend({ through: dateSchema });
export const billingUpcomingChargeSchema = z.strictObject({
  householdId: idSchema,
  dueOn: dateSchema,
  ...moneySchema.shape,
  amountCents: amountCentsSchema.nonnegative(),
});
export const billingUpcomingResponseSchema = listResponseSchema(billingUpcomingChargeSchema);
// Disputes are flags on invoices in the locked schema, not a disputes table.
export const billingDisputeSchema = z.strictObject({
  invoiceId: idSchema,
  householdId: idSchema,
  disputeId: z.string().min(1),
  disputeStatus: z.string().min(1),
  ...moneySchema.shape,
  amountCents: amountCentsSchema.nonnegative(),
});
export const billingDisputeListQuerySchema = paginationSchema;
export const billingDisputeListResponseSchema = listResponseSchema(billingDisputeSchema);

export type BillingUpcomingCharge = z.infer<typeof billingUpcomingChargeSchema>;
export type BillingDispute = z.infer<typeof billingDisputeSchema>;
