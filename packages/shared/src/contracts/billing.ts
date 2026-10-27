// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { idSchema } from './common.js';
import {
  billingCatalogListQuerySchema, billingTaxRateListQuerySchema,
  chargeTypeListResponseSchema, chargeTypeResponseSchema,
  createChargeTypeRequestSchema, createPlanRequestSchema, createTaxRateRequestSchema,
  planListResponseSchema, planResponseSchema, taxRateListResponseSchema, taxRateResponseSchema,
  updateChargeTypeRequestSchema, updatePlanRequestSchema, updateTaxRateRequestSchema,
} from './billing/catalog.js';
import {
  activateMembershipRequestSchema, assignMembershipRequestSchema, cancelMembershipRequestSchema,
  freezeMembershipRequestSchema, membershipListQuerySchema, membershipListResponseSchema,
  membershipResponseSchema, resumeMembershipRequestSchema, updateMembershipRequestSchema,
} from './billing/memberships.js';
import {
  createOneOffInvoiceRequestSchema, invoiceDetailResponseSchema, invoiceListQuerySchema,
  invoiceListResponseSchema, invoiceResponseSchema, releaseInvoiceHoldContract,
} from './billing/invoices.js';
import {
  billingEmptyRequestSchema, billingPaymentListQuerySchema, billingPaymentMethodListQuerySchema,
  billingRefundListQuerySchema, chargeInvoiceResponseSchema,
  createRefundRequestSchema, paymentListResponseSchema,
  paymentMethodListResponseSchema, paymentMethodResponseSchema, paymentResponseSchema,
  recordManualPaymentRequestSchema, refundListResponseSchema, refundResponseSchema, resendReceiptResponseSchema,
} from './billing/payments.js';

export * from './billing/catalog.js';
export * from './billing/memberships.js';
export * from './billing/invoices.js';
export * from './billing/payments.js';
export * from './billing/overview.js';

export const billingTaxRateParamsSchema = z.strictObject({ taxRateId: idSchema });
export const billingPlanParamsSchema = z.strictObject({ planId: idSchema });
export const billingChargeTypeParamsSchema = z.strictObject({ chargeTypeId: idSchema });
export const billingMembershipParamsSchema = z.strictObject({ membershipId: idSchema });
export const billingInvoiceParamsSchema = z.strictObject({ invoiceId: idSchema });
export const billingHouseholdParamsSchema = z.strictObject({ householdId: idSchema });
export const billingPaymentMethodParamsSchema = z.strictObject({ householdId: idSchema, paymentMethodId: idSchema });
export const billingPaymentParamsSchema = z.strictObject({ paymentId: idSchema });

export type BillingEndpointContract = EndpointContract;

const read = { kind: 'staff', capability: 'billing.read' } as const;
const catalog = { kind: 'staff', capability: 'plans.manage' } as const;
const taxes = { kind: 'staff', capability: 'taxes.manage' } as const;
const collect = { kind: 'staff', capability: 'payments.record' } as const;

/**
 * Declarative HTTP contracts only; no routes are mounted here. Paths are
 * absolute. Failures use ErrorResponse; stale revisions use conflict (409).
 * Services check gym currency, related-record ownership, revision freshness,
 * lifecycle transitions and refund balances atomically. Dashboard widgets and
 * go-live settings are declared by the dashboard and settings areas.
 * Member and signed-link endpoints declare their narrower grants in their own
 * area contracts; these endpoints all require the named staff capability.
 */
