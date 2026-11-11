// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { reportRangeQuerySchema, reportsContracts, revenueReportResponseSchema } from '../reports.js';

describe('revenue report contract', () => {
  it('requires both report and billing permissions and a monthly range', () => {
    expect(reportsContracts.revenue).toMatchObject({ method: 'get', path: '/api/reports/revenue',
      permission: { kind: 'staff', capability: 'reports.read' },
      additionalPermissions: [{ kind: 'staff', capability: 'billing.read' }], query: reportRangeQuerySchema });
    expect(reportsContracts.revenue.query.parse({ from: '2026-01', to: '2026-11' })).toEqual({ from: '2026-01', to: '2026-11' });
    expect(reportsContracts.revenue.query.safeParse({ from: '2026-01', to: '2026-11', granularity: 'week' }).success).toBe(false);
  });
  it('allows signed discounts and refund-only months, rejects fractional money', () => {
    const body = { data: { from: '2026-03', to: '2026-03', timezone: 'America/New_York', currencies: [{ currency: 'JPY', buckets: [{
      startDate: '2026-03-01', endDate: '2026-04-01', startsAt: '2026-03-01T05:00:00Z', endsAt: '2026-04-01T04:00:00Z', partial: false,
      groups: [{ kind: 'discount', id: null, name: null, payments: 0, refunds: -5, net: 5 }],
      totals: { payments: 0, refunds: 31, net: -31, netBeforeTax: -28, netTax: -3 },
    }] }] } };
    expect(revenueReportResponseSchema.safeParse(body).success).toBe(true);
    body.data.currencies[0]!.buckets[0]!.totals.net = 0.5;
    expect(revenueReportResponseSchema.safeParse(body).success).toBe(false);
  });
});
