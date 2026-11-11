// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { canStaff } from '@plaingym/shared';
import { releaseInvoiceHoldContract as contract } from './invoices.js';
import { invoiceLineItemSchema, invoiceListQuerySchema } from './invoices.js';

const planId = '019a08bf-1234-7000-8000-000000000003';
const line = {
  id: '019a08bf-1234-7000-8000-000000000001', createdAt: '2026-10-21T12:00:00.000Z',
  householdId: '019a08bf-1234-7000-8000-000000000002', invoiceId: '019a08bf-1234-7000-8000-000000000004',
  membershipId: null, chargeTypeId: null, description: 'Line', amountCents: 1000, currency: 'USD', quantity: 1,
  taxRateId: null, taxRateMillionths: null, taxInclusive: null,
};

it('carries a nullable plan on membership and signup-fee lines only', () => {
  for (const kind of ['membership', 'signup_fee'] as const) {
    expect(invoiceLineItemSchema.parse({ ...line, kind, planId })).toMatchObject({ kind, planId });
    expect(invoiceLineItemSchema.parse({ ...line, kind, planId: null })).toMatchObject({ kind, planId: null });
    expect(invoiceLineItemSchema.safeParse({ ...line, kind }).success).toBe(false);
  }
  for (const kind of ['charge', 'discount'] as const) {
    expect(invoiceLineItemSchema.parse({ ...line, kind, planId: null })).toMatchObject({ kind, planId: null });
    expect(invoiceLineItemSchema.safeParse({ ...line, kind, planId }).success).toBe(false);
  }
  const tax = { ...line, kind: 'tax', taxRateMillionths: 50_000, taxInclusive: false };
  expect(invoiceLineItemSchema.parse({ ...tax, planId: null })).toMatchObject({ kind: 'tax', planId: null });
  expect(invoiceLineItemSchema.safeParse({ ...tax, planId }).success).toBe(false);
});

it('accepts only the explicit open-dispute filter', () => {
  expect(invoiceListQuerySchema.parse({ dispute: 'open' }).dispute).toBe('open');
  expect(invoiceListQuerySchema.parse({}).dispute).toBeUndefined();
  for (const dispute of ['true', 'false', true, false, 'closed', ''])
    expect(invoiceListQuerySchema.safeParse({ dispute }).success).toBe(false);
});

it('limits review confirmation to owners and admins without a payment body', () => {
  expect(contract.path).toBe('/api/billing/invoices/{invoiceId}/release-hold');
  for (const role of ['owner', 'admin', 'front_desk', 'coach'] as const)
    expect(canStaff([role], contract.permission.capability)).toBe(role === 'owner' || role === 'admin');
  expect(contract.body.parse({})).toEqual({});
  expect(contract.body.safeParse({ amountCents: 100 }).success).toBe(false);
  expect(contract.params.safeParse({ invoiceId: 'invalid' }).success).toBe(false);
});
