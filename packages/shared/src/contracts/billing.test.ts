// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { canStaff, isRoutePermission, staffRoles } from '@plaingym/shared';
import type {
  chargeTypes, invoiceLineItems, invoices, memberships, paymentAttempts,
  paymentMethods, payments, plans, refunds, taxRates,
} from '../../../db/src/schema/index.js';
import {
  AppError, errorResponse, billingContracts,
  activateMembershipRequestSchema, assignMembershipRequestSchema,
  billingCatalogListQuerySchema, billingCheckoutResultSchema, billingInvoiceParamsSchema, billingUpcomingQuerySchema,
  cancelMembershipRequestSchema, cardSetupCheckoutResponseSchema,
  chargeTypeResponseSchema, createChargeTypeRequestSchema, createOneOffInvoiceRequestSchema,
  createPlanRequestSchema, createRefundRequestSchema, createTaxRateRequestSchema,
  freezeMembershipRequestSchema, invoiceCheckoutResponseSchema, invoiceDetailResponseSchema,
  invoiceLineItemSchema, invoiceListQuerySchema, invoiceListResponseSchema, invoiceSchema,
  maskedPaymentMethodSchema, membershipResponseSchema, membershipStatusSchema,
  paymentAttemptSchema, paymentMethodListResponseSchema, planResponseSchema,
  recordManualPaymentRequestSchema, refundResponseSchema, resumeMembershipRequestSchema,
  taxRateResponseSchema, updateChargeTypeRequestSchema,
  updateMembershipRequestSchema, updatePlanRequestSchema, updateTaxRateRequestSchema,
  type BillingEndpointContract, type ChargeType, type Invoice,
  type InvoiceLineItem, type MaskedPaymentMethod, type Membership, type Payment,
  type PaymentAttempt, type Plan, type Refund, type TaxRate,
} from '@plaingym/shared/contracts';

const ids = {
  household: '019a08bf-1234-7000-8000-000000000001',
  member: '019a08bf-1234-7000-8000-000000000002',
  plan: '019a08bf-1234-7000-8000-000000000003',
  invoice: '019a08bf-1234-7000-8000-000000000004',
  tax: '019a08bf-1234-7000-8000-000000000005',
  payment: '019a08bf-1234-7000-8000-000000000006',
  other: '019a08bf-1234-7000-8000-000000000007',
};
const now = '2026-10-21T12:00:00Z';
const price = { amountCents: 10_000, currency: 'CAD' };
const planInput = { name: 'Monthly', ...price, interval: 'monthly' } as const;
const plan: Plan = {
  id: ids.plan, createdAt: now, ...planInput, signupFeeCents: 0, trialDays: 0,
  commitmentMonths: 12, active: true, revision: 3, taxRateIds: [ids.tax, ids.other],
};
const membership: Membership = {
  id: ids.other, createdAt: now, householdId: ids.household, memberId: ids.member,
  planId: ids.plan, ...price, interval: 'monthly', status: 'active', nextDueOn: '2026-11-21',
  startsOn: '2026-10-21', trialEndsOn: null, frozenAt: null, resumesOn: null,
  cancelledAt: null, commitmentEndsOn: '2027-10-21', revision: 1,
};
const invoice: Invoice = {
  id: ids.invoice, createdAt: now, householdId: ids.household, ...price, kind: 'cycle',
  status: 'open', number: 12, dueOn: '2026-10-21', periodStartsOn: '2026-10-21',
  periodEndsOn: '2026-11-21', paidAt: null, needsReview: false, disputeId: null, disputeStatus: null,
};
const line: InvoiceLineItem = {
  id: ids.other, createdAt: now, householdId: ids.household, invoiceId: ids.invoice,
  membershipId: membership.id, chargeTypeId: null, description: 'Monthly', ...price,
  kind: 'membership', quantity: 1, taxRateId: null, taxRateMillionths: null, taxInclusive: null,
};
const payment: Payment = {
  id: ids.payment, createdAt: now, invoiceId: ids.invoice, ...price, method: 'cash', reference: null, paidAt: now,
};
const refund: Refund = {
  id: ids.other, createdAt: now, paymentId: ids.payment, amountCents: 100, currency: 'CAD',
  status: 'succeeded', reason: null, resolvedAt: now,
};
const card: MaskedPaymentMethod = {
  id: ids.other, createdAt: now, householdId: ids.household, brand: 'visa', last4: '4242',
  expiryMonth: 12, expiryYear: 2028, isDefault: true, revokedAt: null,
};
const page = { limit: 50, offset: 0, total: 1 };
const detail = { invoice, lineItems: [line], payments: [payment], refunds: [refund] };

