// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { canStaff } from '@plaingym/shared';
import { releaseInvoiceHoldContract as contract } from './invoices.js';
import { invoiceListQuerySchema } from './invoices.js';

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
