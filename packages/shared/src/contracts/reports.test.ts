// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { attendanceReportQuerySchema, attendanceReportResponseSchema, reportRangeQuerySchema, reportsContracts } from './reports.js';

describe('reports contracts', () => {
  it.each([
    { from: '2025-01', to: '2026-12' }, { from: '2026-11', to: '2026-11' },
  ])('accepts an inclusive range up to 24 months: %j', query => {
    expect(reportRangeQuerySchema.parse(query)).toEqual(query);
  });
  it.each([
    { from: '2024-11', to: '2026-11' }, { from: '2026-12', to: '2026-11' },
    { from: '2026-00', to: '2026-11' }, { from: '2026-1', to: '2026-11' },
    { from: '0000-01', to: '0000-02' }, { from: '2026-01', to: '2026-13' },
    { from: '2026-01-01', to: '2026-11' },
  ])('rejects an invalid range: %j', query => {
    expect(reportRangeQuerySchema.safeParse(query).success).toBe(false);
    expect(attendanceReportQuerySchema.safeParse({ ...query, granularity: 'week' }).success).toBe(false);
  });
  it('requires explicit granularity and the reports permission', () => {
    const range = { from: '2026-01', to: '2026-11' };
    expect(attendanceReportQuerySchema.safeParse(range).success).toBe(false);
    expect(attendanceReportQuerySchema.safeParse({ ...range, granularity: 'day' }).success).toBe(false);
    expect(attendanceReportQuerySchema.parse({ ...range, granularity: 'week' }).granularity).toBe('week');
    expect(reportsContracts.attendance).toMatchObject({ method: 'get', path: '/api/reports/attendance',
      permission: { kind: 'staff', capability: 'reports.read' } });
    expect(reportsContracts.revenue).toMatchObject({ method: 'get', path: '/api/reports/revenue',
      permission: { kind: 'staff', capability: 'reports.revenue' } });
    expect(attendanceReportResponseSchema.safeParse({ data: { ...range, granularity: 'month', timezone: 'UTC', buckets: [] } }).success).toBe(true);
  });
});
