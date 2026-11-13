// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { dateSchema, idSchema, instantSchema, paginationMetaSchema, paginationSchema } from '../common.js';

/** The payer is derived from the member under lock; callers cannot choose another household. */
export const sellClassPackRequestSchema = z.strictObject({ memberId: idSchema, dueOn: dateSchema });
export type SellClassPackRequest = z.infer<typeof sellClassPackRequestSchema>;

export const adjustClassCreditsRequestSchema = z.strictObject({
  memberId: idSchema,
  credits: z.int().min(-100).max(100).refine(value => value !== 0),
  reason: z.string().trim().min(1).max(500),
  adjustmentId: idSchema,
});
export type AdjustClassCreditsRequest = z.infer<typeof adjustClassCreditsRequestSchema>;
export const classCreditLedgerQuerySchema = paginationSchema;
export const classCreditEntrySchema = z.strictObject({
  id: idSchema, memberId: idSchema, kind: z.enum(['grant', 'use', 'expire', 'reverse', 'adjust']),
  credits: z.int(), lotId: idSchema.nullable(), saleId: idSchema.nullable(),
  attendanceId: idSchema.nullable(), expiresAt: instantSchema.nullable(), reason: z.string().nullable(),
  adjustmentId: idSchema.nullable(), createdBy: idSchema.nullable(), createdAt: instantSchema,
  invoiceId: idSchema.nullable(), invoiceNumber: z.int().positive().nullable(),
});
export const classCreditLotSchema = z.strictObject({
  id: idSchema, remaining: z.int().positive(), expiresAt: instantSchema.nullable(),
  createdAt: instantSchema, saleId: idSchema.nullable(), invoiceId: idSchema.nullable(), invoiceNumber: z.int().positive().nullable(),
});
export const classCreditLedgerResponseSchema = z.strictObject({
  data: z.strictObject({ memberId: idSchema, balance: z.int().nonnegative(),
    lots: z.array(classCreditLotSchema), entries: z.array(classCreditEntrySchema) }),
  pagination: paginationMetaSchema,
});
export const adjustClassCreditsResponseSchema = z.strictObject({
  data: z.strictObject({ adjustmentId: idSchema, balance: z.int().nonnegative(), entries: z.array(classCreditEntrySchema) }),
});