describe('billing catalog', () => {
  it('accepts multiple taxes, millionths, free trials, and optional commitments', () => {
    expect(createTaxRateRequestSchema.parse({ name: 'QST', rateMillionths: 99_750, inclusive: false }).rateMillionths).toBe(99_750);
    expect(createPlanRequestSchema.parse({ ...planInput, taxRateIds: [ids.tax, ids.other], commitmentMonths: 12 }).taxRateIds).toHaveLength(2);
    expect(createPlanRequestSchema.parse({ ...planInput, amountCents: 0, trialDays: 14 }).commitmentMonths).toBeNull();
    expect(createChargeTypeRequestSchema.parse({ name: 'Drop-in', ...price, taxRateIds: [ids.tax, ids.other] }).taxRateIds).toHaveLength(2);
    expect(planResponseSchema.parse({ data: plan }).data).toEqual(plan);
  });
  it.each([
    { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: 2_147_483_648 },
    { currency: 'cad' }, { currency: 'CA' }, { signupFeeCents: -1 }, { trialDays: -1 },
    { commitmentMonths: 0 }, { commitmentMonths: 1.5 }, { interval: 'weekly' },
    { taxRateIds: [ids.tax, ids.tax] }, { taxRateIds: ['1'] }, { name: '  ' },
  ])('rejects invalid plan fields %j', (changes) => {
    expect(createPlanRequestSchema.safeParse({ ...planInput, ...changes }).success).toBe(false);
  });
  it.each([-1, 1_000_001, 99_750.5])('rejects invalid tax rate %j', (rateMillionths) => {
    expect(createTaxRateRequestSchema.safeParse({ name: 'Tax', rateMillionths, inclusive: false }).success).toBe(false);
  });
  it('keeps PATCH defaults absent so changing a name cannot reset prices or tax assignments', () => {
    expect(updatePlanRequestSchema.parse({ revision: 3, name: 'Renamed' })).toEqual({ revision: 3, name: 'Renamed' });
    expect(updateTaxRateRequestSchema.parse({ revision: 3, name: 'Renamed' })).toEqual({ revision: 3, name: 'Renamed' });
    expect(updateChargeTypeRequestSchema.parse({ revision: 3, name: 'Renamed' })).toEqual({ revision: 3, name: 'Renamed' });
    expect(updatePlanRequestSchema.parse({ revision: 3, commitmentMonths: null }).commitmentMonths).toBeNull();
    for (const schema of [updatePlanRequestSchema, updateTaxRateRequestSchema, updateChargeTypeRequestSchema]) {
      expect(schema.safeParse({ revision: 3 }).success).toBe(false);
    }
  });
});

