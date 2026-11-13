// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { EndpointContract } from './definition.js';
import { idSchema } from './common.js';
import { sellClassPackRequestSchema, adjustClassCreditsRequestSchema, adjustClassCreditsResponseSchema,
  classCreditLedgerQuerySchema, classCreditLedgerResponseSchema } from './billing/packs.js';
import {
  createClassPackRequestSchema, updateClassPackRequestSchema, classPackResponseSchema, classPackListResponseSchema,
  billingCatalogListQuerySchema, billingTaxRateListQuerySchema,
  chargeTypeListResponseSchema, chargeTypeResponseSchema,
  createChargeTypeRequestSchema, createPlanRequestSchema, createTaxRateRequestSchema,
  planListResponseSchema, planResponseSchema, taxRateListResponseSchema, taxRateResponseSchema, taxRateUsageResponseSchema,
  updateChargeTypeRequestSchema, updatePlanRequestSchema, updateTaxRateRequestSchema,
} from './billing/catalog.js';
import {
  activateMembershipRequestSchema, assignMembershipRequestSchema, cancelMembershipRequestSchema,
  cancelMembershipSwitchRequestSchema, freezeMembershipRequestSchema, membershipListQuerySchema, membershipListResponseSchema,
  membershipResponseSchema, membershipSwitchPreviewQuerySchema, membershipSwitchPreviewResponseSchema,
  membershipSwitchResponseSchema, resumeMembershipRequestSchema, switchMembershipPlanRequestSchema,
  updateMembershipRequestSchema, setMembershipDiscountRequestSchema, removeMembershipDiscountRequestSchema,
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
export * from './billing/packs.js';
export * from './billing/memberships.js';
export * from './billing/invoices.js';
export * from './billing/payments.js';
export * from './billing/overview.js';

export const billingTaxRateParamsSchema = z.strictObject({ taxRateId: idSchema });
export const billingPlanParamsSchema = z.strictObject({ planId: idSchema });
export const billingChargeTypeParamsSchema = z.strictObject({ chargeTypeId: idSchema });
export const billingClassPackParamsSchema = z.strictObject({ packId: idSchema });
export const billingCreditMemberParamsSchema = z.strictObject({ memberId: idSchema });
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
  adjustClassCredits: { method: 'post', path: '/api/billing/credits/adjust', permission: collect,
    body: adjustClassCreditsRequestSchema, response: adjustClassCreditsResponseSchema, successStatus: 200 },
  getClassCreditLedger: { method: 'get', path: '/api/billing/members/{memberId}/credits', permission: read,
    params: billingCreditMemberParamsSchema, query: classCreditLedgerQuerySchema, response: classCreditLedgerResponseSchema, successStatus: 200 },
  sellClassPack: { method: 'post', path: '/api/billing/packs/{packId}/sell', permission: collect,
    params: billingClassPackParamsSchema, body: sellClassPackRequestSchema, response: invoiceResponseSchema, successStatus: 201 },
  listClassPacks: { method: 'get', path: '/api/billing/class-packs', permission: read,
    query: billingCatalogListQuerySchema, response: classPackListResponseSchema, successStatus: 200 },
  getClassPack: { method: 'get', path: '/api/billing/class-packs/{packId}', permission: read,
    params: billingClassPackParamsSchema, response: classPackResponseSchema, successStatus: 200 },
  createClassPack: { method: 'post', path: '/api/billing/class-packs', permission: catalog,
    body: createClassPackRequestSchema, response: classPackResponseSchema, successStatus: 201 },
  updateClassPack: { method: 'patch', path: '/api/billing/class-packs/{packId}', permission: catalog,
    params: billingClassPackParamsSchema, body: updateClassPackRequestSchema, response: classPackResponseSchema, successStatus: 200 },
  releaseInvoiceHold: releaseInvoiceHoldContract,
  listTaxRates: { method: 'get', path: '/api/billing/tax-rates', permission: read,
    query: billingTaxRateListQuerySchema, response: taxRateListResponseSchema, successStatus: 200 },
  getTaxRate: { method: 'get', path: '/api/billing/tax-rates/{taxRateId}', permission: read,
    params: billingTaxRateParamsSchema, response: taxRateResponseSchema, successStatus: 200 },
  createTaxRate: { method: 'post', path: '/api/billing/tax-rates', permission: taxes,
    body: createTaxRateRequestSchema, response: taxRateResponseSchema, successStatus: 201 },
  getTaxRateUsage: { method: 'get', path: '/api/billing/tax-rates/{taxRateId}/usage', permission: read,
    description: 'Lists the charge types, class packs and plans the tax rate is attached to, with the number of memberships '
      + '(not cancelled) on each plan, so archiving it can say what changes.',
    params: billingTaxRateParamsSchema, response: taxRateUsageResponseSchema, successStatus: 200 },
  updateTaxRate: { method: 'patch', path: '/api/billing/tax-rates/{taxRateId}', permission: taxes,
    description: 'Updates a tax rate. Archiving an active rate (`active: false`) while charge types, class packs or plans carry it is a 409 '
      + 'listing them (`details.chargeTypes`, `details.packs`, `details.plans`, `details.memberships`), unless `detach: true` removes it '
      + 'from every one of them and archives it in one audited step.',
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
    description: 'Changes a membership\'s price or next due date. A plan or billing interval changes only through the plan switch. '
      + 'A price replaces a scheduled price change and is refused while a plan switch is scheduled (`switch_scheduled`); a due '
      + 'date moved before a scheduled change\'s date moves that date with it.',
    params: billingMembershipParamsSchema, body: updateMembershipRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  setMembershipDiscount: { method: 'put', path: '/api/billing/memberships/{membershipId}/discount', permission: catalog,
    description: 'Adds or replaces the discount from the next invoice, with no proration. A replacement takes a new use.',
    params: billingMembershipParamsSchema, body: setMembershipDiscountRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  removeMembershipDiscount: { method: 'delete', path: '/api/billing/memberships/{membershipId}/discount', permission: catalog,
    description: 'Ends the discount from the next invoice, without returning a use or changing issued invoices.',
    params: billingMembershipParamsSchema, body: removeMembershipDiscountRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  switchMembershipPlan: { method: 'post', path: '/api/billing/memberships/{membershipId}/switch', permission: catalog,
    description: 'Switches a membership to another plan, on the next billing date (default) or `now`. Now is for active memberships '
      + 'and keeps the billing interval: an upgrade charges the price difference for the days left in the current period as one '
      + 'invoice, collected with the saved card, and a downgrade or equal switch keeps the current price until the next due date. '
      + 'A retry with the same `requestId` replays the result. Conflicts carry a `reason`.',
    params: billingMembershipParamsSchema, body: switchMembershipPlanRequestSchema, response: membershipSwitchResponseSchema, successStatus: 200 },
  cancelMembershipSwitch: { method: 'post', path: '/api/billing/memberships/{membershipId}/switch/cancel', permission: catalog,
    description: 'Cancels a scheduled plan switch that hasn\'t applied yet. The price change a downgrade now leaves isn\'t '
      + 'cancelled (`price_change`); a price edit replaces it.',
    params: billingMembershipParamsSchema, body: cancelMembershipSwitchRequestSchema, response: membershipResponseSchema, successStatus: 200 },
  previewMembershipSwitch: { method: 'get', path: '/api/billing/memberships/{membershipId}/switch/preview', permission: catalog,
    description: 'Shows what a plan switch would do, with the same conflicts as the switch except the commitment, which it reports.',
    params: billingMembershipParamsSchema, query: membershipSwitchPreviewQuerySchema, response: membershipSwitchPreviewResponseSchema,
    successStatus: 200 },
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
    description: 'Creates a one-off invoice. Requires `payments.record`. A request with `source: "charge_type"` bills an active charge type; '
      + 'a request with `source: "custom"` bills any amount and also requires `payments.custom` (owner, admin), otherwise the answer is 403, '
      + 'whether or not the rest of the body is valid.',
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
