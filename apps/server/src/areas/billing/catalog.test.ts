// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, planTaxRates, chargeTypeTaxRates, uuidv7 } from '@plaingym/db';
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
    await f.service.updateTaxRate(f.context, f.tax.id, { revision: 1, active: false });
    await f.service.updatePlan(f.context, plan.id, { revision: 1, name: 'Renamed', taxRateIds: [f.tax.id] });
    expect((await f.service.getPlan(f.gymId, plan.id)).taxRateIds).toEqual([f.tax.id]);
    await expect(f.service.createChargeType(f.context, { name: 'Wrong', currency: 'CAD', amountCents: 100, taxRateIds: [f.tax.id] })).rejects.toMatchObject({ code: 'conflict' });
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