describe('revisions and membership lifecycle requests', () => {
  const updates: [z.ZodType, Record<string, unknown>][] = [
    [updateTaxRateRequestSchema, { name: 'Tax' }], [updatePlanRequestSchema, { name: 'Plan' }],
    [updateChargeTypeRequestSchema, { name: 'Charge' }], [updateMembershipRequestSchema, { nextDueOn: '2026-11-21' }],
    [activateMembershipRequestSchema, {}], [freezeMembershipRequestSchema, { resumesOn: null }],
    [resumeMembershipRequestSchema, { nextDueOn: '2026-11-21' }], [cancelMembershipRequestSchema, {}],
  ];
  it.each(updates)('requires a positive integer revision for every edit %#', (schema, fields) => {
    expect(schema.safeParse({ ...fields, revision: 2 }).success).toBe(true);
    for (const revision of [undefined, null, 0, -1, 1.5, '1']) {
      expect(schema.safeParse({ ...fields, revision }).success).toBe(false);
    }
  });
  it('leaves stale revision detection to the atomic service and preserves its conflict convention', () => {
    expect(updatePlanRequestSchema.parse({ revision: 1, name: 'Old client' }).revision).toBe(1);
    const conflict = new AppError('conflict', 'Reload before saving.');
    expect(conflict.status).toBe(409);
    expect(errorResponse(conflict, 'request-id').error.code).toBe('conflict');
  });
  it('supports all stored lifecycle states and preserves the recorded commitment', () => {
    for (const status of membershipStatusSchema.options) {
      expect(membershipResponseSchema.parse({ data: { ...membership, status } }).data.commitmentEndsOn).toBe('2027-10-21');
    }
    expect(membershipStatusSchema.safeParse('expired').success).toBe(false);
    expect(updateMembershipRequestSchema.safeParse({ revision: 1, commitmentEndsOn: null }).success).toBe(false);
    expect(updateMembershipRequestSchema.safeParse({ revision: 1, status: 'active' }).success).toBe(false);
  });
  it('lets staff choose proration when assigning a plan, without accepting client-derived commitments', () => {
    const request = { householdId: ids.household, memberId: ids.member, planId: ids.plan,
      startsOn: '2026-10-21', nextDueOn: '2026-11-01' };
    expect(assignMembershipRequestSchema.parse(request).firstPeriod).toBe('prorate_now');
    expect(assignMembershipRequestSchema.parse({ ...request, firstPeriod: 'next_billing_date' }).firstPeriod).toBe('next_billing_date');
    expect(assignMembershipRequestSchema.safeParse({ ...request, commitmentEndsOn: '2027-10-21' }).success).toBe(false);
    expect(updateMembershipRequestSchema.safeParse({ revision: 1, price: { amountCents: 100 } }).success).toBe(false);
  });
});

