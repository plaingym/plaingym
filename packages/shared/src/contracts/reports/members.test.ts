// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { membersReportQuerySchema, membersReportResponseSchema, reportsContracts } from '../reports.js';

describe('members report contract', () => {
  it('reuses the inclusive 24-month range and accepts months only', () => {
    expect(membersReportQuerySchema.parse({ from: '2025-01', to: '2026-12' })).toEqual({ from: '2025-01', to: '2026-12' });
    for (const query of [{ from: '2024-12', to: '2026-12' }, { from: '2026-02', to: '2026-01' },
      { from: '2026-00', to: '2026-12' }, { from: '2026-01', to: '2026-12', granularity: 'week' }])
      expect(membersReportQuerySchema.safeParse(query).success).toBe(false);
    expect(reportsContracts.members).toMatchObject({ method: 'get', path: '/api/reports/members',
      permission: { kind: 'staff', capability: 'reports.read' }, additionalPermissions: [{ kind: 'staff', capability: 'billing.read' }] });
  });
  it('requires integer counts and a positive churn denominator or null', () => {
    const bucket = { startDate: '2026-03-01', endDate: '2026-04-01', startsAt: '2026-03-01T05:00:00Z',
      endsAt: '2026-04-01T04:00:00Z', partial: false, activeAtStart: 3, new: 0, imported: 0, cancelled: 1,
      netChange: -1, activeAtEnd: 2, frozenAtEnd: 1, churn: { numerator: 1, denominator: 3 } };
    const response = (changes = {}) => ({ data: { from: '2026-03', to: '2026-03', timezone: 'America/New_York', buckets: [{ ...bucket, ...changes }] } });
    expect(membersReportResponseSchema.safeParse(response()).success).toBe(true);
    expect(membersReportResponseSchema.safeParse(response({ churn: null })).success).toBe(true);
    for (const changes of [{ new: -1 }, { activeAtStart: 1.5 }, { churn: { numerator: 1, denominator: 0 } },
      { churn: { numerator: 0.1, denominator: 3 } }])
      expect(membersReportResponseSchema.safeParse(response(changes)).success).toBe(false);
  });
});
