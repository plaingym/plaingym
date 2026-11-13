// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEvents, discounts, discountPlans, membershipDiscounts, RevisionConflictError, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createDiscountCatalogService } from './catalog.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-12T12:00:00Z');
async function fixture(currency = 'USD') {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency });
  const context = { gymId, actor: { kind: 'system' as const } };
  const service = createDiscountCatalogService({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) });
  const plan = await factory('plans', gymId);
  const input = { name: 'Family', code: 'FAMILY', currency, percentBasisPoints: 1000, duration: 'forever' as const, planIds: [plan.id] };
  return { gymId, context, service, plan, input };
}
describe('discount catalog service', () => {
  it('creates, reads, filters, paginates and archives without touching existing billing data or uses', async () => {
    const f = await fixture(), row = await f.service.create(f.context, f.input);
    expect(row).toMatchObject({ ...f.input, uses: 0, termsLocked: false, revision: 1, createdAt: clock.now().toISOString(), active: true });
    expect(await f.service.get(f.gymId, row.id)).toEqual(row);
    await f.service.create(f.context, { name: 'Waiver', currency: 'USD', waivesSignupFee: true });
    const off = await f.service.update(f.context, row.id, { revision: 1, active: false, code: null });
    expect(off).toMatchObject({ active: false, code: null, revision: 2, uses: 0 });
    expect((await f.service.list(f.gymId, { active: 'true', limit: 1, offset: 0 })).data.map(d => d.name)).toEqual(['Waiver']);
    expect(await f.service.list(f.gymId, { active: 'false' })).toMatchObject({ data: [off], pagination: { total: 1 } });
    expect(await f.service.list(f.gymId, { limit: 1, offset: 1 })).toMatchObject({ data: [{ name: 'Waiver' }], pagination: { total: 2 } });
    const audit = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, row.id)).orderBy(auditEvents.action));
    expect(audit.map(a => a.action)).toEqual(['billing.discount.created', 'billing.discount.updated']);
    expect(audit[0]).toMatchObject({ occurredAt: clock.now(), actorKind: 'system', after: row });
    expect(audit[1]).toMatchObject({ before: row, after: off });
  });
  it('merges partial edits under a revision check and validates the combined terms', async () => {
    const f = await fixture(), row = await f.service.create(f.context, f.input);
    await expect(f.service.update(f.context, row.id, { revision: 1, amountCents: 500 })).rejects.toMatchObject({ code: 'invalid_request',
      message: 'Choose a percentage or an amount.' });
    const fixed = await f.service.update(f.context, row.id, { revision: 1, percentBasisPoints: null, amountCents: 500, duration: 'cycles', cycles: 3 });
    expect(fixed).toMatchObject({ amountCents: 500, percentBasisPoints: null, duration: 'cycles', cycles: 3, revision: 2 });
    await expect(f.service.update(f.context, row.id, { revision: 1, name: 'Stale' })).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(f.service.update(f.context, row.id, { revision: 2, duration: 'once' })).rejects.toThrow();
    const waiver = await f.service.update(f.context, row.id, { revision: 2, amountCents: null, duration: null, cycles: null, waivesSignupFee: true });
    expect(waiver).toMatchObject({ amountCents: null, duration: null, cycles: null, waivesSignupFee: true, revision: 3 });
  });
  it('keeps terms locked after any use, including ended applications, while allowing metadata and plan edits', async () => {
    const f = await fixture(), row = await f.service.create(f.context, f.input), nextPlan = await factory('plans', f.gymId);
    const snapshot = await factory('membershipDiscounts', f.gymId, { discountId: row.id, name: row.name, planIds: [f.plan.id],
      endedAt: clock.now(), endReason: 'removed' });
    for (const changes of [
      { percentBasisPoints: 2000 }, { percentBasisPoints: null, amountCents: 500 }, { waivesSignupFee: true },
      { duration: 'once' as const }, { duration: 'cycles' as const, cycles: 2 },
    ]) await expect(f.service.update(f.context, row.id, { revision: 1, ...changes })).rejects.toMatchObject({ code: 'conflict',
      message: expect.stringContaining('has been used') });
    const edited = await f.service.update(f.context, row.id, { revision: 1, name: 'Renamed', code: 'NEW-CODE', endsOn: '2026-12-31',
      planIds: [nextPlan.id], maxUses: 10, active: false });
    expect(edited).toMatchObject({ name: 'Renamed', endsOn: '2026-12-31', planIds: [nextPlan.id], revision: 2 });
    expect(await db.forGym(f.gymId, tx => tx.select().from(membershipDiscounts).where(eq(membershipDiscounts.id, snapshot.id)))).toEqual([snapshot]);
    expect(await f.service.update(f.context, row.id, { revision: 2, percentBasisPoints: row.percentBasisPoints })).toMatchObject({ revision: 3 });
  });
  it('refuses lowering max uses below reserved uses and never exposes a way to change uses', async () => {
    const f = await fixture(), row = await f.service.create(f.context, { ...f.input, maxUses: 3 });
    await db.forGym(f.gymId, tx => tx.update(discounts).set({ uses: 2 }).where(eq(discounts.id, row.id)));
    await expect(f.service.update(f.context, row.id, { revision: 1, maxUses: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.service.update(f.context, row.id, { revision: 1, maxUses: 2 })).toMatchObject({ maxUses: 2, uses: 2 });
    expect(await f.service.update(f.context, row.id, { revision: 2, maxUses: null })).toMatchObject({ maxUses: null, uses: 2 });
  });
  it('reports historical terms locks after all uses are released in reads and metadata updates', async () => {
    const f = await fixture(), row = await f.service.create(f.context, f.input);
    const unused = await f.service.create(f.context, { ...f.input, name: 'Unused', code: null });
    await db.forGym(f.gymId, tx => tx.update(discounts).set({ uses: 1 }).where(eq(discounts.id, row.id)));
    await factory('membershipDiscounts', f.gymId, { discountId: row.id, endedAt: clock.now(), endReason: 'released' });
    await db.forGym(f.gymId, tx => tx.update(discounts).set({ uses: 0 }).where(eq(discounts.id, row.id)));
    expect(await f.service.get(f.gymId, row.id)).toMatchObject({ uses: 0, termsLocked: true });
    expect(await f.service.get(f.gymId, unused.id)).toMatchObject({ uses: 0, termsLocked: false });
    expect((await f.service.list(f.gymId, {})).data).toEqual([
      { ...row, termsLocked: true }, unused,
    ]);
    expect(await f.service.update(f.context, row.id, { revision: 1, name: 'Renamed' })).toMatchObject({ uses: 0, termsLocked: true });
    await expect(f.service.update(f.context, row.id, { revision: 2, percentBasisPoints: 2000 })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('maps name and code collisions, including concurrent creates, to conflicts and rolls back links and audits', async () => {
    const f = await fixture(), first = await f.service.create(f.context, f.input);
    for (const input of [{ ...f.input, name: 'family', code: null }, { ...f.input, name: 'Other', code: 'family' }])
      await expect(f.service.create(f.context, input)).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('name or code') });
    const second = await f.service.create(f.context, { ...f.input, name: 'Other', code: 'OTHER' });
    await expect(f.service.update(f.context, second.id, { revision: 1, name: 'FAMILY', planIds: [] })).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.service.get(f.gymId, second.id)).toEqual(second);
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, eq(auditEvents.targetId, second.id)))).toBe(1);
    const outcomes = await Promise.allSettled([1, 2].map(() => f.service.create(f.context, { ...f.input, name: 'Concurrent', code: 'CONCURRENT' })));
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect(await f.service.get(f.gymId, first.id)).toEqual(first);
  });
  it('isolates foreign discounts, rejects foreign plan links atomically, and allows all plans with an empty list', async () => {
    const f = await fixture(), other = await fixture(), own = await f.service.create(f.context, f.input);
    const foreign = await other.service.create(other.context, other.input);
    await expect(f.service.get(f.gymId, foreign.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.update(f.context, foreign.id, { revision: 1, name: 'Attack' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.create(f.context, { ...f.input, name: 'Attack', code: null, planIds: [other.plan.id] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.update(f.context, own.id, { revision: 1, planIds: [other.plan.id] })).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.service.get(f.gymId, own.id)).toEqual(own);
    expect((await f.service.list(f.gymId, {})).data.map(d => d.id)).toEqual([own.id]);
    const upper = await f.service.update(f.context, own.id, { revision: 1, planIds: [f.plan.id.toUpperCase(), f.plan.id] });
    expect(upper.planIds).toEqual([f.plan.id]);
    expect(await f.service.get(f.gymId, own.id)).toEqual(upper);
    expect(await f.service.update(f.context, own.id, { revision: 2, planIds: [] })).toMatchObject({ planIds: [] });
    expect(await db.forGym(f.gymId, tx => tx.select().from(discountPlans).where(eq(discountPlans.discountId, own.id)))).toEqual([]);
  });
  it('enforces the gym currency and validates amount-only edits against its charge step', async () => {
    const f = await fixture('ISK');
    await expect(f.service.create(f.context, { ...f.input, currency: 'USD' })).rejects.toMatchObject({ code: 'conflict' });
    const row = await f.service.create(f.context, { ...f.input, percentBasisPoints: null, amountCents: 100 });
    await expect(f.service.update(f.context, row.id, { revision: 1, amountCents: 101 })).rejects.toThrow();
    await expect(f.service.update(f.context, row.id, { revision: 1, currency: 'USD' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.service.get(f.gymId, row.id)).toEqual(row);
  });
  it('serializes concurrent saves so only one revision and one audit advance', async () => {
    const f = await fixture(), row = await f.service.create(f.context, f.input);
    const outcomes = await Promise.allSettled(['First', 'Second'].map(name => f.service.update(f.context, row.id, { revision: 1, name })));
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.any(RevisionConflictError) });
    expect(await db.forGym(f.gymId, tx => tx.$count(auditEvents, and(eq(auditEvents.targetId, row.id), eq(auditEvents.action, 'billing.discount.updated'))))).toBe(1);
  });
});
