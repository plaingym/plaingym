// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { maskedPaymentMethodSchema } from './payments.js';

const active = {
  id: '019a08bf-1234-7000-8000-000000000001', createdAt: '2026-01-01T00:00:00Z', householdId: '019a08bf-1234-7000-8000-000000000002',
  type: 'card', bankName: null, brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2035, isDefault: false, revokedAt: null,
};
const revoked = { ...active, revokedAt: '2026-02-01T00:00:00Z' };

describe('a payment method removal state', () => {
  it.each([['finished'], ['pending'], [undefined]])('accepts a revoked method with removal %s', (removal) => {
    expect(maskedPaymentMethodSchema.safeParse({ ...revoked, ...(removal ? { removal } : {}) }).success).toBe(true);
  });
  it('refuses a removal state on an active method', () => {
    for (const removal of ['finished', 'pending']) expect(maskedPaymentMethodSchema.safeParse({ ...active, removal }).success).toBe(false);
    expect(maskedPaymentMethodSchema.safeParse(active).success).toBe(true);
  });
  it('refuses a state other than pending or finished', () => {
    expect(maskedPaymentMethodSchema.safeParse({ ...revoked, removal: 'failed' }).success).toBe(false);
  });
});
