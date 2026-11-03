// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, planTaxRates, chargeTypeTaxRates, taxRates, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createCatalogService } from './catalog.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'CAD' });
  const clock = new TestClock('2026-10-23T12:00:00Z'), context = { gymId, actor: { kind: 'system' as const } };
  const service = createCatalogService({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) });
  const tax = await service.createTaxRate(context, { name: 'Sales tax', rateMillionths: 99_750, inclusive: false });
  return { gymId, clock, context, service, tax };
}
describe('billing catalog against PostgreSQL', () => {
  it('keeps several inclusive/exclusive tax rates and sign-up fee defaults', async () => {
    const f = await fixture();
    const inclusive = await f.service.createTaxRate(f.context, { name: 'Included tax', rateMillionths: 50_000, inclusive: true });
    const plan = await f.service.createPlan(f.context, { name: 'Unlimited', currency: 'CAD', amountCents: 12_345, interval: 'monthly',
      signupFeeCents: 2500, trialDays: 7, commitmentMonths: 6, taxRateIds: [f.tax.id, inclusive.id] });
    const charge = await f.service.createChargeType(f.context, { name: 'Drop-in', currency: 'CAD', amountCents: 2000, taxRateIds: [inclusive.id, f.tax.id] });
    expect(plan).toMatchObject({ signupFeeCents: 2500, trialDays: 7, commitmentMonths: 6, revision: 1, createdAt: f.clock.now().toISOString() });
    expect((await f.service.getPlan(f.gymId, plan.id)).taxRateIds).toEqual([f.tax.id, inclusive.id].sort());
    expect((await f.service.getChargeType(f.gymId, charge.id)).taxRateIds).toEqual(plan.taxRateIds);
  });
  it('paginates deterministically and parses explicit active/currency filters', async () => {
    const f = await fixture();
    await f.service.createPlan(f.context, { name: 'Active', currency: 'CAD', amountCents: 0, interval: 'annual' });
    await f.service.createPlan(f.context, { name: 'Retired', currency: 'CAD', amountCents: 50, interval: 'monthly', active: false });
    const filtered = await f.service.listPlans(f.gymId, { active: 'false', currency: 'CAD', limit: 1 });
    expect(filtered.data.map(row => row.name)).toEqual(['Retired']);
    expect(filtered.pagination).toEqual({ limit: 1, offset: 0, total: 1 });
    expect((await f.service.listPlans(f.gymId, { offset: 1, limit: 1 })).data[0]?.name).toBe('Retired');
    expect((await f.service.listPlans(f.gymId, { currency: 'USD' })).data).toEqual([]);
  });
  it('replaces tax links atomically with one revision and rejects stale writes', async () => {
    const f = await fixture();
    const plan = await f.service.createPlan(f.context, { name: 'Plan', currency: 'CAD', amountCents: 100, interval: 'monthly', taxRateIds: [f.tax.id] });
    const updated = await f.service.updatePlan(f.context, plan.id, { revision: 1, taxRateIds: [] });
    expect(updated).toMatchObject({ revision: 2, taxRateIds: [] });
    await expect(f.service.updatePlan(f.context, plan.id, { revision: 1, taxRateIds: [f.tax.id] })).rejects.toMatchObject({ name: 'RevisionConflictError' });
    expect((await f.service.getPlan(f.gymId, plan.id)).taxRateIds).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.select().from(planTaxRates))).toEqual([]);
  });
  it('replaces one-off charge taxes and retires charge types without deleting them', async () => {
    const f = await fixture();
    const charge = await f.service.createChargeType(f.context, { name: 'Drop-in', currency: 'CAD', amountCents: 2000, taxRateIds: [f.tax.id] });
    expect(await f.service.updateChargeType(f.context, charge.id, { revision: 1, taxRateIds: [], active: false })).toMatchObject({ revision: 2, active: false });
    expect(await db.forGym(f.gymId, tx => tx.select().from(chargeTypeTaxRates))).toEqual([]);
  });
  it('rejects currency mismatches before inserting or changing a record', async () => {
    const f = await fixture();
    await expect(f.service.createPlan(f.context, { name: 'Wrong', currency: 'USD', amountCents: 100, interval: 'monthly' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.createChargeType(f.context, { name: 'Wrong', currency: 'USD', amountCents: 100 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.service.listPlans(f.gymId, {})).data).toEqual([]);
  });
  it('rejects foreign/missing tax IDs and duplicate links with no partial changes', async () => {
    const f = await fixture(), other = await fixture();
    await expect(f.service.createPlan(f.context, { name: 'Wrong', currency: 'CAD', amountCents: 100, interval: 'monthly', taxRateIds: [other.tax.id] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.createChargeType(f.context, { name: 'Wrong', currency: 'CAD', amountCents: 100, taxRateIds: [f.tax.id, f.tax.id] })).rejects.toThrow();
    expect((await f.service.listPlans(f.gymId, {})).pagination.total).toBe(0);
  });
  it('refuses new links to retired taxes but preserves historical links', async () => {
    const f = await fixture();
    const plan = await f.service.createPlan(f.context, { name: 'Plan', currency: 'CAD', amountCents: 100, interval: 'monthly', taxRateIds: [f.tax.id] });
    // A rate archived and attached before the archive rule existed.
    await db.forGym(f.gymId, tx => tx.update(taxRates).set({ active: false, revision: 2 }).where(eq(taxRates.id, f.tax.id)));
    await f.service.updatePlan(f.context, plan.id, { revision: 1, name: 'Renamed', taxRateIds: [f.tax.id] });
    expect((await f.service.getPlan(f.gymId, plan.id)).taxRateIds).toEqual([f.tax.id]);
    await expect(f.service.createChargeType(f.context, { name: 'Wrong', currency: 'CAD', amountCents: 100, taxRateIds: [f.tax.id] })).rejects.toMatchObject({ code: 'conflict' });
    // It stays editable as it is (the editor always sends `active`), and `detach` clears it.
    expect(await f.service.updateTaxRate(f.context, f.tax.id, { revision: 2, name: 'Old tax' })).toMatchObject({ name: 'Old tax', active: false });
    expect(await f.service.updateTaxRate(f.context, f.tax.id, { revision: 3, name: 'Older tax', active: false })).toMatchObject({ revision: 4 });
    expect((await f.service.getPlan(f.gymId, plan.id)).taxRateIds).toEqual([f.tax.id]);
    expect(await f.service.updateTaxRate(f.context, f.tax.id, { revision: 4, active: false, detach: true })).toMatchObject({ revision: 5 });
    expect((await f.service.getPlan(f.gymId, plan.id)).taxRateIds).toEqual([]);
  });
  it('keeps a plan edit that waited on a detach from attaching the archived rate again', async () => {
    const f = await attachedFixture();
    let release!: () => void, holding!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), locked = new Promise<void>(resolve => { holding = resolve; });
    // What a confirmed detach does, paused while it holds the rate's lock.
    const detach = db.forGym(f.gymId, async tx => {
      await tx.select().from(taxRates).where(eq(taxRates.id, f.tax.id)).for('update');
      holding(); await gate;
      await tx.delete(planTaxRates).where(eq(planTaxRates.taxRateId, f.tax.id));
      await tx.update(taxRates).set({ active: false, revision: 2 }).where(eq(taxRates.id, f.tax.id));
    });
    await locked;
    // The plan edit, which still carries the rate, reaches the rate's lock and waits; then the detach commits.
    const edit = f.service.updatePlan(f.context, f.monthly.id, { revision: 1, name: 'Monthly+', taxRateIds: [f.tax.id] }).catch((error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 300));
    release(); await detach;
    expect(await edit).toMatchObject({ code: 'conflict' });
    expect((await f.service.getPlan(f.gymId, f.monthly.id)).taxRateIds).toEqual([]);
  });
  async function attachedFixture() {
    const f = await fixture();
    const gst = await f.service.createTaxRate(f.context, { name: 'GST', rateMillionths: 50_000, inclusive: false });
    const drop = await f.service.createChargeType(f.context, { name: 'Drop-in', currency: 'CAD', amountCents: 2000, taxRateIds: [f.tax.id, gst.id] });
    const mats = await f.service.createChargeType(f.context, { name: 'Mat rental', currency: 'CAD', amountCents: 500, taxRateIds: [gst.id] });
    const monthly = await f.service.createPlan(f.context, { name: 'Monthly', currency: 'CAD', amountCents: 9000, interval: 'monthly', taxRateIds: [f.tax.id] });
    const annual = await f.service.createPlan(f.context, { name: 'Annual', currency: 'CAD', amountCents: 90_000, interval: 'annual', taxRateIds: [f.tax.id, gst.id] });
    const home = await factory('households', f.gymId), member = await factory('members', f.gymId, { householdId: home.id });
    const base = { householdId: home.id, memberId: member.id, startsOn: '2026-11-01', nextDueOn: '2026-11-01' };
    for (const status of ['active', 'frozen', 'pending', 'trial', 'cancelled'] as const) await factory('memberships', f.gymId, { ...base, planId: monthly.id, status });
    await factory('memberships', f.gymId, { ...base, planId: annual.id, status: 'active' });
    return { ...f, gst, drop, mats, monthly, annual };
  }
  const links = (f: { gymId: string }) => db.forGym(f.gymId, async tx => ({
    charges: (await tx.select().from(chargeTypeTaxRates)).map(link => [link.chargeTypeId, link.taxRateId]),
    plans: (await tx.select().from(planTaxRates)).map(link => [link.planId, link.taxRateId]) }));
  it('lists what carries a rate, counting memberships that are not cancelled', async () => {
    const f = await attachedFixture();
    expect(await f.service.getTaxRateUsage(f.gymId, f.tax.id)).toEqual({
      chargeTypes: [{ id: f.drop.id, name: 'Drop-in', active: true }],
      plans: [{ id: f.annual.id, name: 'Annual', active: true, memberships: 1 }, { id: f.monthly.id, name: 'Monthly', active: true, memberships: 4 }],
      memberships: 5 });
    const unused = await f.service.createTaxRate(f.context, { name: 'Unused', rateMillionths: 10_000, inclusive: true });
    expect(await f.service.getTaxRateUsage(f.gymId, unused.id)).toEqual({ chargeTypes: [], plans: [], memberships: 0 });
    await expect(f.service.getTaxRateUsage(f.gymId, uuidv7())).rejects.toMatchObject({ code: 'not_found' });
  });
  it('refuses to archive an attached rate without confirmation, listing what carries it', async () => {
    const f = await attachedFixture(), before = await links(f);
    const refused = await f.service.updateTaxRate(f.context, f.tax.id, { revision: 1, active: false, name: 'Renamed' }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'conflict', details: { reason: ['tax_rate_attached'], chargeTypes: ['Drop-in'], plans: ['Annual', 'Monthly'], memberships: ['5'] } });
    expect(await f.service.getTaxRate(f.gymId, f.tax.id)).toMatchObject({ active: true, revision: 1, name: 'Sales tax' });
    expect(await links(f)).toEqual(before);
    // A stale revision is a plain revision conflict, not the list.
    await expect(f.service.updateTaxRate(f.context, f.tax.id, { revision: 9, active: false })).rejects.toMatchObject({ name: 'RevisionConflictError' });
    await expect(f.service.updateTaxRate(f.context, f.tax.id, { revision: 9, active: false, detach: true })).rejects.toMatchObject({ name: 'RevisionConflictError' });
    expect(await links(f)).toEqual(before);
  });
  it('detaches and archives in one audited step when confirmed, leaving other rates alone', async () => {
    const f = await attachedFixture();
    const archived = await f.service.updateTaxRate(f.context, f.tax.id, { revision: 1, active: false, detach: true });
    expect(archived).toMatchObject({ active: false, revision: 2 });
    const after = await links(f);
    expect(after.charges).toHaveLength(2);
    expect(after.charges).toEqual(expect.arrayContaining([[f.drop.id, f.gst.id], [f.mats.id, f.gst.id]]));
    expect(after.plans).toEqual([[f.annual.id, f.gst.id]]);
    expect((await f.service.getPlan(f.gymId, f.monthly.id)).taxRateIds).toEqual([]);
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.tax.id)));
    expect(events.map(event => event.action).sort()).toEqual(['billing.tax_rate.archived', 'billing.tax_rate.created']);
    const audit = events.find(event => event.action === 'billing.tax_rate.archived')!;
    const usage = { chargeTypes: [{ id: f.drop.id, name: 'Drop-in', active: true }],
      plans: [{ id: f.annual.id, name: 'Annual', active: true, memberships: 1 }, { id: f.monthly.id, name: 'Monthly', active: true, memberships: 4 }], memberships: 5 };
    expect(audit.before).toMatchObject({ active: true, revision: 1, attachedTo: usage });
    expect(audit.after).toMatchObject({ active: false, revision: 2, detachedFrom: usage });
    // Nothing can attach it again.
    await expect(f.service.updatePlan(f.context, f.monthly.id, { revision: 1, taxRateIds: [f.tax.id] })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('archives an unattached rate as before, with or without the confirmation', async () => {
    const f = await fixture();
    expect(await f.service.updateTaxRate(f.context, f.tax.id, { revision: 1, active: false })).toMatchObject({ active: false, revision: 2 });
    const other = await f.service.createTaxRate(f.context, { name: 'Other', rateMillionths: 10_000, inclusive: false });
    expect(await f.service.updateTaxRate(f.context, other.id, { revision: 1, active: false, detach: true })).toMatchObject({ active: false, revision: 2 });
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.tax.id)));
    expect(events.map(event => event.action).sort()).toEqual(['billing.tax_rate.created', 'billing.tax_rate.updated']);
  });
  it('never reads or detaches another gym\'s links', async () => {
    const f = await attachedFixture(), other = await attachedFixture(), theirs = await links(other);
    await expect(f.service.getTaxRateUsage(f.gymId, other.tax.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.updateTaxRate(f.context, other.tax.id, { revision: 1, active: false, detach: true })).rejects.toMatchObject({ code: 'not_found' });
    await f.service.updateTaxRate(f.context, f.tax.id, { revision: 1, active: false, detach: true });
    expect(await links(other)).toEqual(theirs);
    expect(await f.service.getTaxRate(other.gymId, other.tax.id)).toMatchObject({ active: true });
    expect((await f.service.getTaxRateUsage(other.gymId, other.tax.id)).memberships).toBe(5);
  });
  it('audits every catalog mutation with injected time', async () => {
    const f = await fixture();
    await f.service.updateTaxRate(f.context, f.tax.id, { revision: 1, rateMillionths: 88_750 });
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.tax.id)));
    expect(events.map(event => event.action).sort()).toEqual(['billing.tax_rate.created', 'billing.tax_rate.updated']);
    expect(events.every(event => event.occurredAt.toISOString() === f.clock.now().toISOString() && event.actorKind === 'system')).toBe(true);
    const updated = events.find(event => event.action === 'billing.tax_rate.updated')!;
    expect(updated.before).toMatchObject({ rateMillionths: f.tax.rateMillionths, revision: 1 });
    expect(updated.after).toMatchObject({ rateMillionths: 88_750, revision: 2 });
  });
});
