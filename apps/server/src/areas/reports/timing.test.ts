// SPDX-License-Identifier: AGPL-3.0-only
import { writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- Test-clone statistics and optional baseline-index experiment only.
import { openConnection } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import type { ReportRangeQuery } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createAttendanceReportService } from './attendance.js';
import { attendanceAggregate } from './attendance.query.js';
import { buildFullReportGym } from './full-gym.test-helper.js';
import { createMembersReportService } from './members.js';
import { membersHistory } from './members.query.js';
import { reportBuckets, type ReportContext } from './range.js';
import { createRevenueReportService } from './revenue.js';
import { readRevenue } from './revenue.query.js';
import { measureReportStatements, type ReportPlanNode } from './statements.test-helper.js';

const database = useTestDatabase(), clock = new TestClock('2026-01-15T12:00:00Z');
const range = (months: number) => ({ from: months === 1 ? '2025-12' : months === 12 ? '2025-01' : '2024-01', to: '2025-12' });
const reports = [
  { name: 'attendance', statements: 1, create: (scope: typeof database.forGym) => ({
    get: (context: ReportContext, query: ReportRangeQuery) => createAttendanceReportService(scope).get(context, { ...query, granularity: 'month' }),
  }) },
  { name: 'members', statements: 1, create: createMembersReportService },
  { name: 'revenue', statements: 4, create: createRevenueReportService },
] as const;
let gym: Awaited<ReturnType<typeof buildFullReportGym>>, neighbour: typeof gym;
const alone = new Map<string, unknown>();
const evidence: Record<string, unknown> = {};

function scans(node: ReportPlanNode): unknown[] {
  return [...(node['Relation Name'] || node['Index Name'] ? [{ node: node['Node Type'], table: node['Relation Name'], index: node['Index Name'],
    rows: node['Actual Rows'], loops: node['Actual Loops'], removed: node['Rows Removed by Filter'] ?? 0,
    hits: node['Shared Hit Blocks'], reads: node['Shared Read Blocks'] }] : []), ...(node.Plans ?? []).flatMap(scans)];
}

beforeAll(async () => {
  gym = await buildFullReportGym(database, 'USD');
  for (const report of reports) alone.set(report.name, await report.create(database.forGym).get({ ...gym, clock },
    range(24)));
  neighbour = await buildFullReportGym(database, 'JPY');
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    // Optional baseline comparison affects only this disposable clone, never the migrated template.
    if (process.env.REPORT_TIMING_WITHOUT_TIME_INDEXES === '1') {
      await maintenance.sql`drop index payments_gym_paid_at_idx`;
      await maintenance.sql`drop index refunds_gym_resolved_at_idx`;
      await maintenance.sql`drop index attendances_gym_occurred_at_idx`;
    }
    for (const table of ['households', 'members', 'memberships', 'invoices', 'invoice_line_items', 'payments', 'refunds',
      'audit_events', 'class_sessions', 'class_session_programs', 'programs', 'plans', 'tax_rates', 'attendances'])
      await maintenance.sql`analyze ${maintenance.sql(table)}`;
  } finally { await maintenance.close(); }
  evidence.fixture = { gym: gym.counts, neighbour: neighbour.counts, currencies: [gym.currency, neighbour.currency] };
  console.info('Report fixture: ' + JSON.stringify(evidence.fixture));
}, 120_000);

