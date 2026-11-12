// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { discounts, discountPlans, membershipDiscounts } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useTestDatabase } from './testing/database.js';
import { createFactories } from './testing/factories.js';

const db = useTestDatabase(), factory = createFactories(db), gymA = uuidv7(), gymB = uuidv7();
const rejected = (code: string) => ({ cause: { code } });
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });
describe('discount storage constraints', () => {
  it.each([
    { percentBasisPoints: 0 }, { percentBasisPoints: 10001 }, { amountCents: 500 },
    { percentBasisPoints: null, amountCents: 0 }, { percentBasisPoints: null, duration: null },
    { percentBasisPoints: null, waivesSignupFee: true }, { duration: null },
    { duration: 'cycles' }, { duration: 'cycles', cycles: 0 }, { cycles: 2 },
    { uses: -1 }, { maxUses: 0 }, { maxUses: 1, uses: 2 }, { revision: 0 },
    { name: '' }, { name: ' ' }, { name: 'x'.repeat(101) }, { code: 'AB' }, { code: 'A_B' }, { code: 'x'.repeat(41) },
  ])('rejects invalid catalog terms %j', async fields => {
    await expect(factory('discounts', gymA, fields)).rejects.toMatchObject(rejected('23514'));
  });
  it('accepts all supported prices, durations and waiver-only terms', async () => {
    for (const fields of [
      { percentBasisPoints: 1, duration: 'once' }, { percentBasisPoints: 10000 },
      { percentBasisPoints: null, amountCents: 500, duration: 'cycles', cycles: 3 },
      { percentBasisPoints: null, duration: null, waivesSignupFee: true },
    ]) await factory('discounts', gymA, fields);
  });
  it('enforces case-insensitive names and codes per gym and releases a cleared code', async () => {
    const name = 'Family ' + uuidv7(), code = 'S-' + uuidv7();
    const row = await factory('discounts', gymA, { name, code });
    await expect(factory('discounts', gymA, { name: name.toUpperCase() })).rejects.toMatchObject(rejected('23505'));
    await expect(factory('discounts', gymA, { code: code.toLowerCase() })).rejects.toMatchObject(rejected('23505'));
    await factory('discounts', gymB, { name: name.toUpperCase(), code: code.toLowerCase() });
    await db.forGym(gymA, tx => tx.update(discounts).set({ code: null }).where(eq(discounts.id, row.id)));
    await factory('discounts', gymA, { code });
  });
  it('refuses cross-gym references, foreign households and duplicate plan links', async () => {
    const foreignPlan = await factory('plans', gymB), foreignDiscount = await factory('discounts', gymB);
    const membership = await factory('memberships', gymB), own = await factory('memberships', gymA);
    const otherHousehold = await factory('households', gymA);
    for (const create of [
      () => factory('discountPlans', gymA, { planId: foreignPlan.id }),
      () => factory('discountPlans', gymA, { discountId: foreignDiscount.id }),
      () => factory('membershipDiscounts', gymA, { discountId: foreignDiscount.id }),
      () => factory('membershipDiscounts', gymA, { householdId: membership.householdId, membershipId: membership.id }),
      () => factory('membershipDiscounts', gymA, { householdId: otherHousehold.id, membershipId: own.id }),
      () => factory('discounts', gymA, { currency: 'EUR' }),
      () => factory('membershipDiscounts', gymA, { currency: 'EUR' }),
    ]) await expect(create()).rejects.toMatchObject(rejected('23503'));
    const link = await factory('discountPlans', gymA);
    await expect(factory('discountPlans', gymA, { discountId: link.discountId, planId: link.planId })).rejects.toMatchObject(rejected('23505'));
  });
  it('allows only one live application per membership and retains ended history', async () => {
    const row = await factory('membershipDiscounts', gymA);
    const fields = { householdId: row.householdId, membershipId: row.membershipId };
    await expect(factory('membershipDiscounts', gymA, fields)).rejects.toMatchObject(rejected('23505'));
    await db.forGym(gymA, tx => tx.update(membershipDiscounts).set({ endedAt: new Date('2026-11-12T12:00:00Z'), endReason: 'removed' })
      .where(eq(membershipDiscounts.id, row.id)));
    await factory('membershipDiscounts', gymA, fields);
  });
  it.each([
    { percentBasisPoints: null, duration: null }, { amountCents: 1 }, { duration: 'once', cyclesLeft: null },
    { duration: 'once', cyclesLeft: 2 }, { duration: 'cycles', cyclesLeft: -1 }, { cyclesLeft: 1 },
    { endReason: 'removed' }, { endedAt: new Date('2026-11-12T00:00:00Z') },
    { endedAt: new Date('2026-01-01T00:00:00Z'), endReason: 'removed' },
    { endedAt: new Date('2026-11-12T00:00:00Z'), endReason: 'invalid' },
  ])('rejects invalid snapshot terms %j', async fields => {
    await expect(factory('membershipDiscounts', gymA, fields)).rejects.toMatchObject(rejected('23514'));
  });
  it.each([['discounts', discounts], ['discountPlans', discountPlans], ['membershipDiscounts', membershipDiscounts]] as const)(
  'isolates %s in gym, missing and system contexts', async (name, table) => {
    const row = await factory(name, gymB), where = eq(table.id, row.id);
    expect(await db.forGym(gymB, tx => tx.select().from(table).where(where))).toHaveLength(1);
    expect(await db.forGym(gymA, tx => tx.select().from(table).where(where))).toEqual([]);
    expect(await db.app.db.select().from(table).where(where)).toEqual([]);
    expect(await db.forSystem(tx => tx.select().from(table).where(where))).toEqual([]);
    expect(await db.forGym(gymA, tx => tx.update(table).set({ createdAt: new Date(0) }).where(where).returning())).toEqual([]);
    expect(await db.forGym(gymA, tx => tx.delete(table).where(where).returning())).toEqual([]);
    await expect(db.forGym(gymA, tx => tx.insert(table).values({ ...row, id: uuidv7() }))).rejects.toMatchObject(rejected('42501'));
  });
});