export const billingContracts = {
  releaseInvoiceHold: releaseInvoiceHoldContract,
  listTaxRates: { method: 'get', path: '/api/billing/tax-rates', permission: read,
    query: billingTaxRateListQuerySchema, response: taxRateListResponseSchema, successStatus: 200 },
  getTaxRate: { method: 'get', path: '/api/billing/tax-rates/{taxRateId}', permission: read,
    params: billingTaxRateParamsSchema, response: taxRateResponseSchema, successStatus: 200 },
  createTaxRate: { method: 'post', path: '/api/billing/tax-rates', permission: taxes,
    body: createTaxRateRequestSchema, response: taxRateResponseSchema, successStatus: 201 },
  updateTaxRate: { method: 'patch', path: '/api/billing/tax-rates/{taxRateId}', permission: taxes,
    params: billingTaxRateParamsSchema, body: updateTaxRateRequestSchema, response: taxRateResponseSchema, successStatus: 200 },
  listPlans: { method: 'get', path: '/api/billing/plans', permission: read,
    query: billingCatalogListQuerySchema, response: planListResponseSchema, successStatus: 200 },
  getPlan: { method: 'get', path: '/api/billing/plans/{planId}', permission: read,
    params: billingPlanParamsSchema, response: planResponseSchema, successStatus: 200 },
  createPlan: { method: 'post', path: '/api/billing/plans', permission: catalog,
    body: createPlanRequestSchema, response: planResponseSchema, successStatus: 201 },
  updatePlan: { method: 'patch', path: '/api/billing/plans/{planId}', permission: catalog,
    params: billingPlanParamsSchema, body: updatePlanRequestSchema, response: planResponseSchema, successStatus: 200 },
  listChargeTypes: { method: 'get', path: '/api/billing/charge-types', permission: read,
    query: billingCatalogListQuerySchema, response: chargeTypeListResponseSchema, successStatus: 200 },
  getChargeType: { method: 'get', path: '/api/billing/charge-types/{chargeTypeId}', permission: read,
    params: billingChargeTypeParamsSchema, response: chargeTypeResponseSchema, successStatus: 200 },
  createChargeType: { method: 'post', path: '/api/billing/charge-types', permission: catalog,
    body: createChargeTypeRequestSchema, response: chargeTypeResponseSchema, successStatus: 201 },
  updateChargeType: { method: 'patch', path: '/api/billing/charge-types/{chargeTypeId}', permission: catalog,
    params: billingChargeTypeParamsSchema, body: updateChargeTypeRequestSchema, response: chargeTypeResponseSchema, successStatus: 200 },
  listMemberships: { method: 'get', path: '/api/billing/memberships', permission: read,
    query: membershipListQuerySchema, response: membershipListResponseSchema, successStatus: 200 },
  getMembership: { method: 'get', path: '/api/billing/memberships/{membershipId}', permission: read,
    params: billingMembershipParamsSchema, response: membershipResponseSchema, successStatus: 200 },
  assignMembership: { method: 'post', path: '/api/billing/memberships', permission: catalog,
    body: assignMembershipRequestSchema, response: membershipResponseSchema, successStatus: 201 },
  updateMembership: { method: 'patch', path: '/api/billing/memberships/{membershipId}', permission: catalog,
    params: billingMembershipParamsSchema, body: updateMembershipRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  activateMembership: { method: 'post', path: '/api/billing/memberships/{membershipId}/activate', permission: catalog,
    params: billingMembershipParamsSchema, body: activateMembershipRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  freezeMembership: { method: 'post', path: '/api/billing/memberships/{membershipId}/freeze', permission: catalog,
    params: billingMembershipParamsSchema, body: freezeMembershipRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  resumeMembership: { method: 'post', path: '/api/billing/memberships/{membershipId}/resume', permission: catalog,
    params: billingMembershipParamsSchema, body: resumeMembershipRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  cancelMembership: { method: 'post', path: '/api/billing/memberships/{membershipId}/cancel', permission: catalog,
    params: billingMembershipParamsSchema, body: cancelMembershipRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  listInvoices: { method: 'get', path: '/api/billing/invoices', permission: read,
    query: invoiceListQuerySchema, response: invoiceListResponseSchema, successStatus: 200 },
  getInvoice: { method: 'get', path: '/api/billing/invoices/{invoiceId}', permission: read,
    params: billingInvoiceParamsSchema, response: invoiceDetailResponseSchema, successStatus: 200 },
  createOneOffInvoice: { method: 'post', path: '/api/billing/invoices/one-off', permission: collect,
    body: createOneOffInvoiceRequestSchema, response: invoiceResponseSchema, successStatus: 201 },
  chargeInvoice: { method: 'post', path: '/api/billing/invoices/{invoiceId}/charge', permission: collect,
    params: billingInvoiceParamsSchema, body: billingEmptyRequestSchema, response: chargeInvoiceResponseSchema, successStatus: 200 },
  recordManualPayment: { method: 'post', path: '/api/billing/invoices/{invoiceId}/payments', permission: collect,
    params: billingInvoiceParamsSchema, body: recordManualPaymentRequestSchema, response: paymentResponseSchema, successStatus: 201 },
  resendReceipt: { method: 'post', path: '/api/billing/invoices/{invoiceId}/receipt', permission: collect,
    params: billingInvoiceParamsSchema, body: billingEmptyRequestSchema, response: resendReceiptResponseSchema, successStatus: 200 },
  listPaymentMethods: { method: 'get', path: '/api/billing/households/{householdId}/payment-methods', permission: read,
    params: billingHouseholdParamsSchema, query: billingPaymentMethodListQuerySchema,
    response: paymentMethodListResponseSchema, successStatus: 200 },
  setDefaultPaymentMethod: { method: 'post', path: '/api/billing/households/{householdId}/payment-methods/{paymentMethodId}/default',
    permission: collect, params: billingPaymentMethodParamsSchema, body: billingEmptyRequestSchema,
    response: paymentMethodResponseSchema, successStatus: 200 },
  revokePaymentMethod: { method: 'post', path: '/api/billing/households/{householdId}/payment-methods/{paymentMethodId}/revoke',
    permission: collect, params: billingPaymentMethodParamsSchema, body: billingEmptyRequestSchema,
    response: paymentMethodResponseSchema, successStatus: 200 },
  listPayments: { method: 'get', path: '/api/billing/payments', permission: read,
    query: billingPaymentListQuerySchema, response: paymentListResponseSchema, successStatus: 200 },
  listRefunds: { method: 'get', path: '/api/billing/refunds', permission: read,
    query: billingRefundListQuerySchema, response: refundListResponseSchema, successStatus: 200 },
  createRefund: { method: 'post', path: '/api/billing/payments/{paymentId}/refunds',
    permission: { kind: 'staff', capability: 'refunds.create' }, params: billingPaymentParamsSchema,
    body: createRefundRequestSchema, response: refundResponseSchema, successStatus: 201 },
} as const satisfies Record<string, BillingEndpointContract>;

export type BillingEndpoint = keyof typeof billingContracts;
