// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { households, memberships, plans, RevisionConflictError, uuidv7 } from '@plaingym/db';
import type { ApplyPlanPriceChangeRequest } from '@plaingym/shared/contracts';
import { billingContracts } from '@plaingym/shared/contracts';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { errorHandler } from '../../core/errors.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createCatalogService } from './catalog.js';
import { createPriceChangeService, priceChanges, planPriceChangeAppliedAction, planPriceChangedAction, priceChangeScheduledAction,
  type PriceChangeOptions } from './catalog.price-change.js';
import { createCatalogRoutes } from './catalog.routes.js';
import { createDiscountCatalogService } from './discounts/catalog.js';
import { createMembershipService } from './memberships.js';
import { planSwitchedAction, switchedNow } from './memberships.plan-change.js';
import { priceNoticeJob, priceNoticePayload } from './memberships.price-notice.js';
import { useRunnerFixture, type FixtureOptions } from './runner/runner.fixture.test-helper.js';

const { db, factory, fixture } = useRunnerFixture();
/**
 * The runner fixture (a gym in Vancouver on 2028-03-01, a household billed on the 1st with a $100 monthly membership and
 * a saved card) with member email on, staff, the price change service and helpers.
 */
async function setup(options: FixtureOptions = {}, more: Partial<PriceChangeOptions> = {}) {
  const f = await fixture(options);
  await f.settings.set({ ...await f.settings.get(f.gymId), memberEmailsEnabled: true });
  await db.forGym(f.gymId, tx => tx.update(households).set({ email: 'home@example.test' }).where(eq(households.id, f.home.id)));
  const jobs = f.serviceOptions.jobs, smtp = { configured: vi.fn(async () => true) };
  const make = (extra: Partial<PriceChangeOptions> = {}) => createPriceChangeService({ ...f.serviceOptions, smtp, ...more, ...extra });
  const service = make(), lifecycle = createMembershipService(f.serviceOptions);
  const user = await factory('authUser', f.gymId);
  const staff = { gymId: f.gymId, actor: { kind: 'user' as const, userId: user.id } };
  let joined = 0;
  /** A member on the plan in a new household (or `home`), active at $100 a month and due on March 1 unless overridden. */
  async function join(overrides: Record<string, unknown> = {}, home?: { id: string }) {
    joined++;
    const household = home ?? await factory('households', f.gymId, { billingDay: 1, email: `family${joined}@example.test` });
    const member = await factory('members', f.gymId, { householdId: household.id, firstName: 'Member', lastName: `M${String(joined).padStart(2, '0')}` });
    return factory('memberships', f.gymId, { householdId: household.id, memberId: member.id, planId: f.plan.id, status: 'active',
      interval: 'monthly', amountCents: 10_000, currency: 'CAD', startsOn: '2028-01-01', nextDueOn: '2028-03-01', ...overrides });
  }
  const row = async (id: string) => (await f.read()).memberships.find(m => m.id === id)!;
  const planRow = async (id = f.plan.id) => db.forGym(f.gymId, async tx => (await tx.select().from(plans).where(eq(plans.id, id)))[0]!);
  const preview = (amountCents: number | string = 12_000, effectiveOn = '2028-04-15') =>
    service.preview(f.gymId, f.plan.id, { amountCents: String(amountCents), effectiveOn });
  async function request(ids: readonly string[], overrides: Partial<ApplyPlanPriceChangeRequest> = {}): Promise<ApplyPlanPriceChangeRequest> {
    const rows = await Promise.all(ids.map(row));
    return { requestKey: uuidv7(), planRevision: (await planRow()).revision, amountCents: 12_000, effectiveOn: '2028-04-15', notify: true,
      memberships: rows.map(item => ({ id: item.id, revision: item.revision })), ...overrides };
  }
  const apply = (input: ApplyPlanPriceChangeRequest, using = service, planId = f.plan.id) => using.apply(staff, planId, input);
  const notices = () => jobs.jobs.filter(job => job.name === priceNoticeJob);
  const audits = async (action: string) => (await f.read()).audits.filter(audit => audit.action === action);
  async function dailyOn(date: string) { f.clock.set(date + 'T17:00:00Z'); return f.runner.daily(f.gymId); }
  async function billed(id: string) {
    const state = await f.read();
    return state.lines.filter(line => line.kind === 'membership' && line.membershipId === id)
      .map(line => [state.invoices.find(invoice => invoice.id === line.invoiceId)!.dueOn, line.amountCents] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }
  return { ...f, jobs, smtp, make, service, lifecycle, user, staff, join, row, planRow, preview, request, apply, notices, audits, dailyOn, billed };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const scheduled = (amountCents = 12_000, scheduledOn = '2028-04-15') =>
  ({ scheduledAmountCents: amountCents, scheduledInterval: 'monthly', scheduledOn, scheduledOrigin: 'price_change' });
const failure = (code: string, reason?: string) => expect.objectContaining({ code, ...reason ? { details: { reason: [reason] } } : {} });
async function erasedHousehold(f: Setup) {
  const home = await factory('households', f.gymId, { billingDay: 1, email: 'gone@example.test' });
  await factory('members', f.gymId, { householdId: home.id, email: 'gone@example.test', anonymizedAt: new Date('2028-02-01T00:00:00Z') });
  return home;
}

describe('plan price change preview', () => {
  it('ticks only plain memberships, has "All" leave out commitments and custom prices, and names the skip reasons', async () => {
    const f = await setup();
    const other = await factory('plans', f.gymId, { name: 'Other', amountCents: 15_000 });
    const committed = await f.join({ commitmentEndsOn: '2028-06-01' }), endsOnDate = await f.join({ commitmentEndsOn: '2028-04-15' });
    const custom = await f.join({ amountCents: 9_000 }), frozen = await f.join({ status: 'frozen', frozenAt: new Date(), nextDueOn: '2028-04-01' });
    const trial = await f.join({ status: 'trial', trialEndsOn: '2028-03-15', nextDueOn: '2028-03-15' });
    const switching = await f.join({ scheduledPlanId: other.id, scheduledAmountCents: 15_000, scheduledInterval: 'monthly', scheduledOn: '2028-03-01' });
    const priced = await f.join({ scheduledPlanId: f.plan.id, scheduledAmountCents: 8_000, scheduledInterval: 'monthly', scheduledOn: '2028-03-01' });
    const annual = await f.join({ interval: 'annual', amountCents: 100_000 });
    await f.join({ status: 'cancelled', cancelledAt: new Date() });
    const noAddress = await f.join({}, await factory('households', f.gymId, { billingDay: 1, email: null }));
    const erased = await f.join({}, await erasedHousehold(f));
    await f.join({ planId: other.id, amountCents: 15_000, scheduledPlanId: f.plan.id, scheduledAmountCents: 10_000, scheduledInterval: 'monthly', scheduledOn: '2028-03-01' });
    const preview = await f.preview();
    const item = (id: string) => preview.memberships.find(entry => entry.id === id);
    const plain = { inCommitment: false, customPrice: false, tickedByDefault: true, includedByAll: true, skipReason: null };
    expect(item(f.membership.id)).toMatchObject({ ...plain, revision: f.membership.revision, householdId: f.home.id, scheduled: null, householdReach: 'ok' });
    expect(item(committed.id)).toMatchObject({ ...plain, commitmentEndsOn: '2028-06-01', inCommitment: true, tickedByDefault: false, includedByAll: false });
    expect(item(endsOnDate.id)).toMatchObject(plain);
    expect(item(custom.id)).toMatchObject({ ...plain, customPrice: true, tickedByDefault: false, includedByAll: false });
    expect(item(frozen.id)).toMatchObject({ ...plain, status: 'frozen', tickedByDefault: false, includedByAll: true });
    expect(item(trial.id)).toMatchObject({ ...plain, status: 'trial' });
    expect(item(switching.id)).toMatchObject({ skipReason: 'switch_scheduled', tickedByDefault: false, includedByAll: false,
      scheduled: { planId: other.id, amountCents: 15_000, interval: 'monthly', on: '2028-03-01' } });
    expect(item(priced.id)).toMatchObject({ skipReason: 'price_scheduled', tickedByDefault: false, includedByAll: false });
    expect(item(annual.id)).toMatchObject({ skipReason: 'terms', customPrice: true, tickedByDefault: false, includedByAll: false });
    expect(item(noAddress.id)).toMatchObject({ ...plain, householdReach: 'no_address' });
    expect(item(erased.id)).toMatchObject({ ...plain, householdReach: 'payer_erased' });
    expect(preview).toMatchObject({ plan: { id: f.plan.id, amountCents: 10_000, currency: 'CAD', interval: 'monthly' },
      amountCents: 12_000, effectiveOn: '2028-04-15', today: '2028-03-01', change: 'increase', total: 11,
      households: 8, householdsWithoutAddress: 1, householdsPayerErased: 1, switchesToPlan: 1, canEmail: true });
    expect(preview.memberships).toHaveLength(11);
    const names = preview.memberships.filter(entry => /^Member M\d\d$/.test(entry.memberName)).map(entry => entry.memberName);
    expect(names).toEqual([...names].sort());
    expect((await f.preview(9_000)).change).toBe('decrease');
  });
  it('says whether the gym can send member email now', async () => {
    const f = await setup();
    f.smtp.configured.mockResolvedValueOnce(false);
    expect((await f.preview()).canEmail).toBe(false);
    await f.settings.set({ ...await f.settings.get(f.gymId), memberEmailsEnabled: false });
    expect((await f.preview()).canEmail).toBe(false);
  });
  it('refuses a date before the gym-local today and a price off the currency step', async () => {
    const f = await setup();
    await expect(f.preview(12_000, '2028-02-29')).rejects.toEqual(failure('invalid_request'));
    await expect(f.preview('12.5')).rejects.toEqual(failure('invalid_request'));
    expect(await f.preview(12_000, '2028-03-01')).toMatchObject({ effectiveOn: '2028-03-01' });
    await expect(f.apply(await f.request([f.membership.id], { effectiveOn: '2028-02-29' }))).rejects.toEqual(failure('invalid_request'));
    const gymId = uuidv7();
    await factory('gyms', gymId, { currency: 'ISK', timezone: 'UTC' });
    const plan = await factory('plans', gymId, { currency: 'ISK', amountCents: 100_000 });
    const service = createPriceChangeService({ scope: db.forGym, clock: f.clock, settings: createGymSettingsAccessor({ scope: db.forGym }),
      jobs: f.jobs, smtp: f.smtp });
    await expect(service.preview(gymId, plan.id, { amountCents: '150050', effectiveOn: '2028-04-15' })).rejects.toEqual(failure('invalid_request'));
    expect(await service.preview(gymId, plan.id, { amountCents: '150000', effectiveOn: '2028-04-15' })).toMatchObject({ change: 'increase' });
    expect(await f.planRow()).toMatchObject({ amountCents: 10_000, revision: f.plan.revision });
  });
});

describe('plan price change apply', () => {
  it('leaves memberships alone when the plan is updated with a new price', async () => {
    const f = await setup();
    const before = await f.row(f.membership.id);
    await createCatalogService(f.serviceOptions).updatePlan(f.staff, f.plan.id, { revision: f.plan.revision, amountCents: 12_000 });
    expect(await f.planRow()).toMatchObject({ amountCents: 12_000 });
    expect(await f.row(f.membership.id)).toEqual(before);
    expect(f.notices()).toEqual([]);
  });
  it('changes the plan and schedules exactly the listed memberships, with one notice per household', async () => {
    const f = await setup();
    const second = await f.join(), sibling = await f.join({}, { id: second.householdId }), unlisted = await f.join();
    const untouched = await f.row(unlisted.id), plan = await f.planRow();
    const input = await f.request([f.membership.id, second.id, sibling.id]);
    const result = await f.apply(input);
    expect(result).toEqual({ planId: f.plan.id, amountCents: 12_000, effectiveOn: '2028-04-15',
      scheduled: [f.membership.id, second.id, sibling.id].sort(), skipped: [], householdsNotified: 2, householdsWithoutAddress: 0, householdsPayerErased: 0 });
    expect(await f.planRow()).toMatchObject({ amountCents: 12_000, revision: plan.revision + 1 });
    for (const id of [f.membership.id, second.id, sibling.id]) {
      expect(await f.row(id)).toMatchObject({ planId: f.plan.id, amountCents: 10_000, scheduledPlanId: f.plan.id, ...scheduled(),
        revision: input.memberships.find(item => item.id === id)!.revision + 1 });
    }
    expect(await f.row(unlisted.id)).toEqual(untouched);
    expect(await f.audits(planPriceChangedAction)).toMatchObject([{ targetId: f.plan.id, actorKind: 'user', actorUserId: f.user.id,
      before: { amountCents: 10_000 }, after: { amountCents: 12_000, request: { requestKey: input.requestKey, notify: true, count: 3 } } }]);
    const audited = await f.audits(priceChangeScheduledAction);
    expect(audited.map(audit => audit.targetId).sort()).toEqual(result.scheduled);
    expect(audited.every(audit => (audit.after as { requestKey: string }).requestKey === input.requestKey)).toBe(true);
    const notices = f.notices();
    expect(notices).toHaveLength(2);
    const byHousehold = new Map(notices.map(job => [priceNoticePayload.parse(job.payload).householdId, job]));
    expect(byHousehold.get(second.householdId)).toMatchObject({ options: { idempotencyKey: `plan-price:${input.requestKey}:${second.householdId}` },
      payload: { requestKey: input.requestKey, planId: f.plan.id, membershipIds: [second.id, sibling.id].sort(), amountCents: 12_000,
        currency: 'CAD', effectiveOn: '2028-04-15' } });
    expect(byHousehold.get(f.home.id)).toMatchObject({ payload: { membershipIds: [f.membership.id] } });
  });
  it('schedules without notices when the notice is unticked', async () => {
    const f = await setup();
    const result = await f.apply(await f.request([f.membership.id], { notify: false }));
    expect(result).toMatchObject({ scheduled: [f.membership.id], householdsNotified: 0 });
    expect(f.notices()).toEqual([]);
  });
  it('counts households without an address or with an erased payer, and still queues their notices', async () => {
    const f = await setup();
    const noAddress = await f.join({}, await factory('households', f.gymId, { billingDay: 1, email: '  ' }));
    const erased = await f.join({}, await erasedHousehold(f));
    const result = await f.apply(await f.request([f.membership.id, noAddress.id, erased.id]));
    expect(result).toMatchObject({ householdsNotified: 3, householdsWithoutAddress: 1, householdsPayerErased: 1 });
    expect(f.notices()).toHaveLength(3);
  });
  it('skips what can\'t move and what changed after the preview, leaving those memberships as they were', async () => {
    const f = await setup();
    const other = await factory('plans', f.gymId, { name: 'Other', amountCents: 15_000 });
    const switching = await f.join(), stale = await f.join(), cancelled = await f.join(), moved = await f.join();
    const annual = await f.join({ interval: 'annual', amountCents: 100_000 }), frozen = await f.join({ status: 'frozen', frozenAt: new Date() });
    const committed = await f.join({ commitmentEndsOn: '2028-12-01' }), custom = await f.join({ amountCents: 9_500 });
    await f.lifecycle.switchPlan(f.staff, { membershipId: switching.id, revision: switching.revision, requestId: uuidv7(), planId: other.id,
      timing: 'next_billing_date' });
    const input = await f.request([switching.id, stale.id, cancelled.id, moved.id, annual.id, frozen.id, committed.id, custom.id]);
    await f.lifecycle.update(f.staff, { membershipId: stale.id, revision: stale.revision, nextDueOn: '2028-03-05' });
    await f.lifecycle.cancel(f.staff, { membershipId: cancelled.id, revision: cancelled.revision });
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ planId: other.id }).where(eq(memberships.id, moved.id)));
    const before = await Promise.all([switching, stale, cancelled, moved, annual].map(item => f.row(item.id)));
    const result = await f.apply(input);
    expect(result.skipped).toEqual([{ id: switching.id, reason: 'switch_scheduled' }, { id: stale.id, reason: 'changed' },
      { id: cancelled.id, reason: 'changed' }, { id: moved.id, reason: 'changed' }, { id: annual.id, reason: 'terms' }]
      .sort((a, b) => a.id.localeCompare(b.id)));
    // Frozen, committed and custom-price memberships move when listed: the list is the owner's choice.
    expect(result.scheduled).toEqual([frozen.id, committed.id, custom.id].sort());
    expect(await Promise.all([switching, stale, cancelled, moved, annual].map(item => f.row(item.id)))).toEqual(before);
    expect(await f.row(switching.id)).toMatchObject({ scheduledPlanId: other.id, scheduledOrigin: 'switch' });
    expect(await f.row(custom.id)).toMatchObject({ amountCents: 9_500, scheduledAmountCents: 12_000 });
    // A second price change while the first is pending skips those memberships.
    const again = await f.apply(await f.request([frozen.id], { amountCents: 13_000 }));
    expect(again).toMatchObject({ scheduled: [], skipped: [{ id: frozen.id, reason: 'price_scheduled' }], householdsNotified: 0 });
    expect(await f.row(frozen.id)).toMatchObject(scheduled());
  });
  it('replays a retry with the same key, even after the listed memberships moved on', async () => {
    const f = await setup();
    const second = await f.join(), input = await f.request([f.membership.id, second.id]);
    const first = await f.apply(input);
    const current = await f.row(second.id);
    await f.lifecycle.cancel(f.staff, { membershipId: second.id, revision: current.revision });
    expect(await f.apply(input)).toEqual(first);
    expect(await f.audits(priceChangeScheduledAction)).toHaveLength(2);
    expect(await f.audits(planPriceChangedAction)).toHaveLength(1);
    expect(await f.audits(planPriceChangeAppliedAction)).toHaveLength(1);
    expect(f.notices()).toHaveLength(2);
    expect(await f.planRow()).toMatchObject({ amountCents: 12_000, revision: f.plan.revision + 1 });
  });
  it('schedules and queues once for two concurrent requests with one key', async () => {
    const f = await setup();
    const ids = [f.membership.id, ...(await Promise.all([1, 2, 3].map(() => f.join()))).map(item => item.id)];
    const input = await f.request(ids);
    const service = f.make({ chunk: { households: 1, memberships: 1 } });
    const [a, b] = await Promise.all([f.apply(input, service), f.apply(input, service)]);
    expect(a).toEqual(b);
    expect(a.scheduled).toEqual([...ids].sort());
    expect((await f.audits(priceChangeScheduledAction)).map(audit => audit.targetId).sort()).toEqual([...ids].sort());
    expect(await f.audits(planPriceChangedAction)).toHaveLength(1);
    expect(await f.audits(planPriceChangeAppliedAction)).toHaveLength(1);
    expect(f.notices()).toHaveLength(4);
  });
  it('resumes after a failed chunk, scheduling and queueing each household once', async () => {
    const f = await setup();
    const second = await f.join(), third = await f.join();
    let calls = 0;
    const scope: typeof db.forGym = (gymId, fn) => db.forGym(gymId, async tx => {
      const result = await fn(tx);
      if (++calls === 3) throw new Error('The chunk failed');
      return result;
    });
    const input = await f.request([f.membership.id, second.id, third.id]);
    // The plan's transaction, then one household per chunk: the second chunk rolls back with its notice.
    await expect(f.apply(input, f.make({ scope, chunk: { households: 1, memberships: 10 } }))).rejects.toThrow('The chunk failed');
    expect(await f.audits(priceChangeScheduledAction)).toHaveLength(1);
    expect(f.notices()).toHaveLength(1);
    expect(await f.planRow()).toMatchObject({ amountCents: 12_000 });
    const result = await f.apply(input);
    expect(result).toMatchObject({ scheduled: [f.membership.id, second.id, third.id].sort(), skipped: [], householdsNotified: 3 });
    expect((await f.audits(priceChangeScheduledAction)).map(audit => audit.targetId).sort()).toEqual(result.scheduled);
    expect(new Set(f.notices().map(job => job.options.idempotencyKey)).size).toBe(3);
    expect(f.notices()).toHaveLength(3);
    expect(await f.apply(input)).toEqual(result);
  });
  it('refuses a reused key with other parameters, also on another plan', async () => {
    const f = await setup();
    const second = await f.join(), input = await f.request([f.membership.id, second.id]);
    await f.apply(input);
    const revision = (await f.planRow()).revision;
    for (const changed of [{ amountCents: 13_000 }, { effectiveOn: '2028-04-16' }, { notify: false },
      { memberships: input.memberships.slice(0, 1) }] satisfies Partial<ApplyPlanPriceChangeRequest>[]) {
      await expect(f.apply({ ...input, planRevision: revision, ...changed })).rejects.toEqual(failure('conflict', 'request_reused'));
    }
    const other = await factory('plans', f.gymId, { name: 'Other' });
    const elsewhere = await f.join({ planId: other.id });
    await expect(f.apply({ ...input, planRevision: other.revision, memberships: [{ id: elsewhere.id, revision: elsewhere.revision }] },
      f.service, other.id)).rejects.toEqual(failure('conflict', 'request_reused'));
    expect(await f.planRow(other.id)).toMatchObject({ amountCents: other.amountCents, revision: other.revision });
    expect(await f.audits(priceChangeScheduledAction)).toHaveLength(2);
  });
  it('checks the plan revision for a new request', async () => {
    const f = await setup();
    await expect(f.apply(await f.request([f.membership.id], { planRevision: f.plan.revision + 5 }))).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await f.planRow()).toMatchObject({ amountCents: 10_000 });
    expect(await f.row(f.membership.id)).toMatchObject({ scheduledPlanId: null });
  });
});

