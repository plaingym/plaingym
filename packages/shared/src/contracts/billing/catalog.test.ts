// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createDiscountRequestSchema, updateDiscountRequestSchema, discountContracts, discountSchema } from './catalog.js';

const base = { name: 'Family', currency: 'USD', percentBasisPoints: 1000, duration: 'forever' as const };
describe('discount catalog contracts', () => {
  it.each([
    { percentBasisPoints: 1, duration: 'once' }, { percentBasisPoints: 10_000 },
    { percentBasisPoints: null, amountCents: 500, duration: 'cycles', cycles: 2 },
    { percentBasisPoints: null, duration: null, waivesSignupFee: true },
  ])('accepts supported terms %j', terms => {
    expect(createDiscountRequestSchema.safeParse({ ...base, ...terms }).success).toBe(true);
  });
  it.each([
    { percentBasisPoints: 0 }, { percentBasisPoints: 10_001 }, { percentBasisPoints: 1.5 },
    { amountCents: 500 }, { percentBasisPoints: null, amountCents: 0 },
    { percentBasisPoints: null, duration: null }, { duration: null },
    { percentBasisPoints: null, waivesSignupFee: true },
    { duration: 'cycles' }, { duration: 'cycles', cycles: 0 }, { cycles: 1 },
    { code: 'a' }, { code: 'a_b' }, { code: 'x'.repeat(41) }, { name: ' ' }, { name: 'x'.repeat(101) },
    { maxUses: 0 }, { endsOn: '2026-02-30' }, { uses: 1 },
    { planIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'] },
  ])('rejects invalid terms %j', terms => {
    expect(createDiscountRequestSchema.safeParse({ ...base, ...terms }).success).toBe(false);
  });
  it('keeps codes case-insensitive at storage, trims names, and validates the currency charge step', () => {
    expect(createDiscountRequestSchema.parse({ ...base, name: ' Family ', code: 'FAM-01' })).toMatchObject({ name: 'Family', code: 'FAM-01' });
    expect(createDiscountRequestSchema.safeParse({ ...base, percentBasisPoints: null, amountCents: 101, currency: 'ISK' }).success).toBe(false);
    expect(updateDiscountRequestSchema.safeParse({ revision: 1, amountCents: 101, currency: 'ISK' }).success).toBe(false);
  });
  it('requires revisions and changes, keeps counters server-owned, and validates response uses', () => {
    expect(updateDiscountRequestSchema.safeParse({ name: 'Other' }).success).toBe(false);
    expect(updateDiscountRequestSchema.safeParse({ revision: 1 }).success).toBe(false);
    expect(updateDiscountRequestSchema.safeParse({ revision: 1, uses: 2 }).success).toBe(false);
    expect(updateDiscountRequestSchema.parse({ revision: 1, code: null })).toEqual({ revision: 1, code: null });
    const fields = createDiscountRequestSchema.parse(base);
    expect(discountSchema.safeParse({ ...fields, id: '00000000-0000-4000-8000-000000000001',
      createdAt: '2026-11-12T12:00:00Z', revision: 1, uses: 3, termsLocked: true, maxUses: 2 }).success).toBe(false);
  });
  it('requires a boolean history flag in responses and refuses it in writes', () => {
    const response = { ...createDiscountRequestSchema.parse(base), id: '00000000-0000-4000-8000-000000000001',
      createdAt: '2026-11-12T12:00:00Z', revision: 1, uses: 0 };
    expect(discountSchema.safeParse(response).success).toBe(false);
    for (const termsLocked of [true, false]) {
      expect(discountSchema.parse({ ...response, termsLocked }).termsLocked).toBe(termsLocked);
      expect(createDiscountRequestSchema.safeParse({ ...base, termsLocked }).success).toBe(false);
      expect(updateDiscountRequestSchema.safeParse({ revision: 1, name: 'Renamed', termsLocked }).success).toBe(false);
    }
    expect(discountSchema.safeParse({ ...response, termsLocked: 'true' }).success).toBe(false);
  });
  it('protects all four endpoints with plans.manage', () => {
    for (const contract of Object.values(discountContracts)) expect(contract.permission).toEqual({ kind: 'staff', capability: 'plans.manage' });
  });
});
