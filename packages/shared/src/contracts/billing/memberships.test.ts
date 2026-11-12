// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { assignMembershipRequestSchema, appliedMembershipDiscountSchema, membershipSchema } from './memberships.js';

const id = '01900000-0000-7000-8000-000000000001';
const request = { householdId: id, memberId: id, planId: id, startsOn: '2028-03-01', nextDueOn: '2028-03-01' };
describe('membership discount contracts', () => {
  it.each([undefined, { discountId: id }, { code: 'Welcome-50' }])('accepts optional selection %j', discount => {
    expect(assignMembershipRequestSchema.parse({ ...request, discount }).discount).toEqual(discount);
  });
  it.each([{}, { discountId: id, code: 'SAVE' }, { code: 'save%' }, { code: '' }, { discountId: 'unknown' }, null])(
    'rejects ambiguous or invalid selection %j', discount => {
      expect(assignMembershipRequestSchema.safeParse({ ...request, discount }).success).toBe(false);
    });
  it('never allows the public request to skip taking a use', () => {
    expect(assignMembershipRequestSchema.safeParse({ ...request, discount: { discountId: id }, discountUseTaken: true }).success).toBe(false);
  });
  it('exposes current terms and cycles left or null without catalog eligibility or history', () => {
    const snapshot = { id, discountId: id, name: 'Welcome', percentBasisPoints: 5000, amountCents: null,
      currency: 'USD', waivesSignupFee: false, duration: 'cycles', cyclesLeft: 3, planIds: [] };
    expect(appliedMembershipDiscountSchema.parse(snapshot)).toEqual(snapshot);
    expect(membershipSchema.shape.discount.parse(null)).toBeNull();
    expect(appliedMembershipDiscountSchema.safeParse({ ...snapshot, cyclesLeft: -1 }).success).toBe(false);
    expect(appliedMembershipDiscountSchema.safeParse({ ...snapshot, code: 'SAVE' }).success).toBe(false);
  });
});
