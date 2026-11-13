// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { reportCsv } from './csv.js';
import { defaultRange, attendanceTable, membersTable, revenueTable } from './data.js';
import { attendanceFixture, membersFixture, revenueFixture, fixtureId } from './fixtures.js';

describe('report CSV', () => {
  it('uses a UTF-8 BOM, RFC 4180 quotes, embedded newlines and CRLF records', () => {
    expect(reportCsv({ columns: ['Name', 'Amount'], rows: [['A, "quoted"\nname', '1.00']] }))
      .toBe('\uFEFF"Name","Amount"\r\n"A, ""quoted""\nname","1.00"\r\n');
  });
  it.each(['=1+1', '+SUM(A1)', '-1+2', '-1.2.3', '-1E3', '-1e-3', '--10', '-.5', '-10.', '-10\n', '-10\r', '-10\t', '-10 ', '-cmd|/C calc', '+10', '@name', '\tformula', '\rformula'])('neutralizes a leading formula prefix in %j', cell => {
    expect(reportCsv({ columns: [cell], rows: [[cell]] })).toBe('\uFEFF"\'' + cell + '"\r\n"\'' + cell + '"\r\n');
  });
  it.each(['-10.00', '-1.20', '-10', '-0', '-0.01', '0', '1.20', '5000'])('keeps the plain number %j numeric in spreadsheets', cell => {
    expect(reportCsv({ columns: ['Amount'], rows: [[cell]] })).toBe('\uFEFF"Amount"\r\n"' + cell + '"\r\n');
  });
  it('keeps negative discount and refund nets numeric in exported revenue rows', () => {
    const value = reportCsv(revenueTable(revenueFixture.currencies[0]!));
    expect(value).toContain('"-10.00"');
    expect(value).toContain('"-1.00"');
    expect(value).not.toContain('"\'-');
  });
  it('keeps empty cells and ordinary text unchanged', () => {
    expect(reportCsv({ columns: ['Name'], rows: [[''], ['2026-10-01'], ["O'Brien"]] }))
      .toBe('\uFEFF"Name"\r\n""\r\n"2026-10-01"\r\n"O\'Brien"\r\n');
  });
});
it('defaults to twelve inclusive gym-local months across a year boundary', () => {
  expect(defaultRange('America/Los_Angeles', new Date('2026-01-01T00:30:00Z'))).toEqual({ from: '2025-01', to: '2025-12' });
  expect(defaultRange('Asia/Tokyo', new Date('2026-01-01T00:30:00Z'))).toEqual({ from: '2025-02', to: '2026-01' });
});
it('keeps zero periods in a filtered attendance table', () => {
  const table = attendanceTable(attendanceFixture, fixtureId);
  expect(table.rows).toHaveLength(2);
  expect(table.rows[1]!.slice(-2)).toEqual(['0', '0']);
});
it('marks full calendar periods using the server snapshot across all reports', () => {
  vi.useFakeTimers();
  try {
    for (const date of ['2026-09-01', '2027-01-01']) {
      vi.setSystemTime(new Date(date));
      expect(membersTable(membersFixture).rows[0]![2]).toBe('Complete');
      expect(membersTable(membersFixture).rows[1]![2]).toBe('In progress');
      expect(attendanceTable(attendanceFixture).rows.at(-1)![2]).toBe('In progress');
      expect(revenueTable(revenueFixture.currencies[0]!).rows.at(-1)![2]).toBe('In progress');
    }
  } finally { vi.useRealTimers(); }
});
it('shows both in-progress and partial markers for a clipped current week, including CSV', () => {
  const data = { ...attendanceFixture, granularity: 'week' as const, buckets: [{ ...attendanceFixture.buckets[0]!,
    startDate: '2026-11-01', endDate: '2026-11-02', startsAt: '2026-11-01T07:00:00Z', endsAt: '2026-11-02T08:00:00Z',
    inProgress: true, partial: true,
  }] };
  const table = attendanceTable(data);
  expect(table.rows[0]![2]).toBe('In progress, partial');
  expect(reportCsv(table)).toContain('"In progress, partial"');
  const upcoming = attendanceTable({ ...data, buckets: [...data.buckets, { ...data.buckets[0]!,
    startDate: '2026-11-02', endDate: '2026-11-09', inProgress: false }] });
  expect(upcoming.rows.at(-1)![2]).toBe('Upcoming, partial');
  const ended = attendanceTable({ ...data, buckets: data.buckets.map(bucket => ({ ...bucket, inProgress: false })) });
  expect(ended.rows[0]![2]).toBe('Partial');
});
