// SPDX-License-Identifier: AGPL-3.0-only
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, lt } from 'drizzle-orm';
import { payments, refunds } from '@plaingym/db';
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
function nodes(node: ReportPlanNode): ReportPlanNode[] { return [node, ...(node.Plans ?? []).flatMap(nodes)]; }

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

afterAll(async () => {
  if (process.env.REPORT_TIMING_ARTIFACT) await writeFile(process.env.REPORT_TIMING_ARTIFACT, JSON.stringify(evidence, null, 2) + '\n');
});

describe('full-gym report statement counts, time and app-role plans', () => {
  for (const report of reports) for (const months of [1, 12, 24]) it(`${report.name}: ${months} months beside another full gym`, async () => {
    const context = { ...gym, clock };
    // Warm database buffers; the measured connection initializes separately. EXPLAIN is outside the timer.
    await report.create(database.forGym).get(context, range(months));
    const measured = await measureReportStatements<unknown>(database.appUrl, scope => report.create(scope)
      .get(context, range(months)), Boolean(process.env.REPORT_TIMING_ARTIFACT));
    expect(measured.reportStatements).toHaveLength(report.statements);
    expect(measured.statements).toHaveLength(report.statements + 3); // BEGIN, gym context, COMMIT.
    expect(measured.milliseconds).toBeLessThan(15_000);
    if (process.env.REPORT_TIMING_ARTIFACT) expect(measured.plans).toHaveLength(report.statements);
    expect(Math.max(...measured.parameterCounts)).toBeLessThan(100);
    if (months === 24) expect(measured.result).toEqual(alone.get(report.name));
    const key = `${report.name}-${months}`;
    evidence[key] = { milliseconds: measured.milliseconds, plans: measured.plans };
    console.info(key + ': ' + JSON.stringify({ milliseconds: measured.milliseconds,
      plans: measured.plans.map(plan => ({ milliseconds: plan['Execution Time'], scans: scans(plan.Plan) })) }));
  }, 60_000);
});

it('assigns 24 months of weekly visits once before joining the empty bucket list', async () => {
  const measured = await measureReportStatements(database.appUrl, scope => createAttendanceReportService(scope).get({ ...gym, clock },
    { ...range(24), granularity: 'week' }), true);
  const planNodes = measured.plans.flatMap(plan => nodes(plan.Plan));
  const bucketJoin = planNodes.find(node => /bucket/.test(node['Hash Cond'] ?? node['Merge Cond'] ?? ''));
  expect(bucketJoin).toBeDefined();
  expect(planNodes.some(node => /occurred_at/.test(node['Join Filter'] ?? ''))).toBe(false);
  expect(measured.reportStatements[0]).toContain('width_bucket');
  evidence.weeklyAttendancePlan = measured.plans;
  console.info('Weekly attendance bucket join: ' + JSON.stringify({ type: bucketJoin?.['Node Type'],
    condition: bucketJoin?.['Hash Cond'] ?? bucketJoin?.['Merge Cond'], scans: measured.plans.flatMap(plan => scans(plan.Plan)) }));
}, 60_000);

it('uses revenue time indexes for a selective month and reuses touched IDs without rescanning payment history', async () => {
  // A tiny refund table legitimately prefers a sequential scan. Give this independent gym
  // enough old refunds to make the selective history lookup matter, without changing known answers.
  const planGym = await buildFullReportGym(database, 'USD');
  await database.forGym(planGym.gymId, async tx => {
    const [oldPayment] = await tx.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.gymId, planGym.gymId), lt(payments.paidAt, new Date('2025-02-01T00:00:00Z')))).limit(1);
    await tx.insert(refunds).values(Array.from({ length: 5000 }, () => ({ gymId: planGym.gymId, paymentId: oldPayment!.id,
      amountCents: 1, currency: 'USD', status: 'succeeded', resolvedAt: new Date('2025-02-15T12:00:00Z') })));
  });
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    for (const table of ['payments', 'refunds', 'invoices', 'audit_events']) await maintenance.sql`analyze ${maintenance.sql(table)}`;
  } finally { await maintenance.close(); }
  const measured = await measureReportStatements(database.appUrl, scope => createRevenueReportService(scope).get({ ...planGym, clock }, range(1)), true);
  const received = nodes(measured.plans[0]!.Plan), returned = nodes(measured.plans[1]!.Plan);
  evidence.selectiveRevenuePlans = measured.plans;
  console.info('Selective revenue plans: ' + JSON.stringify(measured.plans.map(plan => ({ scans: scans(plan.Plan) }))));
  // These assertions intentionally require range bounds in Index Cond, not merely an index's name.
  // A gym-only index scan with a range filter would read all of that gym's history again.
  if (process.env.REPORT_TIMING_WITHOUT_TIME_INDEXES !== '1') {
    const paymentRange = received.find(node => node['Index Name'] === 'payments_gym_paid_at_idx');
    expect(paymentRange?.['Index Cond']).toMatch(/paid_at >=/);
    expect(paymentRange?.['Index Cond']).toMatch(/paid_at </);
    const refundRange = returned.find(node => node['Index Name'] === 'refunds_gym_resolved_at_idx');
    expect(refundRange?.['Index Cond']).toMatch(/resolved_at >=/);
    expect(refundRange?.['Index Cond']).toMatch(/resolved_at </);
  }
  const refundHistory = returned.find(node => node['Index Name'] === 'refunds_payment_idx');
  expect(refundHistory?.['Index Cond']).toMatch(/payment_id = ANY/);
  expect(measured.plans.slice(2).flatMap(plan => nodes(plan.Plan))
    .some(node => node['Relation Name'] === 'payments' || node['Relation Name'] === 'refunds')).toBe(false);
  expect(measured.reportStatements).toHaveLength(4);
  expect(Math.max(...measured.parameterCounts)).toBeLessThan(100);
}, 60_000);

it('reads only the requested gym rows for a 24-month range, with known nonempty answers', async () => {
  const context = { ...gym, clock }, boundaries = reportBuckets(range(24), context);
  const history = await database.forGym(gym.gymId, tx => membersHistory(tx, gym.gymId, new Date(boundaries[0]!.startsAt)));
  const december = await database.forGym(gym.gymId, tx => membersHistory(tx, gym.gymId, new Date('2025-12-01T05:00:00Z')));
  expect(december.rows).toHaveLength(270);
  console.info('Members history after projection: ' + JSON.stringify({ fullRangeBytes: Buffer.byteLength(JSON.stringify(history)),
    decemberRows: december.rows.length, decemberEvents: december.events.length, decemberBytes: Buffer.byteLength(JSON.stringify(december)) }));
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
