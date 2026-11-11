// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { reportCsv } from './csv.js';
import { defaultRange, attendanceTable, membersTable, revenueTable } from './data.js';
import { attendanceFixture, membersFixture, revenueFixture, fixtureId } from './fixtures.js';

describe('report CSV', () => {
  it('uses a UTF-8 BOM, RFC 4180 quotes, embedded newlines and CRLF records', () => {
    expect(reportCsv({ columns: ['Name', 'Amount'], rows: [['A, "quoted"\nname', '1.00']] }))
      .toBe('\uFEFF"Name","Amount"\r\n"A, ""quoted""\nname","1.00"\r\n');
  });
  it.each(['=1+1', '+SUM(A1)', '-1.20', '@name', '\tformula', '\rformula'])('neutralizes a leading formula prefix in %j', cell => {
    expect(reportCsv({ columns: [cell], rows: [[cell]] })).toBe('\uFEFF"\'' + cell + '"\r\n"\'' + cell + '"\r\n');
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
it('marks full calendar periods as in progress or upcoming in the gym zone across all reports', () => {
  const now = new Date('2026-10-01T00:30:00Z'); // still September in the gym
  expect(membersTable(membersFixture, now).rows[0]![2]).toBe('Upcoming');
  const october = new Date('2026-10-10T12:00:00Z');
  expect(membersTable(membersFixture, october).rows[0]![2]).toBe('In progress');
  expect(attendanceTable(attendanceFixture, 'all', october).rows[0]![2]).toBe('In progress');
  expect(revenueTable(revenueFixture.currencies[0]!, revenueFixture.timezone, october).rows[0]![2]).toBe('In progress');
});
