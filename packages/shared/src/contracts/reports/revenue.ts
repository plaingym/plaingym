// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { currencySchema, idSchema } from '../common.js';
import type { reportBucketSchema, reportRangeQuerySchema, ReportRangeQuery } from '../reports.js';

// Discounts have negative payments and refunds. Aggregates can exceed a DB int32.
export const revenueAmountsSchema = z.strictObject({ payments: z.int(), refunds: z.int(), net: z.int() });
export const revenueGroupSchema = revenueAmountsSchema.extend({
  kind: z.enum(['plan', 'signup_fee', 'charge_type', 'class_pack', 'other', 'discount', 'tax', 'unapplied']),
  id: idSchema.nullable(), name: z.string().nullable(),
});
/** Compose with the common report range and boundaries without a runtime import cycle. */
export function createRevenueReportResponseSchema(range: typeof reportRangeQuerySchema, bucket: typeof reportBucketSchema) {
  return z.strictObject({ data: range.safeExtend({ timezone: z.string(), currencies: z.array(z.strictObject({
    currency: currencySchema,
    buckets: z.array(bucket.extend({ groups: z.array(revenueGroupSchema),
      totals: revenueAmountsSchema.extend({ netBeforeTax: z.int(), netTax: z.int() }) })),
  })) }) });
}
export type RevenueReportQuery = ReportRangeQuery;
export type RevenueGroup = z.infer<typeof revenueGroupSchema>;
export type RevenueReportResponse = z.infer<ReturnType<typeof createRevenueReportResponseSchema>>;