describe('plan price change against the charge runner', () => {
  it('bills the old price before the date and the new one from the first cycle on or after it, once, through a missed run day', async () => {
    const f = await setup();
    await f.apply(await f.request([f.membership.id]));
    await f.dailyOn('2028-03-01'); await f.dailyOn('2028-04-01');
    // May 1 has no run; May 3 catches up, twice.
    await f.dailyOn('2028-05-03'); await f.dailyOn('2028-05-03'); await f.dailyOn('2028-06-01');
    expect(await f.billed(f.membership.id)).toEqual([['2028-03-01', 10_000], ['2028-04-01', 10_000], ['2028-05-01', 12_000], ['2028-06-01', 12_000]]);
    expect(await f.row(f.membership.id)).toMatchObject({ planId: f.plan.id, amountCents: 12_000, scheduledPlanId: null, scheduledOrigin: null });
    expect(await f.audits(planSwitchedAction)).toMatchObject([{ targetId: f.membership.id, after: { dueOn: '2028-05-01', scheduledOn: '2028-04-15' } }]);
  });
  it('applies an annual membership\'s change at its next anniversary', async () => {
    const f = await setup({ interval: 'annual', amount: 100_000, anniversaryOn: '2028-03-01' });
    await f.dailyOn('2028-03-01');
    await f.apply(await f.request([f.membership.id], { amountCents: 110_000 }));
    await f.dailyOn('2028-04-15');
    expect(await f.row(f.membership.id)).toMatchObject({ nextDueOn: '2029-03-01', scheduledAmountCents: 110_000, scheduledInterval: 'annual' });
    await f.dailyOn('2029-03-01');
    expect(await f.billed(f.membership.id)).toEqual([['2028-03-01', 100_000], ['2029-03-01', 110_000]]);
    expect(await f.row(f.membership.id)).toMatchObject({ interval: 'annual', amountCents: 110_000, anniversaryOn: '2028-03-01', scheduledPlanId: null });
  });
  it('takes a percentage discount off the new price', async () => {
    const f = await setup();
    const discount = await createDiscountCatalogService(f.serviceOptions).create(f.staff,
      { name: 'Ten off', currency: 'CAD', percentBasisPoints: 1_000, duration: 'forever' });
    const current = await f.row(f.membership.id);
    await f.lifecycle.setDiscount(f.staff, f.membership.id, { revision: current.revision, discount: { discountId: discount.id } });
    await f.apply(await f.request([f.membership.id]));
    await f.dailyOn('2028-03-01'); await f.dailyOn('2028-04-01'); await f.dailyOn('2028-05-01');
    const state = await f.read();
    const totals = Object.fromEntries(state.invoices.map(invoice => [invoice.dueOn, invoice.amountCents]));
    expect(totals).toMatchObject({ '2028-03-01': 9_000, '2028-04-01': 9_000, '2028-05-01': 10_800 });
  });
  it('keeps a plan price change\'s date when the due date moves earlier, and still moves a switch\'s', async () => {
    const f = await setup({ dueOn: '2028-04-01' });
    const switching = await f.join({ nextDueOn: '2028-04-01' }), legacy = await f.join({ nextDueOn: '2028-04-01' });
    await f.apply(await f.request([f.membership.id]));
    const other = await factory('plans', f.gymId, { name: 'Other', amountCents: 15_000 });
    await f.lifecycle.switchPlan(f.staff, { membershipId: switching.id, revision: switching.revision, requestId: uuidv7(),
      planId: other.id, timing: 'next_billing_date' });
    // A price-only change scheduled before the origin column was recorded follows the switch rule.
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ scheduledPlanId: f.plan.id, scheduledAmountCents: 9_000, scheduledInterval: 'monthly',
      scheduledOn: '2028-04-01' }).where(eq(memberships.id, legacy.id)));
    const move = async (id: string, nextDueOn: string) =>
      f.lifecycle.update(f.staff, { membershipId: id, revision: (await f.row(id)).revision, nextDueOn });
    expect(await move(f.membership.id, '2028-03-20')).toMatchObject({ nextDueOn: '2028-03-20', scheduledOn: '2028-04-15' });
    expect(await f.row(f.membership.id)).toMatchObject({ scheduledOrigin: 'price_change' });
    expect(await move(switching.id, '2028-03-20')).toMatchObject({ nextDueOn: '2028-03-20', scheduledPlanId: other.id, scheduledOn: '2028-03-20' });
    expect(await f.row(switching.id)).toMatchObject({ scheduledOrigin: 'switch' });
    expect(await move(legacy.id, '2028-03-20')).toMatchObject({ scheduledOn: '2028-03-20' });
    // A staff price edit replaces a plan price change, with its origin.
    expect(await f.lifecycle.update(f.staff, { membershipId: f.membership.id, revision: (await f.row(f.membership.id)).revision,
      price: { amountCents: 11_000, currency: 'CAD' } })).toMatchObject({ amountCents: 11_000, scheduledPlanId: null });
    expect(await f.row(f.membership.id)).toMatchObject({ scheduledOrigin: null });
  });
  it('marks the price a downgrade now keeps as its own origin', async () => {
    const f = await setup();
    const cheaper = await factory('plans', f.gymId, { name: 'Cheaper', amountCents: 8_000 });
    expect(switchedNow(await f.row(f.membership.id), cheaper, 'downgrade', null))
      .toMatchObject({ planId: cheaper.id, scheduledPlanId: cheaper.id, scheduledAmountCents: 8_000, scheduledOrigin: 'downgrade' });
    expect(switchedNow(await f.row(f.membership.id), { ...cheaper, amountCents: 12_000 }, 'upgrade', null))
      .toMatchObject({ scheduledPlanId: null, scheduledOrigin: null });
  });
});