describe('invoices and tax snapshots', () => {
  it('uses UUIDs for lookups and a positive display number only after issue', () => {
    expect(billingInvoiceParamsSchema.parse({ invoiceId: ids.invoice }).invoiceId).toBe(ids.invoice);
    expect(billingInvoiceParamsSchema.safeParse({ invoiceId: '12' }).success).toBe(false);
    expect(invoiceSchema.parse({ ...invoice, status: 'draft', number: null }).number).toBeNull();
    expect(invoiceSchema.safeParse({ ...invoice, status: 'draft' }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...invoice, number: null }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...invoice, number: 0 }).success).toBe(false);
  });
  it('requires increasing cycle periods and allows a one-off without a period', () => {
    for (const periodEndsOn of [null, '2026-10-21', '2026-10-20', '2026-02-29']) {
      expect(invoiceSchema.safeParse({ ...invoice, periodEndsOn }).success).toBe(false);
    }
    expect(invoiceSchema.parse({ ...invoice, kind: 'one_off', periodStartsOn: null, periodEndsOn: null }).kind).toBe('one_off');
    // One-off failures and dunning are transition rules, not invented statuses.
    expect(invoiceSchema.safeParse({ ...invoice, status: 'requires_action' }).success).toBe(false);
    expect(invoiceSchema.parse({ ...invoice, status: 'processing' }).status).toBe('processing');
  });
  it('requires rate snapshots on tax lines and prohibits them on ordinary lines', () => {
    const tax = { ...line, kind: 'tax', description: 'QST', taxRateId: ids.tax,
      taxRateMillionths: 99_750, taxInclusive: false, amountCents: 998 };
    expect(invoiceLineItemSchema.parse(tax)).toEqual(tax);
    for (const changes of [
      { taxRateMillionths: null }, { taxInclusive: null }, { taxRateMillionths: 1_000_001 },
      { kind: 'membership' }, { quantity: 0 },
    ]) expect(invoiceLineItemSchema.safeParse({ ...tax, ...changes }).success).toBe(false);
    expect(invoiceLineItemSchema.parse({ ...line, kind: 'discount', amountCents: -500 }).amountCents).toBe(-500);
    expect(invoiceLineItemSchema.safeParse({ ...line, taxRateId: ids.tax }).success).toBe(false);
  });
  it('rejects a detail containing another invoice, household, currency, or unrelated refund', () => {
    expect(invoiceDetailResponseSchema.parse({ data: detail }).data).toEqual(detail);
    for (const changes of [{ currency: 'USD' }, { invoiceId: ids.other }, { householdId: ids.other }]) {
      expect(invoiceDetailResponseSchema.safeParse({ data: { ...detail, lineItems: [{ ...line, ...changes }] } }).success).toBe(false);
    }
    expect(invoiceDetailResponseSchema.safeParse({ data: { ...detail, payments: [{ ...payment, currency: 'USD' }] } }).success).toBe(false);
    expect(invoiceDetailResponseSchema.safeParse({ data: { ...detail, payments: [{ ...payment, invoiceId: ids.other }] } }).success).toBe(false);
    for (const changes of [{ currency: 'USD' }, { paymentId: ids.other }]) {
      expect(invoiceDetailResponseSchema.safeParse({ data: { ...detail, refunds: [{ ...refund, ...changes }] } }).success).toBe(false);
    }
  });
  it('distinguishes a charge-type one-off from a custom amount and rejects mixed inputs', () => {
    const common = { householdId: ids.household, dueOn: '2026-10-21' };
    expect(createOneOffInvoiceRequestSchema.parse({ ...common, source: 'charge_type', chargeTypeId: ids.other }).source).toBe('charge_type');
    const custom = { ...common, source: 'custom', description: 'Drop-in', ...price };
    expect(createOneOffInvoiceRequestSchema.parse(custom).source).toBe('custom');
    expect(createOneOffInvoiceRequestSchema.safeParse({ ...custom, chargeTypeId: ids.other }).success).toBe(false);
    expect(createOneOffInvoiceRequestSchema.safeParse({ ...custom, currency: undefined }).success).toBe(false);
    expect(createOneOffInvoiceRequestSchema.safeParse({ ...custom, amountCents: -1 }).success).toBe(false);
  });
});

