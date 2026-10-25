// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, memberships, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { calculateCycleInvoice, calculateFirstPeriod } from './invoicing/index.js';
import { createMembershipService, type AssignmentBilling } from './memberships.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency: 'CAD', timezone: 'America/Vancouver' });
  const home = await factory('households', gymId, { billingDay: 15 });
  const member = await factory('members', gymId, { householdId: home.id });
  const plan = await factory('plans', gymId, { interval: 'annual', amountCents: 120000 });
  const clock = new TestClock('2028-02-29T12:00:00Z');
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  const service = createMembershipService(options);
  const context = { gymId, actor: { kind: 'system' as const } };
  const request = { id: uuidv7(), householdId: home.id, memberId: member.id, planId: plan.id,
    startsOn: '2028-02-29', nextDueOn: '2028-02-29', initialStatus: 'active' as const, firstPeriod: 'next_billing_date' as const };
  const pricing = { householdId: home.id, currency: 'CAD', billingDay: 15,
    familyDiscountBasisPoints: 0, discountDescription: 'Family discount' };
  const read = async (id = request.id) => (await db.forGym(gymId, tx => tx.select().from(memberships).where(eq(memberships.id, id))))[0]!;
  return { gymId, clock, home, member, plan, options, service, context, request, pricing, read };
}

