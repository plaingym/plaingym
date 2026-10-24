// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { Membership } from '@plaingym/shared/contracts';
import { householdBillingDate } from './calendar.js';

const row = (overrides: Partial<Membership>): Membership => ({ id: '019a0af0-9c00-7000-8000-000000000001', createdAt: '2028-01-01T00:00:00Z',
  memberId: '019a0af0-9c00-7000-8000-000000000002', householdId: '019a0af0-9c00-7000-8000-000000000003', planId: '019a0af0-9c00-7000-8000-000000000004',
  status: 'active', currency: 'CAD', amountCents: 100, interval: 'monthly', startsOn: '2028-01-01', nextDueOn: '2028-01-31', trialEndsOn: null,
  frozenAt: null, resumesOn: null, cancelledAt: null, commitmentEndsOn: null, revision: 1, ...overrides });

describe('household billing date', () => {
  it('starts a new or fully cancelled household on its join date', () => {
    expect(householdBillingDate('2028-01-20', [], 31)).toBe('2028-01-20');
    expect(householdBillingDate('2028-01-20', [row({ status: 'cancelled' })], 31)).toBe('2028-01-20');
  });
  it('joins the next shared monthly date on or after the start', () => {
    expect(householdBillingDate('2028-01-20', [row({ nextDueOn: '2028-01-31' }), row({ status: 'pending', nextDueOn: '2028-02-29' })], 31)).toBe('2028-01-31');
  });
  it('ignores trial and frozen dates and falls back to the clamped billing day', () => {
    const household = [row({ status: 'trial', nextDueOn: '2028-02-07' }), row({ status: 'frozen', nextDueOn: '2028-03-31' })];
    expect(householdBillingDate('2028-01-20', household, 31)).toBe('2028-01-31');
    expect(householdBillingDate('2028-02-01', household, 31)).toBe('2028-02-29');
    expect(householdBillingDate('2027-02-15', household, 31)).toBe('2027-02-28');
    expect(householdBillingDate('2028-12-31', household, 15)).toBe('2029-01-15');
  });
});