describe('masked cards, payments, refunds, and Checkout', () => {
  it('permits at most one default per household and never a revoked default', () => {
    expect(paymentMethodListResponseSchema.parse({ data: [card], pagination: page }).data).toEqual([card]);
    expect(maskedPaymentMethodSchema.safeParse({ ...card, revokedAt: now }).success).toBe(false);
    expect(maskedPaymentMethodSchema.safeParse({ ...card, last4: '4242424242424242' }).success).toBe(false);
    expect(maskedPaymentMethodSchema.safeParse({ ...card, expiryMonth: 13 }).success).toBe(false);
    expect(paymentMethodListResponseSchema.safeParse({ data: [card, { ...card, id: ids.tax }], pagination: { ...page, total: 2 } }).success).toBe(false);
    expect(paymentMethodListResponseSchema.safeParse({ data: [card, { ...card, householdId: ids.other }], pagination: { ...page, total: 2 } }).success).toBe(true);
  });
  it.each(['processorId', 'stripeCustomerId', 'token', 'tokenHash', 'cardNumber', 'cvc'])('rejects card field %s instead of silently stripping it', (field) => {
    expect(maskedPaymentMethodSchema.safeParse({ ...card, [field]: 'secret' }).success).toBe(false);
  });
  it('records manual tender only and requires explicit positive integer cents and currency', () => {
    const request = { ...price, method: 'cash', paidAt: now };
    for (const method of ['cash', 'check', 'other']) {
      expect(recordManualPaymentRequestSchema.safeParse({ ...request, method }).success).toBe(true);
    }
    for (const changes of [{ method: 'card' }, { amountCents: 0 }, { amountCents: -1 },
      { amountCents: 1.5 }, { currency: undefined }, { paymentIntentId: 'pi_forged' }]) {
      expect(recordManualPaymentRequestSchema.safeParse({ ...request, ...changes }).success).toBe(false);
    }
    for (const amountCents of [0, -1, 1.5]) {
      expect(createRefundRequestSchema.safeParse({ ...price, amountCents }).success).toBe(false);
    }
    expect(createRefundRequestSchema.parse(price).amountCents).toBe(10_000);
    expect(refundResponseSchema.parse({ data: refund }).data).toEqual(refund);
  });
  it('omits processor secrets and raw errors from attempt diagnostics', () => {
    const attempt = { id: ids.other, createdAt: now, invoiceId: ids.invoice, ...price,
      attemptNumber: 1, status: 'requires_action', declineCode: 'authentication_required', resolvedAt: now };
    expect(paymentAttemptSchema.parse(attempt).status).toBe('requires_action');
    for (const field of ['savedPaymentMethod', 'stripeCustomerId', 'error']) {
      expect(paymentAttemptSchema.safeParse({ ...attempt, [field]: 'private' }).success).toBe(false);
    }
  });
  it('returns HTTPS Checkout links with a purpose and no client-supplied redirects or card data', () => {
    const session = { sessionId: 'cs_example', url: 'https://checkout.example/session' };
    expect(invoiceCheckoutResponseSchema.parse({ data: { ...session, mode: 'payment', invoiceId: ids.invoice, householdId: ids.household } }).data.mode).toBe('payment');
    expect(cardSetupCheckoutResponseSchema.parse({ data: { ...session, mode: 'setup', householdId: ids.household } }).data.mode).toBe('setup');
    expect(billingCheckoutResultSchema.safeParse({ ...session, url: 'http://checkout.example/session' }).success).toBe(false);
    expect(billingCheckoutResultSchema.safeParse({ ...session, url: 'javascript:alert(1)' }).success).toBe(false);
    expect(billingContracts.createInvoiceCheckout.body.safeParse({ successUrl: 'https://attacker.example' }).success).toBe(false);
    expect(cardSetupCheckoutResponseSchema.safeParse({ data: { ...session, mode: 'payment', householdId: ids.household } }).success).toBe(false);
  });
});

describe('billing query and overview contracts', () => {
  it('extends strict pagination with filters, canonical booleans and validated date ranges', () => {
    expect(billingCatalogListQuerySchema.parse({ active: 'false', limit: '10' })).toEqual({ active: false, limit: 10, offset: 0 });
    expect(billingCatalogListQuerySchema.safeParse({ active: '0' }).success).toBe(false);
    expect(billingCatalogListQuerySchema.safeParse({ gymId: ids.other }).success).toBe(false);
    expect(invoiceListQuerySchema.parse({ householdId: ids.household, status: 'paid' }).limit).toBe(50);
    expect(invoiceListQuerySchema.safeParse({ dueFrom: '2026-11-01', dueThrough: '2026-10-01' }).success).toBe(false);
    expect(invoiceListResponseSchema.parse({ data: [invoice], pagination: page }).data).toEqual([invoice]);
    expect(invoiceListResponseSchema.safeParse({ data: [invoice] }).success).toBe(false);
    expect(billingUpcomingQuerySchema.safeParse({ through: '2026-02-29' }).success).toBe(false);
  });
});

