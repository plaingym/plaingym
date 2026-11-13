// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { assignMembershipRequestSchema, appliedMembershipDiscountSchema, membershipSchema,
  setMembershipDiscountRequestSchema, removeMembershipDiscountRequestSchema, membershipSwitchPreviewSchema } from './memberships.js';

const id = '01900000-0000-7000-8000-000000000001';
const request = { householdId: id, memberId: id, planId: id, startsOn: '2028-03-01', nextDueOn: '2028-03-01' };
describe('membership discount contracts', () => {
  it('requires a revision for setting and removing, and one unambiguous selection for setting', () => {
    for (const discount of [{ discountId: id }, { code: 'SAVE' }]) {
      expect(setMembershipDiscountRequestSchema.parse({ revision: 1, discount })).toEqual({ revision: 1, discount });
      expect(setMembershipDiscountRequestSchema.safeParse({ discount }).success).toBe(false);
    }
    expect(setMembershipDiscountRequestSchema.safeParse({ revision: 1, discount: { discountId: id, code: 'SAVE' } }).success).toBe(false);
    expect(removeMembershipDiscountRequestSchema.parse({ revision: 1 })).toEqual({ revision: 1 });
    expect(removeMembershipDiscountRequestSchema.safeParse({}).success).toBe(false);
    expect(removeMembershipDiscountRequestSchema.safeParse({ revision: 1, discountId: id }).success).toBe(false);
  });
  it('reports only kept, ended or none in a switch preview', () => {
    for (const value of ['kept', 'ended', 'none']) expect(membershipSwitchPreviewSchema.shape.discount.parse(value)).toBe(value);
    expect(membershipSwitchPreviewSchema.shape.discount.safeParse('replaced').success).toBe(false);
  });
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
