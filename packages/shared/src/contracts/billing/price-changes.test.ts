// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { billingContracts } from '../billing.js';
import { applyPlanPriceChangeRequestSchema, planPriceChangeLimit, planPriceChangePreviewQuerySchema,
  planPriceChangeResultSchema } from './price-changes.js';

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const request = { requestKey: id(1), planRevision: 3, amountCents: 12_000, effectiveOn: '2028-04-15', notify: true,
  memberships: [{ id: id(2), revision: 1 }] };

describe('plan price change contracts', () => {
  it('takes the price from a canonical query integer and a calendar date', () => {
    expect(planPriceChangePreviewQuerySchema.parse({ amountCents: '12000', effectiveOn: '2028-04-15' }))
      .toEqual({ amountCents: 12_000, effectiveOn: '2028-04-15' });
    for (const amountCents of ['', '-1', '1.5', '1e3', '012', null, true])
      expect(planPriceChangePreviewQuerySchema.safeParse({ amountCents, effectiveOn: '2028-04-15' }).success, String(amountCents)).toBe(false);
    expect(planPriceChangePreviewQuerySchema.safeParse({ amountCents: '1', effectiveOn: '2028-02-30' }).success).toBe(false);
    expect(planPriceChangePreviewQuerySchema.safeParse({ amountCents: '1', effectiveOn: '2028-04-15', extra: '1' }).success).toBe(false);
  });
  it('applies 1 to 2,000 distinct memberships with a request key, the plan revision and the notice flag', () => {
    expect(applyPlanPriceChangeRequestSchema.parse(request)).toEqual(request);
    const many = Array.from({ length: planPriceChangeLimit + 1 }, (_, n) => ({ id: id(n + 10), revision: 1 }));
    expect(applyPlanPriceChangeRequestSchema.safeParse({ ...request, memberships: many.slice(0, planPriceChangeLimit) }).success).toBe(true);
    for (const changed of [{ memberships: [] }, { memberships: many }, { memberships: [request.memberships[0], request.memberships[0]] },
      { requestKey: 'key' }, { amountCents: -1 }, { amountCents: 1.5 }, { notify: undefined }, { planRevision: 0 }, { extra: true }])
      expect(applyPlanPriceChangeRequestSchema.safeParse({ ...request, ...changed }).success, JSON.stringify(changed).slice(0, 80)).toBe(false);
  });
  it('declares both routes on the plan for plans.manage', () => {
    for (const name of ['previewPlanPriceChange', 'applyPlanPriceChange'] as const) {
      expect(billingContracts[name]).toMatchObject({ path: '/api/billing/plans/{planId}/price-change',
        permission: { kind: 'staff', capability: 'plans.manage' }, successStatus: 200 });
    }
    expect(billingContracts.previewPlanPriceChange.method).toBe('get');
    expect(billingContracts.applyPlanPriceChange.method).toBe('post');
  });
  it('reports scheduled and skipped memberships with their reasons', () => {
    const result = { planId: id(1), amountCents: 12_000, effectiveOn: '2028-04-15', scheduled: [id(2)],
      skipped: [{ id: id(3), reason: 'switch_scheduled' }, { id: id(4), reason: 'changed' }], householdsNotified: 1,
      householdsWithoutAddress: 0, householdsPayerErased: 0 };
    expect(planPriceChangeResultSchema.parse(result)).toEqual(result);
    expect(planPriceChangeResultSchema.safeParse({ ...result, skipped: [{ id: id(3), reason: 'commitment' }] }).success).toBe(false);
  });
});