describe('full-gym report statement counts, time and app-role plans', () => {
  for (const report of reports) for (const months of [1, 12, 24]) it(`${report.name}: ${months} months beside another full gym`, async () => {
    const context = { ...gym, clock };
    // Warm once so measured runs compare the same cache state. EXPLAIN replays are outside the timer.
    await report.create(database.forGym).get(context, range(months));
    const measured = await measureReportStatements<unknown>(database.appUrl, scope => report.create(scope)
      .get(context, range(months)), gym.gymId);
    expect(measured.reportStatements).toHaveLength(report.statements);
    expect(measured.statements).toHaveLength(report.statements + 3); // BEGIN, gym context, COMMIT.
    expect(measured.milliseconds).toBeLessThan(15_000);
    expect(measured.plans).toHaveLength(report.statements);
    if (months === 24) expect(measured.result).toEqual(alone.get(report.name));
    const key = `${report.name}-${months}`;
    evidence[key] = { milliseconds: measured.milliseconds, plans: measured.plans };
    console.info(key + ': ' + JSON.stringify({ milliseconds: measured.milliseconds,
      plans: measured.plans.map(plan => ({ milliseconds: plan['Execution Time'], scans: scans(plan.Plan) })) }));
    // Retain complete EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) output when gathering review evidence.
    if (process.env.REPORT_TIMING_ARTIFACT) await writeFile(process.env.REPORT_TIMING_ARTIFACT, JSON.stringify(evidence, null, 2) + '\n');
  }, 60_000);
});

it('reads only the requested gym rows for a 24-month range, with known nonempty answers', async () => {
  const context = { ...gym, clock }, boundaries = reportBuckets(range(24), context);
  const history = await database.forGym(gym.gymId, tx => membersHistory(tx, gym.gymId));
  expect(history.rows).toHaveLength(300);
  expect(history.events).toHaveLength(390);
  expect(history.rows.every(row => gym.membershipIds.has(row.id) && gym.memberIds.has(row.memberId))).toBe(true);
  expect(history.events.every(event => gym.membershipIds.has(event.targetId))).toBe(true);
  const billing = await database.forGym(gym.gymId, tx => readRevenue(tx, gym.gymId,
    new Date(boundaries[0]!.startsAt), new Date(boundaries.at(-1)!.endsAt)));
  expect(billing.received).toHaveLength(gym.counts.payments);
  expect(billing.returned).toHaveLength(gym.counts.refunds);
  expect(billing.lines).toHaveLength(gym.counts.invoiceLines);
  expect(billing.markers).toHaveLength(gym.counts.payments);
  expect(billing.received.every(row => row.payment.gymId === gym.gymId && row.payment.currency === 'USD')).toBe(true);
  expect(billing.returned.every(row => row.payment.gymId === gym.gymId && row.refund.gymId === gym.gymId)).toBe(true);
  expect(billing.lines.every(row => row.line.gymId === gym.gymId)).toBe(true);
  const paymentIds = new Set(billing.received.map(row => row.payment.id));
  expect(billing.markers.every(row => paymentIds.has(row.paymentId))).toBe(true);
  const visits = await database.forGym(gym.gymId, tx => attendanceAggregate(tx, gym.gymId, boundaries));
  expect(visits.filter(row => !row.total && row.checkIns).every(row => row.programId === gym.programId)).toBe(true);
  expect(visits.filter(row => row.total).reduce((sum, row) => sum + row.checkIns, 0)).toBe(gym.counts.attendances);
  const membersReport = await createMembersReportService(database.forGym).get(context, range(24));
  expect(membersReport.data.buckets[12]).toMatchObject({ new: 270, imported: 30, activeAtEnd: 300 });
  expect(membersReport.data.buckets[17]).toMatchObject({ activeAtEnd: 300, frozenAtEnd: 30 });
  expect(membersReport.data.buckets[18]).toMatchObject({ activeAtEnd: 300, frozenAtEnd: 0 });
  expect(membersReport.data.buckets[21]).toMatchObject({ cancelled: 30, activeAtEnd: 270 });
  expect(membersReport.data.buckets[23]).toMatchObject({ activeAtEnd: 270, frozenAtEnd: 30 });
  const otherRevenue = await createRevenueReportService(database.forGym).get({ ...neighbour, clock }, range(24));
  expect(otherRevenue.data.currencies.map(row => row.currency)).toEqual(['JPY']);
}, 60_000);
