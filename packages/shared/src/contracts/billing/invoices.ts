// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { invoiceKindSchema, invoiceStatusSchema } from '../states.js';
import {
  amountCentsSchema, dateSchema, idSchema, instantSchema, listResponseSchema,
  moneySchema, paginationSchema, taxRateMillionthsSchema,
} from '../common.js';
import { paymentSchema, refundSchema } from './payments.js';
import type { EndpointContract } from '../definition.js';

export { invoiceKindSchema } from '../states.js';
export { invoiceStatusSchema } from '../states.js';
export const invoiceSchema = z.strictObject({
  id: idSchema,
  createdAt: instantSchema,
  householdId: idSchema,
  kind: invoiceKindSchema,
  status: invoiceStatusSchema,
  number: z.int32().positive().nullable(),
  dueOn: dateSchema,
  periodStartsOn: dateSchema.nullable(),
  periodEndsOn: dateSchema.nullable(),
  ...moneySchema.shape,
  amountCents: amountCentsSchema.nonnegative(),
  paidAt: instantSchema.nullable(),
  needsReview: z.boolean(),
  disputeId: z.string().nullable(),
  disputeStatus: z.string().nullable(),
}).superRefine((invoice, context) => {
  if ((invoice.status === 'draft') !== (invoice.number === null)) {
    context.addIssue({ code: 'custom', path: ['number'], message: 'Only drafts have no display number.' });
  }
  if (invoice.kind === 'cycle' && (
    invoice.periodStartsOn === null || invoice.periodEndsOn === null || invoice.periodEndsOn <= invoice.periodStartsOn
  )) {
    context.addIssue({ code: 'custom', path: ['periodEndsOn'], message: 'A cycle needs an increasing billing period.' });
  }
});

const lineFields = {
  id: idSchema,
  createdAt: instantSchema,
  householdId: idSchema,
  invoiceId: idSchema,
  membershipId: idSchema.nullable(),
  chargeTypeId: idSchema.nullable(),
  description: z.string().min(1),
  ...moneySchema.shape,
  quantity: z.int32().positive(),
};
export const invoiceLineItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...lineFields,
    kind: z.literal('tax'),
    taxRateId: idSchema.nullable(),
    taxRateMillionths: taxRateMillionthsSchema,
    taxInclusive: z.boolean(),
  }),
  z.strictObject({
    ...lineFields,
    kind: z.enum(['membership', 'signup_fee', 'charge', 'discount']),
    taxRateId: z.null(),
    taxRateMillionths: z.null(),
    taxInclusive: z.null(),
  }),
]);
export const invoiceDetailSchema = z.strictObject({
  invoice: invoiceSchema,
  lineItems: z.array(invoiceLineItemSchema),
  payments: z.array(paymentSchema),
  refunds: z.array(refundSchema),
}).superRefine((detail, context) => {
  for (const [index, line] of detail.lineItems.entries()) {
    if (line.currency !== detail.invoice.currency || line.invoiceId !== detail.invoice.id ||
      line.householdId !== detail.invoice.householdId) {
      context.addIssue({ code: 'custom', path: ['lineItems', index], message: 'Line must match its invoice and household.' });
    }
  }
  for (const [index, payment] of detail.payments.entries()) {
    if (payment.currency !== detail.invoice.currency || payment.invoiceId !== detail.invoice.id) {
      context.addIssue({ code: 'custom', path: ['payments', index], message: 'Payment must match its invoice.' });
    }
  }
  const paymentIds = new Set(detail.payments.map((payment) => payment.id));
  for (const [index, refund] of detail.refunds.entries()) {
    if (refund.currency !== detail.invoice.currency || !paymentIds.has(refund.paymentId)) {
      context.addIssue({ code: 'custom', path: ['refunds', index], message: 'Refund must match an invoice payment.' });
    }
  }
});
export const invoiceResponseSchema = z.strictObject({ data: invoiceSchema });
/** Staff confirmation clears a review hold without collecting money. */
export const releaseInvoiceHoldContract = {
  method: 'post', path: '/api/billing/invoices/{invoiceId}/release-hold',
  permission: { kind: 'staff', capability: 'refunds.create' },
  params: z.strictObject({ invoiceId: idSchema }), body: z.strictObject({}),
  response: invoiceResponseSchema, successStatus: 200,
} as const satisfies EndpointContract;
export const invoiceDetailResponseSchema = z.strictObject({ data: invoiceDetailSchema });
export const invoiceListResponseSchema = listResponseSchema(invoiceSchema);
export const invoiceListQuerySchema = paginationSchema.extend({
  householdId: idSchema.optional(),
  kind: invoiceKindSchema.optional(),
  status: invoiceStatusSchema.optional(),
  dueFrom: dateSchema.optional(),
  dueThrough: dateSchema.optional(),
}).refine((value) => !value.dueFrom || !value.dueThrough || value.dueThrough >= value.dueFrom,
  'The due-date range must be increasing.');

const oneOffFields = { householdId: idSchema, dueOn: dateSchema };
export const createOneOffInvoiceRequestSchema = z.discriminatedUnion('source', [
  z.strictObject({ ...oneOffFields, source: z.literal('charge_type'), chargeTypeId: idSchema }),
  z.strictObject({
    ...oneOffFields,
    source: z.literal('custom'),
    description: z.string().trim().min(1),
    ...moneySchema.shape,
    amountCents: amountCentsSchema.nonnegative(),
    taxRateIds: z.array(idSchema).refine((ids) => new Set(ids).size === ids.length, 'Tax rates must be distinct.').default([]),
  }),
]);

export type InvoiceKind = z.infer<typeof invoiceKindSchema>;
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceLineItem = z.infer<typeof invoiceLineItemSchema>;
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
export type CreateOneOffInvoiceRequest = z.input<typeof createOneOffInvoiceRequestSchema>;
