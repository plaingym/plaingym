// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { attendanceTable } from './data.js';
import { attendanceFixture, fixtureId } from './fixtures.js';

const second = '01900000-0000-7000-8000-000000000002';
const data = { ...attendanceFixture, buckets: attendanceFixture.buckets.map((bucket, index) => index === 1 ? bucket : ({ ...bucket,
  programs: [...bucket.programs.slice(0, 1), { programId: second, programName: 'Kids', checkIns: 5, uniqueMembers: 4 }, ...bucket.programs.slice(1)],
  totals: { checkIns: 14, uniqueMembers: 8 } })) };
// Start date, end date, program name and the two counts; the period status is not under test here.
const cells = (row: string[]) => [row[0], row[1], row[3], row[4], row[5]];

it('builds a row for the total and each program, in the count column order', () => {
  const table = attendanceTable(data);
  expect(table.rows.map(cells)).toEqual([
    ['2026-10-01', '2026-11-01', 'All programs', '14', '8'],
    ['2026-10-01', '2026-11-01', '=Program, "adults"\nMonday', '7', '3'],
    ['2026-10-01', '2026-11-01', 'Kids', '5', '4'],
    ['2026-10-01', '2026-11-01', 'No program', '2', '2'],
    ['2026-11-01', '2026-12-01', 'All programs', '0', '0'],
  ]);
  expect(table.rows.every(row => row.length === table.columns.length)).toBe(true);
  expect(table.countColumns).toEqual([4, 5]);
});
it('builds one row per period for a selected program, with zeros where it has no counts', () => {
  expect(attendanceTable(data, fixtureId).rows.map(cells)).toEqual([
    ['2026-10-01', '2026-11-01', '=Program, "adults"\nMonday', '7', '3'],
    ['2026-11-01', '2026-12-01', '=Program, "adults"\nMonday', '0', '0'],
  ]);
  expect(attendanceTable(data, 'unassigned').rows.map(cells)).toEqual([
    ['2026-10-01', '2026-11-01', 'No program', '2', '2'],
    ['2026-11-01', '2026-12-01', 'No program', '0', '0'],
  ]);
});
