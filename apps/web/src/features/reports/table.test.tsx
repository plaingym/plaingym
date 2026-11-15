// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DataTable } from './table.js';
import { attendanceTable, membersTable } from './data.js';
import { attendanceFixture, membersFixture } from './fixtures.js';
import { reportCsv } from './csv.js';

afterEach(cleanup);
it.each(['attendance', 'members'])('groups %s counts for display and preserves plain CSV numbers', kind => {
  const table = kind === 'attendance' ? attendanceTable({ ...attendanceFixture, buckets: attendanceFixture.buckets.map(bucket => ({ ...bucket,
    totals: { checkIns: 1200, uniqueMembers: 2400 } })) }) : membersTable({ ...membersFixture,
    buckets: membersFixture.buckets.map(bucket => ({ ...bucket, activeAtEnd: 1200, netChange: -2400 })) });
  render(<DataTable table={table} title="Report" filename="report.csv"/>);
  expect(screen.getAllByText('1,200').length).toBeGreaterThan(0);
  expect(screen.getAllByText(kind === 'attendance' ? '2,400' : '-2,400').length).toBeGreaterThan(0);
  const csv = reportCsv(table);
  expect(csv).toContain('"1200"');
  expect(csv).not.toContain('"1,200"');
});

it('keeps numeric text and money cells unchanged', () => {
  render(<DataTable title="Revenue" filename="revenue.csv" table={{ columns: ['Period', 'Name', 'Amount'], textColumns: [1],
    rows: [['Oct 1', '1200', '1200.00']] }}/>);
  expect(screen.getByText('1200')).toBeDefined();
  expect(screen.getByText('1200.00')).toBeDefined();
});
