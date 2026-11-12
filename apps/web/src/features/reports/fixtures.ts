// SPDX-License-Identifier: AGPL-3.0-only
// Shared fixtures for component tests and the standalone browser check.
import type { AttendanceReportResponse, MembersReportResponse, RevenueReportResponse } from '@plaingym/shared/contracts';

export const fixtureId = '01900000-0000-7000-8000-000000000001';
const range = { from: '2026-10', to: '2026-11', timezone: 'America/Los_Angeles' };
const buckets = [
  { startDate: '2026-10-01', endDate: '2026-11-01', startsAt: '2026-10-01T07:00:00Z', endsAt: '2026-11-01T07:00:00Z', partial: false, inProgress: false },
  { startDate: '2026-11-01', endDate: '2026-12-01', startsAt: '2026-11-01T07:00:00Z', endsAt: '2026-12-01T08:00:00Z', partial: false, inProgress: true },
];
export const attendanceFixture: AttendanceReportResponse['data'] = { ...range, granularity: 'month', buckets: buckets.map((bucket, index) => ({ ...bucket,
  programs: index === 0 ? [{ programId: fixtureId, programName: '=Program, "adults"\nMonday', checkIns: 7, uniqueMembers: 3 },
    { programId: null, programName: null, checkIns: 2, uniqueMembers: 2 }] : [],
  totals: { checkIns: index === 0 ? 9 : 0, uniqueMembers: index === 0 ? 4 : 0 },
})) };
export const membersFixture: MembersReportResponse['data'] = { ...range, buckets: buckets.map((bucket, index) => ({ ...bucket,
  activeAtStart: index === 0 ? 10 : 0, new: 2, imported: 1, cancelled: 3, netChange: 0, activeAtEnd: 10, frozenAtEnd: 2,
  churn: index === 0 ? { numerator: 3, denominator: 10 } : null,
})) };
export const revenueFixture: RevenueReportResponse['data'] = { ...range, currencies: ['USD', 'JPY', 'KWD'].map(currency => ({ currency,
  buckets: buckets.map((bucket, index) => ({ ...bucket,
    groups: [
      { kind: 'plan', id: fixtureId, name: '@Plan, "adults"\nMonthly', payments: 5000, refunds: index === 0 ? 0 : 6000, net: index === 0 ? 5000 : -1000 },
      { kind: 'tax', id: fixtureId, name: 'Local tax', payments: 500, refunds: 0, net: 500 },
      { kind: 'discount', id: null, name: null, payments: -100, refunds: 0, net: -100 },
    ], totals: { payments: 5400, refunds: index === 0 ? 0 : 6000, net: index === 0 ? 5400 : -600, netBeforeTax: index === 0 ? 4900 : -1100, netTax: 500 },
  })),
})) };
