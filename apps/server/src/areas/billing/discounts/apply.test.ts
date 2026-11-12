// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { discounts, membershipDiscounts, memberships, households, auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { addDays, zonedInstant } from '@plaingym/shared/time';
import type { AssignMembership } from '../../../core/interfaces/membership-lifecycle.js';
import { TestClock } from '../../../core/clock.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createMembershipService } from '../memberships.js';
import { createDiscountCatalogService } from './catalog.js';
import { resolveDiscount, takeDiscountUses, applyDiscount } from './apply.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(now = '2028-03-01T20:00:00Z', timezone = 'America/Vancouver') {
  const gymId = uuidv7(); await factory('gyms', gymId, { timezone });
  const clock = new TestClock(now), context = { gymId, actor: { kind: 'system' as const } };
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  const service = createMembershipService(options), catalog = createDiscountCatalogService(options);
  const plan = await factory('plans', gymId);
  const discount = await catalog.create(context, { name: 'Three cycles', currency: 'USD', percentBasisPoints: 5000,
    duration: 'cycles', cycles: 3, code: 'SAVE-50' });
  async function request(): Promise<AssignMembership> {
    const home = await factory('households', gymId), member = await factory('members', gymId, { householdId: home.id });
    return { id: uuidv7(), householdId: home.id, memberId: member.id, planId: plan.id, startsOn: '2028-03-01',
      nextDueOn: '2028-03-01', firstPeriod: 'next_billing_date', discount: { discountId: discount.id } };
  }
  const state = () => db.forGym(gymId, async tx => ({ discounts: await tx.select().from(discounts),
    applications: await tx.select().from(membershipDiscounts), memberships: await tx.select().from(memberships),
    audits: await tx.select().from(auditEvents) }));
  return { gymId, clock, context, options, service, catalog, plan, discount, request, state };
}
describe('applying membership discounts', () => {
  it('serializes two households competing for the last use and rolls back the loser', async () => {
    const f = await fixture();
    await f.catalog.update(f.context, f.discount.id, { revision: 1, maxUses: 1 });
    const requests = await Promise.all([f.request(), f.request()]);
    const results = await Promise.allSettled(requests.map(request => f.service.assign(f.context, request)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { details: { reason: ['discount_used_up'] } } }]);
    const state = await f.state();
    expect(state.discounts[0]!.uses).toBe(1);
    expect(state.applications).toHaveLength(1); expect(state.memberships).toHaveLength(1);
    expect(state.audits.filter(row => row.action === 'billing.discount.uses_taken')).toHaveLength(1);
  });

  it('replays a used-up assignment once and rejects a different nested selection on that ID', async () => {
    const f = await fixture(); await f.catalog.update(f.context, f.discount.id, { revision: 1, maxUses: 1 });
    const request = await f.request();
    const [a, b] = await Promise.all([f.service.assign(f.context, request), f.service.assign(f.context, request)]);
    expect(a).toEqual(b);
    await expect(f.service.assign(f.context, { ...request, discount: { discountId: uuidv7() } })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.assign(f.context, { ...request, discount: { code: 'SAVE-50' } })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.state()).discounts[0]!.uses).toBe(1);
    expect((await f.state()).applications).toHaveLength(1);
  });

  it.each(['save-50', 'SaVe-50', 'SAVE-50'])('finds code %s and returns its locked-in terms from get and list', async code => {
    const f = await fixture(), request = { ...await f.request(), discount: { code } };
    const membership = await f.service.assign(f.context, request);
    expect(membership.discount).toMatchObject({ discountId: f.discount.id, name: 'Three cycles', cyclesLeft: 3, percentBasisPoints: 5000 });
    expect((await f.service.get(f.gymId, membership.id)).discount).toEqual(membership.discount);
    expect((await f.service.list(f.gymId, {})).data[0]!.discount).toEqual(membership.discount);
    expect((await f.state()).discounts[0]!.uses).toBe(1);
  });

  it.each([['2028-03-12', 23], ['2028-11-05', 25]] as const)(
    'allows the last minute of %s across DST, but refuses next local midnight', async (endsOn, hours) => {
    const timezone = 'America/New_York';
    const start = zonedInstant(endsOn, '00:00', timezone, { gap: 'shift' })!;
    const midnight = zonedInstant(addDays(endsOn, 1), '00:00', timezone, { gap: 'shift' })!;
    expect(midnight.getTime() - start.getTime()).toBe(hours * 60 * 60 * 1000);
    const f = await fixture(zonedInstant(endsOn, '23:59', timezone, { gap: 'shift' })!.toISOString(), timezone);
    await f.catalog.update(f.context, f.discount.id, { revision: 1, endsOn });
    await f.service.assign(f.context, await f.request());
    f.clock.set(midnight.toISOString());
    await expect(f.service.assign(f.context, await f.request())).rejects.toMatchObject({ details: { reason: ['discount_ended'] } });
    expect((await f.state()).discounts[0]!.uses).toBe(1);
  });

  it('enforces the plan list, with an empty list allowing any plan', async () => {
    const f = await fixture(), other = await factory('plans', f.gymId);
    await f.catalog.update(f.context, f.discount.id, { revision: 1, planIds: [f.plan.id] });
    await f.service.assign(f.context, await f.request());
    await expect(f.service.assign(f.context, { ...await f.request(), planId: other.id })).rejects.toMatchObject({ details: { reason: ['discount_plan'] } });
    const current = await f.catalog.get(f.gymId, f.discount.id);
    await f.catalog.update(f.context, f.discount.id, { revision: current.revision, planIds: [] });
    await f.service.assign(f.context, { ...await f.request(), planId: other.id });
    expect((await f.state()).discounts[0]!.uses).toBe(2);
  });

  it('does not see another gym discount by ID or code', async () => {
    const a = await fixture(), b = await fixture();
    await b.catalog.update(b.context, b.discount.id, { revision: 1, code: 'FOREIGN' });
    for (const discount of [{ discountId: b.discount.id }, { code: 'foreign' }]) {
      await expect(a.service.assign(a.context, { ...await a.request(), discount })).rejects.toMatchObject({ code: 'not_found', details: { reason: ['discount_unknown'] } });
    }
    expect((await b.state()).discounts[0]!.uses).toBe(0);
    expect((await a.state()).memberships).toEqual([]);
  });

  it('uses one neutral public error for unknown, inactive, expired, full and ineligible codes', async () => {
    const f = await fixture();
    const resolve = (code: string) => db.forGym(f.gymId, tx => resolveDiscount(tx, { code }, {
      planIds: [f.plan.id], clock: f.clock, timezone: 'America/Vancouver', audience: 'public' }));
    const neutral = { code: 'invalid_request', message: 'This discount is not available.', details: { reason: ['discount_unknown'] } };
    await expect(resolve('UNKNOWN')).rejects.toMatchObject(neutral);
    for (const changes of [{ active: false }, { active: true, endsOn: '2028-02-29' },
      { endsOn: null, maxUses: 1, uses: 1 }, { maxUses: null, uses: 0 }]) {
      await db.forGym(f.gymId, tx => tx.update(discounts).set(changes).where(eq(discounts.id, f.discount.id)));
      if (changes.maxUses === null) {
        const other = await factory('plans', f.gymId);
        await factory('discountPlans', f.gymId, { discountId: f.discount.id, planId: other.id });
      }
      await expect(resolve('SAVE-50')).rejects.toMatchObject(neutral);
    }
  });

  it('reserves a batch atomically and can apply its already-taken uses without counting twice', async () => {
    const f = await fixture(); await f.catalog.update(f.context, f.discount.id, { revision: 1, maxUses: 2 });
    const first = await f.request(), second = await f.request();
    const gym = await f.options.settings.get(f.gymId);
    // The encompassing caller supplies its transaction as the membership scope.
    await db.forGym(f.gymId, async tx => {
      for (const id of [first.householdId, second.householdId].sort())
        await tx.select().from(households).where(eq(households.id, id)).for('update');
      const resolved = await resolveDiscount(tx, { code: 'save-50' }, { planIds: [f.plan.id], clock: f.clock, timezone: 'America/Vancouver' });
      await takeDiscountUses(tx, f.context, f.clock, resolved, 2);
      const service = createMembershipService({ ...f.options, settings: { ...f.options.settings, get: async () => gym },
        scope: async (_gymId, work) => work(tx) });
      await service.assign(f.context, { ...first, discountUseTaken: true });
      await service.assign(f.context, { ...second, discountUseTaken: true });
    });
    expect((await f.state()).discounts[0]!.uses).toBe(2);
    expect((await f.state()).applications).toHaveLength(2);
  });

  it('rolls back a reservation when later application fails, and never returns a cancelled use', async () => {
    const f = await fixture();
    await expect(db.forGym(f.gymId, async tx => {
      const resolved = await resolveDiscount(tx, { discountId: f.discount.id }, { planIds: [f.plan.id], clock: f.clock, timezone: 'America/Vancouver' });
      await takeDiscountUses(tx, f.context, f.clock, resolved, 2);
      await applyDiscount(tx, f.context, f.clock, resolved, { id: uuidv7(), householdId: uuidv7() }, true);
    })).rejects.toBeDefined();
    expect((await f.state()).discounts[0]!.uses).toBe(0);
    const row = await f.service.assign(f.context, await f.request());
    await f.service.cancel(f.context, { membershipId: row.id, revision: row.revision });
    expect((await f.state()).discounts[0]!.uses).toBe(1);
  });
});
