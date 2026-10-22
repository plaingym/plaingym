// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// Keep the error shape and conflict code identical to the HTTP conventions.
export * from '../responses.js';

/** UUIDs on the wire; generated record IDs use UUIDv7. */
export const idSchema = z.uuid();
/** Calendar date in the gym's timezone, without a time or UTC conversion. */
export const dateSchema = z.iso.date();
/** ISO timestamp with an explicit UTC marker or numeric timezone offset. */
export const instantSchema = z.iso.datetime({ offset: true });
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
/** PostgreSQL integer cents; negative values are valid for discount lines. */
export const amountCentsSchema = z.int32();
export const moneySchema = z.strictObject({
  amountCents: amountCentsSchema,
  currency: currencySchema,
});
/** 99,750 millionths = 9.975%; the database permits rates from 0% to 100%. */
export const taxRateMillionthsSchema = z.int32().min(0).max(1_000_000);
/** The revision read by the client; freshness is checked atomically when saving. */
export const revisionSchema = z.int32().positive();

const pageLimitSchema = z.int().min(1).max(100);
const pageOffsetSchema = z.int().nonnegative();
// Accept JSON integers and canonical decimal query parameters without coercing
// null, booleans, empty strings, fractions, or exponent notation into integers.
const queryIntegerSchema = z.union([
  z.number(),
  z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number),
]).pipe(z.int());

/** Offset pagination: 50 items by default, at most 100 items per page. */
export const paginationSchema = z.strictObject({
  limit: queryIntegerSchema.pipe(pageLimitSchema).default(50),
  offset: queryIntegerSchema.pipe(pageOffsetSchema).default(0),
});
/** Response metadata always includes the effective page bounds and total count. */
export const paginationMetaSchema = z.strictObject({
  limit: pageLimitSchema,
  offset: pageOffsetSchema,
  total: z.int().nonnegative(),
});

/** Matches the existing { data } convention, with pagination beside the data. */
export function listResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.strictObject({
    data: z.array(itemSchema),
    pagination: paginationMetaSchema,
  });
}

export type Id = z.infer<typeof idSchema>;
export type IsoDate = z.infer<typeof dateSchema>;
export type IsoInstant = z.infer<typeof instantSchema>;
export type Currency = z.infer<typeof currencySchema>;
export type AmountCents = z.infer<typeof amountCentsSchema>;
export type Money = z.infer<typeof moneySchema>;
export type TaxRateMillionths = z.infer<typeof taxRateMillionthsSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type PaginationInput = z.input<typeof paginationSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;
export type ListResponse<T> = { data: T[]; pagination: PaginationMeta };