describe('billing endpoint permissions', () => {
  it('declares unique method/path pairs, validated UUID parameters and schema responses', () => {
    const endpoints: readonly BillingEndpointContract[] = Object.values(billingContracts);
    expect(new Set(endpoints.map((item) => `${item.method} ${item.path}`)).size).toBe(endpoints.length);
    for (const endpoint of endpoints) {
      expect(isRoutePermission(endpoint.permission)).toBe(true);
      expect(endpoint.response).toBeInstanceOf(z.ZodType);
      const params = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
      if (params.length) {
        expect(endpoint.params?.safeParse(Object.fromEntries(params.map((name) => [name, ids.other]))).success).toBe(true);
        expect(endpoint.params?.safeParse(Object.fromEntries(params.map((name) => [name, '42']))).success).toBe(false);
      }
    }
  });
  const managerOnly = new Set([
    'createTaxRate', 'updateTaxRate', 'createPlan', 'updatePlan', 'createChargeType', 'updateChargeType',
    'assignMembership', 'updateMembership', 'activateMembership', 'freezeMembership', 'resumeMembership',
    'cancelMembership', 'createRefund',
  ]);
  it.each(Object.entries(billingContracts))('covers allowed and denied staff roles for %s', (name, endpoint) => {
    for (const role of staffRoles) {
      expect(canStaff([role], endpoint.permission.capability)).toBe(
        role === 'owner' || role === 'admin' || (role === 'front_desk' && !managerOnly.has(name)),
      );
    }
  });
});

type Wire<Row> = { [Key in keyof Row]: Row[Key] extends Date ? string : Row[Key] extends Date | null ? string | null : Row[Key] };

describe('locked schema compatibility', () => {
  it('uses stored field names and compatible wire types, with explicit relation projections', () => {
    expectTypeOf<Omit<Plan, 'taxRateIds'>>().toExtend<Partial<Wire<typeof plans.$inferSelect>>>();
    expectTypeOf<Exclude<keyof Omit<Plan, 'taxRateIds'>, keyof typeof plans.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Omit<ChargeType, 'taxRateIds'>>().toExtend<Partial<Wire<typeof chargeTypes.$inferSelect>>>();
    expectTypeOf<Exclude<keyof Omit<ChargeType, 'taxRateIds'>, keyof typeof chargeTypes.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<TaxRate>().toExtend<Partial<Wire<typeof taxRates.$inferSelect>>>();
    expectTypeOf<Membership>().toExtend<Partial<Wire<typeof memberships.$inferSelect>>>();
    expectTypeOf<Invoice>().toExtend<Partial<Wire<typeof invoices.$inferSelect>>>();
    expectTypeOf<InvoiceLineItem>().toExtend<Partial<Wire<typeof invoiceLineItems.$inferSelect>>>();
    expectTypeOf<MaskedPaymentMethod>().toExtend<Partial<Wire<typeof paymentMethods.$inferSelect>>>();
    expectTypeOf<Payment>().toExtend<Partial<Wire<typeof payments.$inferSelect>>>();
    expectTypeOf<PaymentAttempt>().toExtend<Partial<Wire<typeof paymentAttempts.$inferSelect>>>();
    expectTypeOf<Refund>().toExtend<Partial<Wire<typeof refunds.$inferSelect>>>();
    expectTypeOf<Exclude<keyof Invoice, keyof typeof invoices.$inferSelect>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof Membership, keyof typeof memberships.$inferSelect>>().toEqualTypeOf<never>();
  });
  it('requires revisions in catalog and membership responses', () => {
    const tax = { id: ids.tax, createdAt: now, name: 'Tax', rateMillionths: 50_000, inclusive: false, active: true, revision: 1 };
    const charge = { id: ids.other, createdAt: now, name: 'Drop-in', ...price, active: true, revision: 1, taxRateIds: [] };
    for (const [schema, record] of [
      [planResponseSchema, plan], [taxRateResponseSchema, tax],
      [chargeTypeResponseSchema, charge], [membershipResponseSchema, membership],
    ] as const) {
      expect(schema.safeParse({ data: record }).success).toBe(true);
      expect(schema.safeParse({ data: { ...record, revision: undefined } }).success).toBe(false);
    }
  });
});
