// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { paymentAttemptStatusSchema } from '../states.js';
import {
  amountCentsSchema, idSchema, instantSchema, listResponseSchema, moneySchema, paginationSchema,
} from '../common.js';

// Safe to share with the payer portal: no processor ID or customer ID.
export const maskedPaymentMethodSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  householdId: idSchema,
  brand: z.string().nullable(),
  last4: z.string().regex(/^[0-9]{4}$/).nullable(),
  expiryMonth: z.int32().min(1).max(12).nullable(),
  expiryYear: z.int32().min(2000).nullable(),
  isDefault: z.boolean(),
  revokedAt: instantSchema.nullable(),
}).refine((value) => !value.isDefault || value.revokedAt === null, 'A revoked card cannot be the default.');
export const paymentMethodResponseSchema = z.strictObject({ data: maskedPaymentMethodSchema });
export const paymentMethodListResponseSchema = listResponseSchema(maskedPaymentMethodSchema).refine(
  (page) => {
    const defaults = page.data.filter((method) => method.isDefault).map((method) => method.householdId);
    return new Set(defaults).size === defaults.length;
  }, 'A household has at most one default card.',
);
export const billingPaymentMethodListQuerySchema = paginationSchema;
export const billingEmptyRequestSchema = z.strictObject({});

export const billingPaymentMethodSchema = z.enum(['card', 'cash', 'check', 'other']);
export const paymentSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  invoiceId: idSchema,
  method: billingPaymentMethodSchema,
  ...moneySchema.shape,
  amountCents: amountCentsSchema.positive(),
  reference: z.string().nullable(),
  paidAt: instantSchema,
});
export const paymentResponseSchema = z.strictObject({ data: paymentSchema });
export const paymentListResponseSchema = listResponseSchema(paymentSchema);
export const billingPaymentListQuerySchema = paginationSchema.extend({
  invoiceId: idSchema.optional(),
  method: billingPaymentMethodSchema.optional(),
});
export const recordManualPaymentRequestSchema = moneySchema.extend({
  amountCents: amountCentsSchema.positive(),
  method: z.enum(['cash', 'check', 'other']),
  reference: z.string().trim().min(1).nullable().default(null),
  paidAt: instantSchema,
});

export const refundStatusSchema = z.enum(['pending', 'succeeded', 'failed']);
export const refundSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  paymentId: idSchema,
  ...moneySchema.shape,
  amountCents: amountCentsSchema.positive(),
  status: refundStatusSchema,
  reason: z.string().nullable(),
  resolvedAt: instantSchema.nullable(),
});
export const createRefundRequestSchema = moneySchema.extend({
  amountCents: amountCentsSchema.positive(),
  reason: z.string().trim().min(1).nullable().default(null),
});
export const refundResponseSchema = z.strictObject({ data: refundSchema });
export const refundListResponseSchema = listResponseSchema(refundSchema);
export const billingRefundListQuerySchema = paginationSchema.extend({
  paymentId: idSchema.optional(),
  status: refundStatusSchema.optional(),
});

export { paymentAttemptStatusSchema } from '../states.js';
// Staff diagnostics omit savedPaymentMethod, stripeCustomerId and raw errors.
export const paymentAttemptSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  invoiceId: idSchema,
  attemptNumber: z.int32().positive(),
  ...moneySchema.shape,
  amountCents: amountCentsSchema.nonnegative(),
  status: paymentAttemptStatusSchema,
  declineCode: z.string().nullable(),
  resolvedAt: instantSchema.nullable(),
});
export const chargeInvoiceResponseSchema = z.strictObject({ data: paymentAttemptSchema });

// URLs and session identifiers are transient Checkout results, not stored card
// data. The server builds its own return URLs; the client cannot redirect it.
export const billingCheckoutResultSchema = z.strictObject({
  sessionId: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
});
export const invoiceCheckoutResponseSchema = z.strictObject({
  data: billingCheckoutResultSchema.extend({
    mode: z.literal('payment'), invoiceId: idSchema, householdId: idSchema,
  }),
});
export const cardSetupCheckoutResponseSchema = z.strictObject({
  data: billingCheckoutResultSchema.extend({ mode: z.literal('setup'), householdId: idSchema }),
});
export const resendReceiptResponseSchema = z.strictObject({ data: z.strictObject({ queued: z.literal(true) }) });

export type MaskedPaymentMethod = z.infer<typeof maskedPaymentMethodSchema>;
export type BillingPaymentMethod = z.infer<typeof billingPaymentMethodSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type RecordManualPaymentRequest = z.input<typeof recordManualPaymentRequestSchema>;
export type Refund = z.infer<typeof refundSchema>;
export type RefundStatus = z.infer<typeof refundStatusSchema>;
export type CreateRefundRequest = z.input<typeof createRefundRequestSchema>;
export type PaymentAttempt = z.infer<typeof paymentAttemptSchema>;
export type PaymentAttemptStatus = z.infer<typeof paymentAttemptStatusSchema>;
export type BillingCheckoutResult = z.infer<typeof billingCheckoutResultSchema>;
export type InvoiceCheckoutResponse = z.infer<typeof invoiceCheckoutResponseSchema>;
export type CardSetupCheckoutResponse = z.infer<typeof cardSetupCheckoutResponseSchema>;
