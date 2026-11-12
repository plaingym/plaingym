// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { invoiceLineItems, invoices, memberships, payments, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { revenueReportResponseSchema, type RevenueReportQuery } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { buildRevenueReport, createRevenueReportService } from './revenue.js';
import { createRevenueReportRoutes } from './revenue.routes.js';
import { readRevenue } from './revenue.query.js';
import { reportBuckets } from './range.js';
import { measureReportStatements } from './statements.test-helper.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-12-01T00:30:00Z');
const service = createRevenueReportService(database.forGym);
const query: RevenueReportQuery = { from: '2026-02', to: '2026-05' };
async function fixture(currency = 'USD', prefix = '') {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency, timezone: 'America/New_York' });
  const member = await factory('members', gymId);
  const plan = await factory('plans', gymId, { name: prefix + 'Monthly', active: false });
  const membership = await factory('memberships', gymId, { memberId: member.id, householdId: member.householdId, planId: plan.id });
  const tax = await factory('taxRates', gymId, { name: prefix + 'Sales tax', active: false });
  const charge = await factory('chargeTypes', gymId, { name: prefix + 'Drop-in', active: false });
  return { gymId, member, plan, membership, tax, charge, timezone: 'America/New_York', clock };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let invoiceNumber = 0;
async function invoice(f: Fixture, parts: Partial<typeof invoiceLineItems.$inferInsert>[]) {
  const row = await factory('invoices', f.gymId, { householdId: f.member.householdId,
    status: 'open', number: ++invoiceNumber,
    amountCents: parts.reduce((sum, part) => sum + part.amountCents!, 0) });
  for (const part of parts) await factory('invoiceLineItems', f.gymId, { householdId: f.member.householdId, invoiceId: row.id, ...part });
  return row;
}
async function payment(f: Fixture, invoiceId: string, amountCents: number, paidAt: string, method = 'cash') {
  return factory('payments', f.gymId, { invoiceId, amountCents, paidAt: new Date(paidAt), method });
}
async function simplePayment(f: Fixture, amount: number, paidAt: string) {
  const bill = await invoice(f, [{ kind: 'charge', amountCents: amount }]);
  return payment(f, bill.id, amount, paidAt);
}
function app(f: Fixture, roles: readonly StaffRole[] = ['owner'], principal?: Principal) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (c, next) => {
    c.set('context', { requestId: 'revenue-test', gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() }, clock,
      principal: principal ?? { kind: 'staff', gymId: f.gymId, userId: uuidv7(), roles } });
    await next();
  });
  server.onError((error, c) => c.json(errorResponse(error, 'revenue-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createRevenueReportRoutes(service) }).mount(server, authorize, new Set());
  return server;
}
const url = (input = query) => '/api/reports/revenue?' + new URLSearchParams(input);
const amounts = (payments: number, refunds = 0) => ({ payments, refunds, net: payments - refunds });

describe('revenue report with real PostgreSQL and RLS', () => {
  it('has known answers over local month boundaries, DST, later refunds, discounts, archived names and frozen months', async () => {
    const f = await fixture();
    const bill = await invoice(f, [
      { kind: 'membership', membershipId: f.membership.id, amountCents: 10000 },
      { kind: 'signup_fee', membershipId: f.membership.id, amountCents: 2000 },
      { kind: 'discount', amountCents: -2000 },
      { kind: 'tax', taxRateId: f.tax.id, amountCents: 1000, taxRateMillionths: 100000, taxInclusive: false },
    ]);
    const paid = await payment(f, bill.id, 11000, '2026-03-01T05:00:00Z');
    await simplePayment(f, 100, '2026-03-01T04:59:59.999Z');
    const typed = await invoice(f, [{ kind: 'charge', chargeTypeId: f.charge.id, amountCents: 201 }]);
    await payment(f, typed.id, 201, '2026-03-08T07:00:00Z', 'check');
    await simplePayment(f, 100, '2026-04-01T03:59:59.999Z');
    await simplePayment(f, 100, '2026-04-01T04:00:00Z');
    await factory('refunds', f.gymId, { paymentId: paid.id, amountCents: 3301, status: 'succeeded', resolvedAt: new Date('2026-04-15T12:00:00Z') });
    for (const status of ['pending', 'failed', 'canceled']) await factory('refunds', f.gymId,
      { paymentId: paid.id, amountCents: 111, status, resolvedAt: new Date('2026-04-15T12:00:00Z') });
    await database.forGym(f.gymId, tx => tx.update(memberships).set({ status: 'frozen', frozenAt: new Date('2026-05-01T04:00:00Z') })
      .where(eq(memberships.id, f.membership.id)));
    const result = revenueReportResponseSchema.parse(await service.get(f, query));
    expect(result.data.currencies).toHaveLength(1);
    const buckets = result.data.currencies[0]!.buckets;
    expect(buckets.map(bucket => bucket.totals)).toEqual([
      { ...amounts(100), netBeforeTax: 100, netTax: 0 },
      { ...amounts(11301), netBeforeTax: 10301, netTax: 1000 },
      { ...amounts(100, 3301), netBeforeTax: -2901, netTax: -300 },
      { ...amounts(0), netBeforeTax: 0, netTax: 0 },
    ]);
    expect(buckets[1]).toMatchObject({ startsAt: '2026-03-01T05:00:00.000Z', endsAt: '2026-04-01T04:00:00.000Z' });
    expect(buckets[1]!.groups).toEqual(expect.arrayContaining([
      { kind: 'plan', id: f.plan.id, name: 'Monthly', ...amounts(10000) },
      { kind: 'signup_fee', id: f.plan.id, name: 'Monthly', ...amounts(2000) },
      { kind: 'discount', id: null, name: null, ...amounts(-2000) },
      { kind: 'tax', id: f.tax.id, name: 'Sales tax', ...amounts(1000) },
      { kind: 'charge_type', id: f.charge.id, name: 'Drop-in', ...amounts(201) },
      { kind: 'other', id: null, name: null, ...amounts(100) },
    ]));
    expect(buckets[2]!.groups).toEqual(expect.arrayContaining([
      { kind: 'plan', id: f.plan.id, name: 'Monthly', ...amounts(0, 3001) },
      { kind: 'signup_fee', id: f.plan.id, name: 'Monthly', ...amounts(0, 600) },
      { kind: 'discount', id: null, name: null, ...amounts(0, -600) },
      { kind: 'tax', id: f.tax.id, name: 'Sales tax', ...amounts(0, 300) },
    ]));
    expect(buckets[3]!.groups).toEqual([]);
    // The invoice and payment predate this range but its refund still carries every allocation/name.
    const april = await service.get(f, { from: '2026-04', to: '2026-04' });
    expect(april.data.currencies[0]!.buckets[0]).toEqual(buckets[2]);
    for (const bucket of buckets) for (const field of ['payments', 'refunds', 'net'] as const)
      expect(bucket.groups.reduce((sum, group) => sum + group[field], 0)).toBe(bucket.totals[field]);
  });
  it('counts both fall DST occurrences and uses the local first of month', async () => {
    const f = await fixture();
    for (const instant of ['2026-11-01T03:59:59.999Z', '2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'])
      await simplePayment(f, 1, instant);
    const response = await service.get(f, { from: '2026-10', to: '2026-11' });
    expect(response.data.currencies[0]!.buckets.map(bucket => bucket.totals.payments)).toEqual([1, 3]);
    expect(response.data.currencies[0]!.buckets[1]).toMatchObject({ startsAt: '2026-11-01T04:00:00.000Z', endsAt: '2026-12-01T05:00:00.000Z' });
  });
  it('separates currencies, including whole-yen odd amounts, without a combined total', async () => {
    // Current schema enforces one currency per gym. Assemble two real scoped datasets to test the response's currency partition.
    const usd = await fixture(), jpy = await fixture('JPY');
    await simplePayment(usd, 101, '2026-03-04T12:00:00Z');
    await simplePayment(jpy, 7, '2026-03-04T12:00:00Z');
    const get = (f: Fixture) => database.forGym(f.gymId, tx => readRevenue(tx, f.gymId, new Date('2026-02-01Z'), new Date('2026-06-01Z')));
    const a = await get(usd), b = await get(jpy);
    const result = buildRevenueReport({ received: [...a.received, ...b.received], returned: [], lines: [...a.lines, ...b.lines], markers: [] }, reportBuckets(query, usd));
    expect(result.map(row => [row.currency, row.buckets[1]!.totals.payments])).toEqual([['JPY', 7], ['USD', 101]]);
    expect(result).toHaveLength(2);
  });
  it('uses the membership current plan for an earlier line that recorded no plan', async () => {
    const f = await fixture();
    const bill = await invoice(f, [{ kind: 'membership', membershipId: f.membership.id, amountCents: 100 }]);
    await payment(f, bill.id, 100, '2026-03-04T12:00:00Z');
    const plan = await factory('plans', f.gymId, { name: 'New plan' });
    await database.forGym(f.gymId, tx => tx.update(memberships).set({ planId: plan.id }).where(eq(memberships.id, f.membership.id)));
    expect((await service.get(f, query)).data.currencies[0]!.buckets[1]!.groups)
      .toEqual([{ kind: 'plan', id: plan.id, name: 'New plan', ...amounts(100) }]);
  });
  it('groups a class pack sale under its pack, apart from other untyped charges', async () => {
    const f = await fixture(), pack = await factory('classPacks', f.gymId, { name: 'Ten classes', currency: 'USD', active: false });
    const sold = await invoice(f, [{ kind: 'charge', description: 'Ten classes', amountCents: 150 }]);
    await factory('classPackSales', f.gymId, { invoiceId: sold.id, householdId: f.member.householdId, memberId: f.member.id, packId: pack.id });
    await payment(f, sold.id, 150, '2026-03-04T12:00:00Z');
    await simplePayment(f, 40, '2026-03-05T12:00:00Z');
    expect((await service.get(f, query)).data.currencies[0]!.buckets[1]!.groups).toEqual([
      { kind: 'class_pack', id: pack.id, name: 'Ten classes', ...amounts(150) }, { kind: 'other', id: null, name: null, ...amounts(40) }]);
  });
  it('keeps a line under the plan it recorded after the membership changes plan, beside an older line with none', async () => {
    const f = await fixture();
    const recorded = await invoice(f, [
      { kind: 'membership', membershipId: f.membership.id, planId: f.plan.id, amountCents: 100 },
      { kind: 'signup_fee', membershipId: f.membership.id, planId: f.plan.id, amountCents: 30 },
    ]);
    await payment(f, recorded.id, 130, '2026-03-04T12:00:00Z');
    const older = await invoice(f, [{ kind: 'membership', membershipId: f.membership.id, amountCents: 50 }]);
    await payment(f, older.id, 50, '2026-03-05T12:00:00Z');
    const plan = await factory('plans', f.gymId, { name: 'New plan' });
    await database.forGym(f.gymId, tx => tx.update(memberships).set({ planId: plan.id }).where(eq(memberships.id, f.membership.id)));
    const groups = (await service.get(f, query)).data.currencies[0]!.buckets[1]!.groups;
    expect(groups).toHaveLength(3);
    expect(groups).toEqual(expect.arrayContaining([
      { kind: 'plan', id: f.plan.id, name: 'Monthly', ...amounts(100) },
      { kind: 'signup_fee', id: f.plan.id, name: 'Monthly', ...amounts(30) },
      { kind: 'plan', id: plan.id, name: 'New plan', ...amounts(50) },
    ]));
  });
  it('allocates an odd partial yen receipt and later refund over the payment parts, with inclusive tax apart', async () => {
    const f = await fixture('JPY');
    const bill = await invoice(f, [
      { kind: 'membership', membershipId: f.membership.id, amountCents: 7 },
      { kind: 'signup_fee', membershipId: f.membership.id, amountCents: 3 },
      { kind: 'tax', taxRateId: f.tax.id, amountCents: 1, taxRateMillionths: 100000, taxInclusive: true },
    ]);
    const paid = await payment(f, bill.id, 7, '2026-03-04T12:00:00Z');
    await factory('refunds', f.gymId, { paymentId: paid.id, amountCents: 3, status: 'succeeded', resolvedAt: new Date('2026-04-04T12:00:00Z') });
    const buckets = (await service.get(f, query)).data.currencies[0]!.buckets;
    expect(buckets[1]!.groups).toEqual(expect.arrayContaining([
      { kind: 'plan', id: f.plan.id, name: f.plan.name, ...amounts(4) },
      { kind: 'signup_fee', id: f.plan.id, name: f.plan.name, ...amounts(2) },
      { kind: 'tax', id: f.tax.id, name: f.tax.name, ...amounts(1) },
    ]));
    expect(buckets[2]!.groups).toEqual(expect.arrayContaining([
      { kind: 'plan', id: f.plan.id, name: f.plan.name, ...amounts(0, 2) },
      { kind: 'signup_fee', id: f.plan.id, name: f.plan.name, ...amounts(0, 1) },
    ]));
    expect(buckets[2]!.totals).toEqual({ ...amounts(0, 3), netBeforeTax: -3, netTax: 0 });
  });
  it.each(['card', 'cash', 'check', 'other'])('counts %s receipts without subtracting a dispute', async method => {
    const f = await fixture(), bill = await invoice(f, [{ kind: 'charge', amountCents: 101 }]);
    await payment(f, bill.id, 101, '2026-03-04T12:00:00Z', method);
    await database.forGym(f.gymId, tx => tx.update(invoices).set({ disputeId: 'dp_' + uuidv7(), disputeStatus: 'lost' }).where(eq(invoices.id, bill.id)));
    expect((await service.get(f, query)).data.currencies[0]!.buckets[1]!.totals).toEqual({ ...amounts(101), netBeforeTax: 101, netTax: 0 });
  });
  it('uses refund resolution rather than creation time at a local month boundary', async () => {
    const f = await fixture(), paid = await simplePayment(f, 100, '2026-02-01T12:00:00Z');
    for (const [amountCents, resolvedAt] of [[11, '2026-04-01T03:59:59.999Z'], [13, '2026-04-01T04:00:00Z']] as const)
      await factory('refunds', f.gymId, { paymentId: paid.id, amountCents, status: 'succeeded', resolvedAt: new Date(resolvedAt), createdAt: new Date('2026-02-04T12:00:00Z') });
    await factory('refunds', f.gymId, { paymentId: paid.id, amountCents: 17, status: 'succeeded', resolvedAt: null });
    const buckets = (await service.get(f, query)).data.currencies[0]!.buckets;
    expect(buckets.map(bucket => bucket.totals.refunds)).toEqual([0, 11, 13, 0]);
  });
  it('puts excess receipts and real transition unaccepted duplicate card receipts in Unapplied until refunded', async () => {
    const f = await fixture(), bill = await invoice(f, [{ kind: 'charge', amountCents: 100 }]);
    const transitions = createInvoiceTransitions({ scope: database.forGym, clock });
    const context = { gymId: f.gymId, actor: { kind: 'system' as const } };
    // Current transitions require the exact invoice amount. Historical/imported excess receipts can still exist in storage.
    const excessBill = await invoice(f, [{ kind: 'charge', amountCents: 100 }]);
    await payment(f, excessBill.id, 130, '2026-03-04T12:00:00Z', 'other');
    await transitions.manualPayment(context, { invoiceId: bill.id, paymentId: uuidv7(), amountCents: 100, currency: 'USD', method: 'other', paidAt: '2026-03-04T12:00:00Z' });
    const duplicate = uuidv7();
    await transitions.cardSucceeded(context, { invoiceId: bill.id, paymentId: duplicate, amountCents: 100, currency: 'USD',
      paymentIntentId: 'pi_' + uuidv7(), chargeId: 'ch_' + uuidv7(), paidAt: '2026-03-05T12:00:00Z' });
    const march = (await service.get(f, query)).data.currencies[0]!.buckets[1]!;
    expect(march.groups).toEqual(expect.arrayContaining([
      { kind: 'other', id: null, name: null, ...amounts(200) }, { kind: 'unapplied', id: null, name: null, ...amounts(130) },
    ]));
    // The pending duplicate reservation has no effect; a successful later refund reverses only Unapplied.
    await factory('refunds', f.gymId, { paymentId: duplicate, amountCents: 100, status: 'succeeded', resolvedAt: new Date('2026-04-02T12:00:00Z') });
    const april = (await service.get(f, query)).data.currencies[0]!.buckets[2]!;
    expect(april.groups).toEqual([{ kind: 'unapplied', id: null, name: null, ...amounts(0, 100) }]);
  });
  it('never exposes gym B payments, refunds, IDs or archived names through service or HTTP', async () => {
    const a = await fixture(), b = await fixture('USD', 'FOREIGN SECRET ');
    await simplePayment(a, 7, '2026-03-04T12:00:00Z');
    const bill = await invoice(b, [{ kind: 'membership', membershipId: b.membership.id, amountCents: 999 }]);
    const paid = await payment(b, bill.id, 999, '2026-03-04T12:00:00Z');
    await factory('refunds', b.gymId, { paymentId: paid.id, amountCents: 99, status: 'succeeded', resolvedAt: new Date('2026-04-04T12:00:00Z') });
    const response = await app(a).request(url());
    expect(response.status).toBe(200);
    const body = revenueReportResponseSchema.parse(await response.json());
    expect(body.data.currencies[0]!.buckets[1]!.totals.payments).toBe(7);
    for (const secret of [b.plan.id, b.tax.id, b.charge.id, paid.id, 'FOREIGN SECRET']) expect(JSON.stringify(body)).not.toContain(secret);
    expect((await service.get(b, query)).data.currencies[0]!.buckets[2]!.totals.refunds).toBe(99);
  });
  it.each(staffRoles)('enforces both permissions for %s before query validation and disables caching', async role => {
    const f = await fixture(), response = await app(f, [role]).request(url());
    const allowed = role === 'owner' || role === 'admin';
    expect(response.status).toBe(allowed ? 200 : 403);
    expect((await app(f, [role]).request('/api/reports/revenue?from=invalid')).status).toBe(allowed ? 400 : 403);
    if (allowed) {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(revenueReportResponseSchema.parse(await response.json()).data.currencies).toEqual([]);
    }
  });
  it('denies anonymous, household, kiosk and foreign-gym staff principals', async () => {
    const f = await fixture(), userId = uuidv7();
    const principals: Principal[] = [{ kind: 'anonymous' },
      { kind: 'member', userId, scope: { gymId: f.gymId, householdId: f.member.householdId, role: 'payer' } },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }, { kind: 'staff', gymId: uuidv7(), userId, roles: ['owner'] }];
    for (const principal of principals) expect((await app(f, [], principal).request(url())).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
  });
  it('requires a manager role even when coach and front desk together grant both capabilities', async () => {
    const f = await fixture();
    expect((await app(f, ['coach', 'front_desk']).request(url())).status).toBe(403);
    expect((await app(f, ['coach', 'front_desk']).request('/api/reports/revenue?from=invalid')).status).toBe(403);
    expect((await app(f, ['coach', 'front_desk', 'admin']).request(url())).status).toBe(200);
  });
  it.each([{ from: '2024-11', to: '2026-11' }, { from: '2026-04', to: '2026-03' }, { from: '2026-12', to: '2026-12' }])('rejects invalid and future month ranges: %j', async input => {
    const f = await fixture(); expect((await app(f).request(url(input))).status).toBe(400);
  });
  it('runs exactly four report statements in one scope for empty and populated 24-month reports', async () => {
    const f = await fixture();
    const measure = (input: RevenueReportQuery) => measureReportStatements(database.appUrl, scope => createRevenueReportService(scope).get(f, input));
    const short = await measure({ from: '2026-03', to: '2026-03' });
    const bill = await invoice(f, [{ kind: 'charge', amountCents: 7 }]);
    await database.forGym(f.gymId, tx => tx.insert(payments).values(Array.from({ length: 150 }, () => ({
      gymId: f.gymId, invoiceId: bill.id, amountCents: 7, currency: 'USD', method: 'cash', paidAt: new Date('2026-03-04T12:00:00Z'),
    }))));
    const long = await measure({ from: '2024-12', to: '2026-11' });
    expect(short.reportStatements).toHaveLength(4); expect(long.reportStatements).toHaveLength(4);
    expect(short.statements).toHaveLength(7); expect(long.statements).toHaveLength(7);
    expect(long.result.data.currencies[0]!.buckets.reduce((sum, bucket) => sum + bucket.totals.payments, 0)).toBe(1050);
  });
});