describe('plan price change isolation and routes', () => {
  it('returns 404 for another gym\'s plan, and for another gym\'s membership in the list before any write', async () => {
    const f = await setup(), other = await setup();
    await expect(f.service.preview(f.gymId, other.plan.id, { amountCents: '12000', effectiveOn: '2028-04-15' })).rejects.toEqual(failure('not_found'));
    await expect(f.apply(await f.request([f.membership.id]), f.service, other.plan.id)).rejects.toEqual(failure('not_found'));
    const input = await f.request([f.membership.id]);
    input.memberships.push({ id: other.membership.id, revision: other.membership.revision });
    await expect(f.apply(input)).rejects.toEqual(failure('not_found'));
    for (const g of [f, other]) {
      expect(await g.planRow()).toMatchObject({ amountCents: 10_000, revision: g.plan.revision });
      expect(await g.row(g.membership.id)).toMatchObject({ scheduledPlanId: null });
      expect(await g.audits(planPriceChangedAction)).toEqual([]);
      expect(g.notices()).toEqual([]);
    }
  });
  function server(f: Setup, principal: Principal) {
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (ctx, next) => {
      ctx.set('context', { gym: { gymId: f.gymId, timezone: 'America/Vancouver', enabledModules: new Set() }, principal, clock: f.clock, requestId: 'price-change' });
      await next();
    });
    app.onError(errorHandler);
    createServerRegistry({ routes: createCatalogRoutes(createCatalogService(f.serviceOptions), f.service) }).mount(app, authorize, new Set());
    return app;
  }
  const staff = (f: Setup, role: string): Principal => ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role as 'owner'] });
  const path = (planId: string) => billingContracts.applyPlanPriceChange.path.replace('{planId}', planId);
  const post = (app: OpenAPIHono<RequestEnvironment>, planId: string, body: unknown) =>
    app.request(path(planId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const role of ['owner', 'admin', 'coach', 'front_desk']) {
    it(`lets ${role} ${['owner', 'admin'].includes(role) ? 'preview and apply' : 'neither preview nor apply'}`, async () => {
      const f = await setup(), app = server(f, staff(f, role)), allowed = ['owner', 'admin'].includes(role);
      const preview = await app.request(path(f.plan.id) + '?amountCents=12000&effectiveOn=2028-04-15');
      expect(preview.status, await preview.clone().text()).toBe(allowed ? 200 : 403);
      if (allowed) expect(billingContracts.previewPlanPriceChange.response.parse(await preview.json()).data.total).toBe(1);
      const applied = await post(app, f.plan.id, await f.request([f.membership.id]));
      expect(applied.status, await applied.clone().text()).toBe(allowed ? 200 : 403);
      if (allowed) expect(billingContracts.applyPlanPriceChange.response.parse(await applied.json()).data.scheduled).toEqual([f.membership.id]);
      else expect(await f.planRow()).toMatchObject({ amountCents: 10_000 });
    });
  }
  it('denies anonymous callers and answers another gym\'s plan or membership with 404', async () => {
    const f = await setup(), other = await setup();
    expect((await post(server(f, { kind: 'anonymous' }), f.plan.id, { invalid: true })).status).toBe(401);
    const app = server(f, staff(f, 'owner'));
    expect((await app.request(path(other.plan.id) + '?amountCents=12000&effectiveOn=2028-04-15')).status).toBe(404);
    expect((await post(app, other.plan.id, await f.request([f.membership.id]))).status).toBe(404);
    const input = await f.request([f.membership.id]);
    expect((await post(app, f.plan.id, { ...input, memberships: [{ id: other.membership.id, revision: 1 }] })).status).toBe(404);
  });
  it('accepts a list of 2,000 memberships and refuses a longer or repeated one', async () => {
    const f = await setup(), app = server(f, staff(f, 'owner'));
    const list = (size: number) => Array.from({ length: size }, () => ({ id: uuidv7(), revision: 1_000_000 }));
    const input = await f.request([f.membership.id]);
    const full = await post(app, f.plan.id, { ...input, memberships: list(2_000) });
    expect(full.status, await full.clone().text()).toBe(404);
    expect((await post(app, f.plan.id, { ...input, memberships: list(2_001) })).status).toBe(400);
    expect((await post(app, f.plan.id, { ...input, memberships: [...input.memberships, ...input.memberships] })).status).toBe(400);
    expect((await post(app, f.plan.id, { ...input, memberships: [] })).status).toBe(400);
  });
  it('previews without the runtime\'s jobs and SMTP, and refuses a notice it can\'t queue before any write', async () => {
    const f = await setup();
    expect(priceChanges()).toBe(priceChanges());
    const bare = createPriceChangeService({ scope: f.serviceOptions.scope, clock: f.clock, settings: f.settings });
    expect(await bare.preview(f.gymId, f.plan.id, { amountCents: '12000', effectiveOn: '2028-04-15' })).toMatchObject({ total: 1, canEmail: false });
    await expect(f.apply(await f.request([f.membership.id]), bare)).rejects.toEqual(failure('unavailable'));
    expect(await f.planRow()).toMatchObject({ amountCents: 10_000, revision: f.plan.revision });
    expect(await f.audits(planPriceChangedAction)).toEqual([]);
    expect(await f.apply(await f.request([f.membership.id], { notify: false }), bare)).toMatchObject({ scheduled: [f.membership.id] });
  });
});