describe('persisted annual anniversaries', () => {
  it.each(['2028-02-29', '2028-01-10'])('retains February 29 over four persisted renewals starting on %s', async startsOn => {
    const f = await fixture();
    await f.service.assign(f.context, { ...f.request, startsOn });
    for (const expected of ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']) {
      const row = await f.read();
      expect(row.anniversaryOn).toBe('2028-02-29');
      const result = calculateCycleInvoice({ ...f.pricing, dueOn: row.nextDueOn,
        memberships: [{ membership: await f.service.get(f.gymId, row.id), description: 'Annual membership',
          taxRates: [], ...(row.anniversaryOn === null ? {} : { annualAnchorOn: row.anniversaryOn }) }] });
      expect(result.invoice).toMatchObject({ dueOn: row.nextDueOn, periodEndsOn: expected, amountCents: 120000 });
      expect(result.nextDueDates).toMatchObject([{ membershipId: row.id, previousDueOn: row.nextDueOn, nextDueOn: expected }]);
      await db.forGym(f.gymId, tx => tx.update(memberships).set({ nextDueOn: expected, revision: row.revision + 1 }).where(eq(memberships.id, row.id)));
    }
    expect(await f.read()).toMatchObject({ startsOn, nextDueOn: '2032-02-29', anniversaryOn: '2028-02-29' });
  });

  it('passes the annual anniversary to first-period invoice work and its assignment audit exactly once', async () => {
    const f = await fixture(); let calls = 0;
    let billing: AssignmentBilling | undefined;
    const service = createMembershipService({ ...f.options, async onAssigned(_tx, _context, membership, instructions) {
      calls++; billing = instructions;
      const result = calculateFirstPeriod({ ...f.pricing, membership, description: 'Annual membership', taxRates: [], ...instructions });
      expect(result).toMatchObject({ periodStartsOn: '2027-02-28', periodEndsOn: '2028-02-29', periodDays: 366, billedDays: 50 });
      expect(result.invoice?.amountCents).toBe(16393);
    } });
    const request = { ...f.request, startsOn: '2028-01-10', firstPeriod: 'prorate_now' as const };
    await service.assign(f.context, request);
    await service.assign(f.context, request);
    expect(calls).toBe(1);
    expect(billing?.annualAnchorOn).toBe('2028-02-29');
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, request.id)));
    expect(events).toHaveLength(1);
    expect(events[0]?.after).toMatchObject({ billing: { annualAnchorOn: '2028-02-29' } });
  });

  it('anchors an annual trial to its first bill and leaves monthly assignments unanchored', async () => {
    const f = await fixture();
    const plan = await factory('plans', f.gymId, { interval: 'annual', trialDays: 7 });
    const annual = await f.service.assignFromCatalog(f.context, { householdId: f.home.id, memberId: f.member.id,
      planId: plan.id, startsOn: f.request.startsOn, nextDueOn: f.request.nextDueOn });
    expect(await f.read(annual.id)).toMatchObject({ startsOn: '2028-02-29', nextDueOn: '2028-03-07', anniversaryOn: '2028-03-07' });
    const monthlyPlan = await factory('plans', f.gymId);
    const monthly = await f.service.assign(f.context, { ...f.request, id: uuidv7(), planId: monthlyPlan.id });
    expect((await f.read(monthly.id)).anniversaryOn).toBeNull();
  });

  it('retains the anniversary through freeze, late resume, a clamped date edit and cancellation', async () => {
    const f = await fixture();
    const assigned = await f.service.assign(f.context, f.request);
    const frozen = await f.service.freeze(f.context, { membershipId: assigned.id, revision: assigned.revision });
    expect(frozen.nextDueOn).toBe('2029-02-28');
    f.clock.set('2031-03-01T12:00:00Z');
    const resumed = await f.service.activate(f.context, { membershipId: assigned.id, revision: frozen.revision });
    expect(resumed.nextDueOn).toBe('2032-02-29');
    const edited = await f.service.update(f.context, { membershipId: assigned.id, revision: resumed.revision, nextDueOn: '2033-02-28' });
    await f.service.cancel(f.context, { membershipId: assigned.id, revision: edited.revision });
    expect(await f.read()).toMatchObject({ startsOn: '2028-02-29', nextDueOn: '2033-02-28', anniversaryOn: '2028-02-29' });
  });

  it('sets a new annual anniversary when edited to another month, then freezes on that anniversary', async () => {
    const f = await fixture();
    await f.service.assign(f.context, f.request);
    const edited = await f.service.update(f.context, { membershipId: f.request.id, revision: 1, nextDueOn: '2028-06-19' });
    expect((await f.read()).anniversaryOn).toBe('2028-06-19');
    const frozen = await f.service.freeze(f.context, { membershipId: edited.id, revision: edited.revision });
    expect(frozen.nextDueOn).toBe('2029-06-19');
    expect((await f.read()).anniversaryOn).toBe('2028-06-19');
  });

  it.each([
    ['2031-02-15', '2031-02-15', '2032-02-15'],
    ['2031-02-28', '2028-02-29', '2032-02-29'],
    ['2032-02-28', '2032-02-28', '2033-02-28'],
    ['2032-02-29', '2028-02-29', '2033-02-28'],
  ])('distinguishes a February edit to %s from a clamped leap day', async (nextDueOn, anniversaryOn, skippedDueOn) => {
    const f = await fixture();
    await f.service.assign(f.context, f.request);
    const edited = await f.service.update(f.context, { membershipId: f.request.id, revision: 1, nextDueOn });
    expect((await f.read()).anniversaryOn).toBe(anniversaryOn);
    const frozen = await f.service.freeze(f.context, { membershipId: edited.id, revision: edited.revision });
    expect(frozen.nextDueOn).toBe(skippedDueOn);
    expect((await f.read()).anniversaryOn).toBe(anniversaryOn);
  });

  it.each([
    ['2030-06-19', '2030-07-01T12:00:00Z', '2030-06-19', '2031-06-19'],
    ['2031-02-15', '2031-03-01T12:00:00Z', '2031-02-15', '2032-02-15'],
    ['2031-02-28', '2031-03-01T12:00:00Z', '2028-02-29', '2032-02-29'],
    ['2032-02-28', '2032-03-01T12:00:00Z', '2032-02-28', '2033-02-28'],
  ])('uses an explicit resume date %s before advancing missed frozen cycles', async (nextDueOn, now, anniversaryOn, resumedDueOn) => {
    const f = await fixture();
    await f.service.assign(f.context, f.request);
    const frozen = await f.service.freeze(f.context, { membershipId: f.request.id, revision: 1 });
    f.clock.set(now);
    const resumed = await f.service.activate(f.context, { membershipId: frozen.id, revision: frozen.revision, nextDueOn });
    expect(resumed.nextDueOn).toBe(resumedDueOn);
    expect((await f.read()).anniversaryOn).toBe(anniversaryOn);
    const refrozen = await f.service.freeze(f.context, { membershipId: resumed.id, revision: resumed.revision });
    const result = calculateCycleInvoice({ ...f.pricing, dueOn: resumed.nextDueOn,
      memberships: [{ membership: resumed, description: 'Annual membership', taxRates: [], annualAnchorOn: anniversaryOn }] });
    expect(refrozen.nextDueOn).toBe(result.nextDueDates[0]?.nextDueOn);
  });

  it.each([undefined, '2029-06-19'])('clears the anniversary on a switch to monthly and sets it when switching back (date: %s)', async nextDueOn => {
    const f = await fixture();
    await f.service.assign(f.context, f.request);
    const monthly = await f.service.update(f.context, { membershipId: f.request.id, revision: 1,
      interval: 'monthly', nextDueOn: '2028-06-15' });
    expect(await f.read()).toMatchObject({ interval: 'monthly', anniversaryOn: null });
    const annual = await f.service.update(f.context, { membershipId: monthly.id, revision: monthly.revision,
      interval: 'annual', ...(nextDueOn === undefined ? {} : { nextDueOn }) });
    const expected = nextDueOn ?? monthly.nextDueOn;
    expect(await f.read()).toMatchObject({ interval: 'annual', nextDueOn: expected, anniversaryOn: expected });
    const frozen = await f.service.freeze(f.context, { membershipId: annual.id, revision: annual.revision });
    expect(frozen.nextDueOn).toBe(nextDueOn === undefined ? '2029-06-15' : '2030-06-19');
  });

  it('uses the final interval after plan defaults and explicit overrides when setting an anniversary', async () => {
    const f = await fixture();
    await f.service.assign(f.context, f.request);
    const monthlyPlan = await factory('plans', f.gymId);
    const monthly = await f.service.changePlan(f.context, { membershipId: f.request.id, revision: 1, planId: monthlyPlan.id });
    expect(await f.read()).toMatchObject({ interval: 'monthly', anniversaryOn: null });
    const overridden = await f.service.update(f.context, { membershipId: monthly.id, revision: monthly.revision,
      planId: f.plan.id, interval: 'monthly', nextDueOn: '2028-06-15' });
    expect(await f.read()).toMatchObject({ interval: 'monthly', anniversaryOn: null });
    await f.service.changePlan(f.context, { membershipId: overridden.id, revision: overridden.revision, planId: f.plan.id });
    expect(await f.read()).toMatchObject({ interval: 'annual', anniversaryOn: '2028-06-15' });
  });

  it('uses the anniversary for every skipped cycle of a timed freeze', async () => {
    const f = await fixture();
    await f.service.assign(f.context, f.request);
    const frozen = await f.service.freeze(f.context, { membershipId: f.request.id, revision: 1, resumesOn: '2032-02-28' });
    expect(frozen.nextDueOn).toBe('2032-02-29');
    expect((await f.read()).anniversaryOn).toBe('2028-02-29');
  });

  it('keeps a legacy annual schedule and a repeated assignment with no stored anniversary', async () => {
    const f = await fixture();
    const request = { ...f.request, startsOn: '2027-01-10', nextDueOn: '2031-02-28' };
    await f.service.assign(f.context, request);
    // Previous-release assignments did not record an anniversary.
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ anniversaryOn: null }).where(eq(memberships.id, request.id)));
    await f.service.assign(f.context, request);
    const row = await f.read();
    expect(row).toMatchObject({ startsOn: request.startsOn, nextDueOn: request.nextDueOn, anniversaryOn: null });
    const result = calculateCycleInvoice({ ...f.pricing, dueOn: row.nextDueOn,
      memberships: [{ membership: await f.service.get(f.gymId, row.id), description: 'Annual membership',
        taxRates: [], ...(row.anniversaryOn === null ? {} : { annualAnchorOn: row.anniversaryOn }) }] });
    expect(result.nextDueDates[0]?.nextDueOn).toBe('2032-02-28');
    const frozen = await f.service.freeze(f.context, { membershipId: row.id, revision: row.revision });
    expect(frozen.nextDueOn).toBe('2032-02-28');
    expect((await f.read()).anniversaryOn).toBeNull();
  });
});
