// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { membershipDiscounts, plans, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { membershipResponseSchema, type CreateDiscountRequest } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';
import type { AssignMembership } from '../../../core/interfaces/membership-lifecycle.js';
import { createApp } from '../../../app.js';
import { authorize } from '../../staff/auth.permissions.js';
import { createMembershipRoutes } from '../memberships.routes.js';
import { createDiscountCatalogService } from '../discounts/catalog.js';
import { generateCycle } from '../runner/store.js';
import { clearJobs, origin, workflowFixture, type Workflow } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));
async function fixture(terms: Partial<CreateDiscountRequest> = {}) {
  const f = await workflowFixture(db, { empty: true });
  const catalog = createDiscountCatalogService(f.common);
  const discount = await catalog.create(f.context, { name: 'Welcome', currency: 'USD', percentBasisPoints: 5000,
    duration: 'cycles', cycles: 3, ...terms });
  const applications = () => db.forGym(f.gymId, tx => tx.select().from(membershipDiscounts));
  return { ...f, catalog, discount, applications };
}
function assignment(f: Awaited<ReturnType<typeof fixture>>, changes: Partial<AssignMembership> = {}): AssignMembership {
  return { id: uuidv7(), householdId: f.home.id, memberId: f.member.id, planId: f.plan.id,
    startsOn: '2028-03-01', nextDueOn: '2028-03-01', firstPeriod: 'next_billing_date', initialStatus: 'active',
    discount: { discountId: f.discount.id }, ...changes };
}
async function bill(f: Workflow, date: string) {
  f.clock.set(date + 'T17:00:00Z'); await f.runJob('billing.runner.daily'); await f.runJob('billing.runner.daily');
}
function staffApp(f: Workflow, role: StaffRole) {
  return createApp({ clock: f.clock, authorize, skipSetup: true,
    contributions: { routes: createMembershipRoutes(f.lifecycle, { assigned: f.runner.collectAssigned }) },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] } }); await next(); } });
}
function assignRequest(app: ReturnType<typeof staffApp>, f: Workflow, discount: object) {
  return app.request(origin + '/api/billing/memberships', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ householdId: f.home.id, memberId: f.member.id, planId: f.plan.id,
      startsOn: '2028-03-01', nextDueOn: '2028-03-01', discount }) });
}
describe('discounted assignment and recurring billing', () => {
  it.each([
    ['once', null, [5000, 10000, 10000, 10000]],
    ['cycles', 3, [5000, 5000, 5000, 10000]],
    ['forever', null, [5000, 5000, 5000, 5000]],
  ] as const)('%s applies to the right full cycles and replays consume none', async (duration, cycles, amounts) => {
    const f = await fixture({ duration, cycles });
    const request = assignment(f), assigned = await f.lifecycle.assign(f.context, request);
    await f.lifecycle.assign(f.context, request);
    for (const date of ['2028-03-01', '2028-04-01', '2028-05-01', '2028-06-01']) await bill(f, date);
    const state = await f.read();
    expect(state.invoices.map(row => row.amountCents)).toEqual(amounts);
    expect(state.invoices.every(row => row.status === 'paid')).toBe(true);
    expect(state.attempts).toHaveLength(4);
    expect((await f.catalog.get(f.gymId, f.discount.id)).uses).toBe(1);
    expect((await f.applications())[0]).toMatchObject(duration === 'forever'
      ? { cyclesLeft: null, endedAt: null } : { cyclesLeft: 0, endReason: 'completed' });
    expect((await f.lifecycle.get(f.gymId, assigned.id)).discount).toEqual(duration === 'forever' ? assigned.discount : null);
    expect(state.audits.filter(row => row.action === 'billing.membership.discount_cycle_taken')).toHaveLength(duration === 'once' ? 1 : duration === 'cycles' ? 3 : 0);
  });

  it('keeps fixed snapshot terms and eligible plans after the catalog is edited', async () => {
    const f = await fixture({ percentBasisPoints: null, amountCents: 2500 });
    const assigned = await f.lifecycle.assign(f.context, assignment(f));
    const current = await f.catalog.get(f.gymId, f.discount.id), another = await f.factory('plans', f.gymId);
    await f.catalog.update(f.context, f.discount.id, { revision: current.revision, name: 'Changed', code: 'CHANGED',
      active: false, endsOn: '2028-02-29', planIds: [another.id] });
    for (const date of ['2028-03-01', '2028-04-01', '2028-05-01', '2028-06-01']) await bill(f, date);
    expect((await f.read()).invoices.map(row => row.amountCents)).toEqual([7500, 7500, 7500, 10000]);
    expect((await f.applications())[0]).toMatchObject({ name: 'Welcome', amountCents: 2500, planIds: [] });
    expect((await f.read()).lines.filter(row => row.kind === 'discount').every(row => row.description === assigned.discount!.name)).toBe(true);
  });

  it('discounts an off-day trial-end stub without taking a cycle, then bills three full cycles and full price', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(plans).set({ trialDays: 10, amountCents: 6200 }).where(eq(plans.id, f.plan.id)));
    const assigned = await f.lifecycle.assign(f.context, assignment(f, { initialStatus: 'trial' }));
    await bill(f, '2028-03-01'); expect((await f.read()).invoices).toHaveLength(0);
    expect((await f.applications())[0]!.cyclesLeft).toBe(3);
    f.clock.set('2028-03-11T17:00:00Z');
    await f.lifecycle.activate(f.context, { membershipId: assigned.id, revision: assigned.revision });
    await bill(f, '2028-03-11');
    expect((await f.read()).invoices.map(row => row.amountCents)).toEqual([2100]);
    expect((await f.applications())[0]!.cyclesLeft).toBe(3);
    for (const date of ['2028-04-01', '2028-05-01', '2028-06-01', '2028-07-01']) await bill(f, date);
    expect((await f.read()).invoices.map(row => row.amountCents)).toEqual([2100, 3100, 3100, 3100, 6200]);
  });

  it('discounts a prorated first period without taking a once cycle', async () => {
    const f = await fixture({ duration: 'once', cycles: null });
    await db.forGym(f.gymId, tx => tx.update(plans).set({ amountCents: 6200 }).where(eq(plans.id, f.plan.id)));
    f.clock.set('2028-03-16T17:00:00Z');
    await f.lifecycle.assign(f.context, assignment(f, { startsOn: '2028-03-16', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' }));
    await f.runner.collectAssigned(f.gymId, f.home.id); await f.drain();
    expect((await f.read()).invoices.map(row => row.amountCents)).toEqual([1600]);
    expect((await f.applications())[0]!.cyclesLeft).toBe(1);
    for (const date of ['2028-04-01', '2028-05-01', '2028-06-01', '2028-07-01']) await bill(f, date);
    expect((await f.read()).invoices.map(row => row.amountCents)).toEqual([1600, 3100, 6200, 6200, 6200]);
  });

  it('takes the once cycle on a first period that bills a full cycle', async () => {
    const f = await fixture({ duration: 'once', cycles: null });
    const assigned = await f.lifecycle.assign(f.context, assignment(f, { startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' }));
    expect(assigned.discount).toBeNull();
    expect((await f.applications())[0]).toMatchObject({ cyclesLeft: 0, endReason: 'completed' });
    await f.runner.collectAssigned(f.gymId, f.home.id); await f.drain();
    for (const date of ['2028-04-01', '2028-05-01']) await bill(f, date);
    expect((await f.read()).invoices.map(row => row.amountCents)).toEqual([5000, 10000, 10000]);
  });

  it('takes one allowance per full annual cycle', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(plans).set({ interval: 'annual' }).where(eq(plans.id, f.plan.id)));
    await f.lifecycle.assign(f.context, assignment(f));
    for (const date of ['2028-03-01', '2029-03-01', '2030-03-01', '2031-03-01']) await bill(f, date);
    expect((await f.read()).invoices.map(row => row.amountCents)).toEqual([5000, 5000, 5000, 10000]);
    expect((await f.applications())[0]).toMatchObject({ cyclesLeft: 0, endReason: 'completed' });
  });

  it.each([false, true])('waives the signup fee, with fee-only=%s completing at assignment', async feeOnly => {
    const f = await fixture({ waivesSignupFee: true, ...(feeOnly ? { percentBasisPoints: null, duration: null, cycles: null } : {}) });
    await db.forGym(f.gymId, tx => tx.update(plans).set({ signupFeeCents: 5000 }).where(eq(plans.id, f.plan.id)));
    const assigned = await f.lifecycle.assign(f.context, assignment(f));
    expect((await f.read()).invoices).toHaveLength(0);
    expect(assigned.discount === null).toBe(feeOnly);
    expect((await f.applications())[0]).toMatchObject({ endReason: feeOnly ? 'completed' : null });
    await bill(f, '2028-03-01');
    expect((await f.read()).invoices.map(row => row.amountCents)).toEqual([feeOnly ? 10000 : 5000]);
    expect((await f.read()).lines.some(row => row.kind === 'signup_fee')).toBe(false);
  });

  it('settles a 100% zero first invoice and activates without a payment or receipt', async () => {
    const f = await fixture({ percentBasisPoints: 10000 });
    f.clock.set('2028-03-16T17:00:00Z');
    const assigned = await f.lifecycle.assign(f.context, assignment(f, { startsOn: '2028-03-16', nextDueOn: '2028-04-01',
      firstPeriod: 'prorate_now', initialStatus: 'pending' }));
    expect(await f.runner.collectAssigned(f.gymId, f.home.id)).toEqual({ attempted: 1, errors: [] }); await f.drain();
    const state = await f.read();
    expect(state.invoices).toMatchObject([{ amountCents: 0, status: 'paid' }]);
    expect(state.attempts).toEqual([]); expect(state.payments).toEqual([]);
    expect(f.email.messages).toEqual([]);
    expect((await f.lifecycle.get(f.gymId, assigned.id)).status).toBe('active');
    expect((await f.applications())[0]!.cyclesLeft).toBe(3);
  });

  it('rolls back a cycle with its invoice and handles concurrent builds once', async () => {
    const f = await fixture(), row = await f.lifecycle.assign(f.context, assignment(f));
    const gym = await f.settings.get(f.gymId);
    await expect(db.forGym(f.gymId, async tx => {
      await generateCycle(tx, gym, f.clock, f.home.id, '2028-03-01'); throw new Error('abort cycle');
    })).rejects.toThrow('abort cycle');
    expect((await f.read()).invoices).toEqual([]);
    expect((await f.applications())[0]!.cyclesLeft).toBe(3);
    expect((await f.lifecycle.get(f.gymId, row.id)).nextDueOn).toBe('2028-03-01');
    const results = await Promise.all([1, 2].map(() => db.forGym(f.gymId, tx => generateCycle(tx, gym, f.clock, f.home.id, '2028-03-01'))));
    expect(results.sort()).toEqual([false, true]);
    expect((await f.read()).invoices).toHaveLength(1); expect((await f.applications())[0]!.cyclesLeft).toBe(2);
  });

  it('skips frozen cycles without consuming a discount cycle', async () => {
    const f = await fixture(), row = await f.lifecycle.assign(f.context, assignment(f));
    await f.lifecycle.freeze(f.context, { membershipId: row.id, revision: row.revision });
    await bill(f, '2028-03-01');
    expect((await f.read()).invoices).toEqual([]); expect((await f.applications())[0]!.cyclesLeft).toBe(3);
  });

  for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) {
    it('staff assignment with a discount enforces ' + role, async () => {
      const f = await fixture({ code: 'WELCOME' });
      const response = await assignRequest(staffApp(f, role), f, { code: 'weLcome' });
      expect(response.status, await response.clone().text()).toBe(role === 'owner' || role === 'admin' ? 201 : 403);
      if (response.status === 201) expect(membershipResponseSchema.parse(await response.json()).data.discount).toMatchObject({ cyclesLeft: 3 });
      else expect((await f.catalog.get(f.gymId, f.discount.id)).uses).toBe(0);
    });
  }
  it('applies a named discount through the route and hides foreign IDs and codes', async () => {
    const f = await fixture(), other = await fixture({ code: 'FOREIGN' }), app = staffApp(f, 'admin');
    for (const discount of [{ discountId: other.discount.id }, { code: 'foreign' }]) {
      const response = await assignRequest(app, f, discount);
      expect(response.status, await response.clone().text()).toBe(404);
      expect((await response.json()).error.details.reason).toEqual(['discount_unknown']);
    }
    const applied = await assignRequest(app, f, { discountId: f.discount.id });
    expect(applied.status, await applied.clone().text()).toBe(201);
    expect(membershipResponseSchema.parse(await applied.json()).data.discount).toMatchObject({ discountId: f.discount.id });
    expect((await other.catalog.get(other.gymId, other.discount.id)).uses).toBe(0);
  });
});
