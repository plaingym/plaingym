// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { allocateInvoiceNumber, invoices, paymentMethods } from '@plaingym/db';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { createMembershipService } from '../memberships.js';
import { createPaymentService } from '../payments.js';
import { createTransitionEffects } from '../transitions/effects.js';
import { createTransitionJobs } from '../transitions/transitions.jobs.js';
import { createChargeRunner } from './index.js';
import { assignmentInvoiceCondition, isAssignmentInvoice } from './eligibility.js';
import { setLogSink } from '../../../core/log.js';
import { createMembershipRoutes } from '../memberships.routes.js';
import { createApp } from '../../../app.js';
import { authorize } from '../../staff/auth.permissions.js';
import { useRunnerFixture } from './runner.fixture.test-helper.js';

const { db, factory, fixture, invoice, oneOff, assign } = useRunnerFixture();

describe('assignment collection and review holds', () => {
  it.each([
    ['cycle', 'cycle', ['membership'], true],
    ['assignment', 'one_off', ['membership', 'signup_fee'], true],
    ['discounted and taxed assignment', 'one_off', ['membership', 'signup_fee', 'discount', 'tax'], true],
    ['staff charge', 'one_off', ['charge'], false],
    ['mixed staff charge', 'one_off', ['membership', 'charge'], false],
    ['empty invoice', 'one_off', [], false],
  ] as const)('SQL and application assignment predicates agree for %s', async (_name, kind, kinds, expected) => {
    const f = await fixture(), bill = await invoice(f);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ kind }).where(eq(invoices.id, bill.id)));
    for (const lineKind of kinds) await factory('invoiceLineItems', f.gymId, {
      householdId: f.home.id, invoiceId: bill.id, kind: lineKind,
      ...(lineKind === 'membership' ? { membershipId: f.membership.id } : {}),
      ...(lineKind === 'tax' ? { taxRateMillionths: 50000, taxInclusive: false } : {}),
    });
    await db.forGym(f.gymId, async tx => {
      const matching = await tx.select({ id: invoices.id }).from(invoices)
        .where(and(eq(invoices.id, bill.id), assignmentInvoiceCondition(tx)));
      expect(matching.length > 0).toBe(expected);
      expect(await isAssignmentInvoice(tx, bill.id)).toBe(expected);
    });
  });
  it.each([
    ['cycle', false], ['assignment', false], ['cycle', true], ['assignment', true],
  ] as const)('keeps a released %s invoice released through daily collection (declined: %s)', async (kind, declined) => {
    const f = await fixture({ status: 'cancelled' });
    const bill = kind === 'cycle' ? await invoice(f) : await oneOff(f, 'membership');
    f.clock.set('2028-03-11T17:00:00Z');
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
    expect((await f.read()).invoices[0]).toMatchObject({ id: bill.id, needsReview: true });
    const owner = await factory('authUser', f.gymId);
    await factory('staffRoles', f.gymId, { userId: owner.id, role: 'owner' });
    const service = createPaymentService({ ...f.serviceOptions, transitions: f.transitions, runner: f.runner,
      paymentsFor: async () => f.provider });
    const create = vi.spyOn(f.provider, 'createCharge');
    await service.releaseHold({ gymId: f.gymId, actor: { kind: 'user', userId: owner.id } }, bill.id);
    expect(create).not.toHaveBeenCalled();
    if (declined) f.provider.respondNextConfirmation('declined');
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 1, errors: [] });
    f.clock.advance(86400000);
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
    const rows = await f.read();
    expect(rows.invoices[0]).toMatchObject({ id: bill.id, needsReview: false,
      status: declined ? kind === 'cycle' ? 'past_due' : 'open' : 'paid' });
    expect(rows.attempts).toHaveLength(1);
    expect(rows.attempts[0]!.status).toBe(declined ? 'failed' : 'succeeded');
    expect(rows.payments).toHaveLength(declined ? 0 : 1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(rows.audits.filter(row => row.action === 'billing.runner.overdue_held' && row.targetId === bill.id)).toHaveLength(1);
    expect(rows.audits.filter(row => row.action === 'billing.invoice.review_released' && row.targetId === bill.id)).toHaveLength(1);
    expect(rows.audits.filter(row => row.action === 'billing.invoice.dunning_started')).toHaveLength(declined && kind === 'cycle' ? 1 : 0);
  });
  it.each(['cycle', 'assignment'] as const)('keeps an unreleased %s invoice held on every daily run', async kind => {
    const f = await fixture({ status: 'cancelled' });
    const bill = kind === 'cycle' ? await invoice(f) : await oneOff(f, 'membership');
    const create = vi.spyOn(f.provider, 'createCharge');
    f.clock.set('2028-03-11T17:00:00Z');
    for (let day = 0; day < 3; day++) {
      expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
      expect((await f.read()).invoices[0]).toMatchObject({ id: bill.id, status: 'open', needsReview: true });
      f.clock.advance(86400000);
    }
    const rows = await f.read();
    expect(rows.audits.filter(row => row.action === 'billing.runner.overdue_held')).toHaveLength(1);
    expect(rows.attempts).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });
  it('collects assignment proration and sign-up fees after commit, without collecting another household', async () => {
    const f = await fixture();
    const create = vi.spyOn(f.provider, 'createCharge');
    await assign(f); expect(create).not.toHaveBeenCalled();
    const other = await fixture(); await assign(other);
    expect(await f.runner.collectAssigned(f.gymId, other.home.id)).toEqual({ attempted: 0, errors: [] });
    expect(await f.runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 2, errors: [] });
    expect((await f.read()).payments.map(row => row.amountCents).sort()).toEqual([10000, 2500]);
    expect(await f.runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 0, errors: [] });
    expect((await other.read()).payments).toHaveLength(0);
  });
  it('holds old assignment charges when a card arrives late, and lets staff collect after releasing the hold', async () => {
    const f = await fixture({ dueOn: '2028-04-01' });
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.householdId, f.home.id)));
    await assign(f);
    expect(await f.runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 0, errors: [] });
    const staffInvoice = await oneOff(f);
    f.clock.set('2028-03-11T17:00:00Z');
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.householdId, f.home.id)));
    const create = vi.spyOn(f.provider, 'createCharge');
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 0, errors: [] });
    expect(create).not.toHaveBeenCalled();
    let rows = await f.read();
    const held = rows.invoices.filter(row => row.id !== staffInvoice.id);
    expect(held).toHaveLength(2);
    expect(held.every(row => row.status === 'open' && row.needsReview)).toBe(true);
    expect(rows.invoices.find(row => row.id === staffInvoice.id)!.needsReview).toBe(false);
    await f.runner.daily(f.gymId);
    expect((await f.read()).audits.filter(row => row.action === 'billing.runner.overdue_held')).toHaveLength(2);
    const owner = await factory('authUser', f.gymId);
    await factory('staffRoles', f.gymId, { userId: owner.id, role: 'owner' });
    const context = { gymId: f.gymId, actor: { kind: 'user' as const, userId: owner.id } };
    const service = createPaymentService({ ...f.serviceOptions, transitions: f.transitions, runner: f.runner, paymentsFor: async () => f.provider });
    for (const bill of held) {
      await service.releaseHold(context, bill.id);
      await service.charge(context, bill.id);
    }
    rows = await f.read();
    expect(rows.payments).toHaveLength(2);
    expect(rows.invoices.filter(row => row.id !== staffInvoice.id).every(row => row.status === 'paid' && !row.needsReview)).toBe(true);
  });
  it.each([6, 7])('automatically collects assignment invoices %i days overdue', async days => {
    const f = await fixture({ dueOn: '2028-04-01' });
    await assign(f);
    f.clock.advance(days * 86400000);
    expect(await f.runner.daily(f.gymId)).toMatchObject({ attempted: 2, errors: [] });
    const rows = await f.read();
    expect(rows.payments).toHaveLength(2);
    expect(rows.invoices.every(row => row.status === 'paid' && !row.needsReview)).toBe(true);
  });
  it('activates a zero-value assigned membership through the normal effect job without a receipt', async () => {
    const f = await fixture(); const { membership, lifecycle } = await assign(f, 0, 0);
    const resolveProvider = vi.fn(async () => { throw new Error('No Stripe configuration'); });
    const runner = createChargeRunner({ ...f.serviceOptions, transitions: f.transitions, payments: resolveProvider });
    expect(await runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 1, errors: [] });
    const jobs = new FakeJobs(f.clock), notifications = { receipt: vi.fn(async () => {}), dunning: vi.fn(async () => {}), staffNotice: vi.fn(async () => {}) };
    const effects = createTransitionEffects({ ...f.serviceOptions, jobs, transitions: f.transitions, memberships: lifecycle,
      payments: resolveProvider, notifications, retry: runner.retry });
    for (const job of createTransitionJobs(() => effects)) jobs.handle(job.id, job.handler);
    await effects.publish(f.gymId); while (await jobs.runNext()) { /* activate membership */ }
    expect((await lifecycle.get(f.gymId, membership.id)).status).toBe('active');
    expect((await f.read()).payments).toHaveLength(0); expect((await f.read()).attempts).toHaveLength(0);
    expect(notifications.receipt).not.toHaveBeenCalled(); expect(resolveProvider).not.toHaveBeenCalled();
  });
  it('daily collects assignment invoices but leaves staff charge and mixed invoices open', async () => {
    const f = await fixture(); const staff = await oneOff(f);
    await assign(f);
    const mixedNumber = await db.forGym(f.gymId, tx => allocateInvoiceNumber(tx, f.gymId));
    const mixed = await factory('invoices', f.gymId, { householdId: f.home.id, status: 'open', number: mixedNumber, dueOn: '2028-03-01' });
    for (const kind of ['membership', 'charge']) await factory('invoiceLineItems', f.gymId,
      { householdId: f.home.id, invoiceId: mixed.id, kind, amountCents: 5000 });
    await f.runner.daily(f.gymId);
    const rows = await f.read();
    expect(rows.invoices.find(row => row.id === staff.id)!.status).toBe('open');
    expect(rows.invoices.find(row => row.id === mixed.id)!.status).toBe('open');
    expect(rows.payments).toHaveLength(2);
    expect(await f.runner.charge(f.gymId, staff.id)).toEqual({ status: 'skipped', reason: 'not_auto_collectable' });
  });
  it('keeps identifiers and safe error details while continuing other invoices', async () => {
    const f = await fixture(); await assign(f);
    vi.spyOn(f.provider, 'adoptCustomer').mockRejectedValueOnce(Object.assign(new Error('private payer@example.test params: secret'), { code: 'ECONNRESET' }));
    const logs: string[] = [], prior = setLogSink(line => logs.push(line));
    try {
      const result = await f.runner.collectAssigned(f.gymId, f.home.id);
      expect(result.errors).toEqual([{ invoiceId: expect.any(String), cause: 'unexpected' }]);
      expect(logs.map(line => JSON.parse(line) as object)).toContainEqual(expect.objectContaining({
        invoiceId: result.errors[0]!.invoiceId, error: expect.objectContaining({ name: 'Error', code: 'ECONNRESET' }),
      }));
      expect(JSON.stringify({ logs, result })).not.toMatch(/payer@example|params: secret|private/);
      expect(JSON.parse(logs[0]!)).not.toHaveProperty('message');
      expect((await f.read()).payments).toHaveLength(1);
    } finally { setLogSink(prior); }
  });
  it('logs the invoice ID when assigned collection fails after the assignment route commits', async () => {
    const f = await fixture({ dueOn: '2028-04-01' }), user = await factory('authUser', f.gymId);
    const member = await factory('members', f.gymId, { householdId: f.home.id });
    const lifecycle = createMembershipService({ ...f.serviceOptions, onAssigned: f.runner.onAssigned });
    vi.spyOn(f.provider, 'adoptCustomer').mockRejectedValueOnce(new Error('Private payer failure'));
    const app = createApp({ clock: f.clock, skipSetup: true, authorize,
      contributions: { routes: createMembershipRoutes(lifecycle, { assigned: f.runner.collectAssigned }) },
      resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: user.id, roles: ['owner'] } }); await next(); },
    });
    const logs: string[] = [], previous = setLogSink(line => logs.push(line));
    try {
      const response = await app.request('https://gym.invalid/api/billing/memberships', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ householdId: f.home.id, memberId: member.id, planId: f.plan.id, startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' }) });
      expect(response.status).toBe(201);
      const [invoice] = (await f.read()).invoices;
      expect(invoice).toBeDefined();
      expect(logs.map(line => JSON.parse(line) as object)).toContainEqual(expect.objectContaining({
        event: 'billing.collect_assigned', gymId: f.gymId, invoiceId: invoice!.id,
      }));
      expect(logs.join('\n')).not.toContain('Private payer failure');
    } finally { setLogSink(previous); }
  });
});
