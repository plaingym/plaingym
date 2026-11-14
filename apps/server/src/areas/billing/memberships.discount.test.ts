// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, discounts, households, invoiceLineItems, membershipDiscounts, uuidv7 } from '@plaingym/db';
// Historical/corrupt fixtures need maintenance access; production audits remain append-only.
// eslint-disable-next-line no-restricted-imports, database/system-tables -- Test-only fixture setup for immutable audit history.
import { openConnection } from '@plaingym/db/client';
import type { StaffRole } from '@plaingym/shared';
import type { CreateDiscountRequest } from '@plaingym/shared/contracts';
import { createApp } from '../../app.js';
import { authorize } from '../staff/auth.permissions.js';
import { createDiscountCatalogService } from './discounts/catalog.js';
import { createMembershipService } from './memberships.js';
import { createMembershipRoutes } from './memberships.routes.js';
import { useRunnerFixture } from './runner/runner.fixture.test-helper.js';

const { db, factory, fixture } = useRunnerFixture();
async function rewriteAuditFixture(gymId: string, id: string, after: Record<string, unknown>) {
  const maintenance = openConnection(db.maintenanceUrl, 1);
  try {
    await maintenance.db.update(auditEvents).set({ after }).where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.id, id)));
  } finally { await maintenance.close(); }
}
async function setup() {
  const f = await fixture(), service = createMembershipService(f.serviceOptions);
  const catalog = createDiscountCatalogService(f.serviceOptions);
  const user = await factory('authUser', f.gymId);
  const context = { gymId: f.gymId, actor: { kind: 'user' as const, userId: user.id } };
  const get = () => service.get(f.gymId, f.membership.id);
  const create = (overrides: Partial<CreateDiscountRequest> = {}) => catalog.create(context, {
    name: 'Discount ' + uuidv7(), currency: 'CAD', percentBasisPoints: 5_000, duration: 'cycles', cycles: 3, ...overrides,
  });
  const set = async (discountId: string) => service.setDiscount(context, f.membership.id, { revision: (await get()).revision, discount: { discountId } });
  const remove = async () => service.removeDiscount(context, f.membership.id, { revision: (await get()).revision });
  const state = () => db.forGym(f.gymId, async tx => ({ applications: await tx.select().from(membershipDiscounts), discounts: await tx.select().from(discounts) }));
  async function daily(date: string) { f.clock.set(date + 'T17:00:00Z'); await f.runner.daily(f.gymId); }
  const change = async (planId: string, timing: 'now' | 'next_billing_date') => service.switchPlan(context, {
    membershipId: f.membership.id, revision: (await get()).revision, requestId: uuidv7(), planId, timing,
  });
  const preview = (planId: string, timing: 'now' | 'next_billing_date') => service.previewSwitch(f.gymId, f.membership.id, { planId, timing });
  async function call(method: string, body: unknown, role: StaffRole = 'owner', membershipId = f.membership.id) {
    const app = createApp({ clock: f.clock, skipSetup: true, authorize, contributions: { routes: createMembershipRoutes(service) },
      resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: f.gymId, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next(); },
      session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal: { kind: 'staff', gymId: f.gymId, userId: user.id, roles: [role] } }); await next(); },
    });
    return app.request(`https://gym.invalid/api/billing/memberships/${membershipId}/discount`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  return { ...f, service, catalog, context, get, create, set, remove, state, daily, change, preview, call };
}

describe('editing a live membership discount', () => {
  it('cancellation ends the application without returning its use and preserves the before snapshot in the audit', async () => {
    const f = await setup(), discount = await f.create(), before = await f.set(discount.id);
    const after = await f.service.cancel(f.context, { membershipId: before.id, revision: before.revision });
    expect(after.discount).toBeNull();
    expect((await f.state()).applications[0]).toMatchObject({ endReason: 'removed', cyclesLeft: 3 });
    expect((await f.state()).discounts[0]!.uses).toBe(1);
    expect((await f.read()).audits.find(row => row.action === 'billing.membership.cancelled')).toMatchObject({
      before: { discount: { discountId: discount.id } }, after: { discount: null },
    });
  });
  it.each(['add', 'replace', 'remove'] as const)('%s changes only the next invoice and audits the revision and history', async operation => {
    const f = await setup(), original = await f.create(), replacement = await f.create({ percentBasisPoints: 2_000, code: 'SAVE-20' });
    if (operation !== 'add') await f.set(original.id);
    await f.daily('2028-03-01');
    const billed = await f.read(), before = await f.get();
    f.clock.set('2028-03-16T17:00:00Z');
    const after = operation === 'remove' ? await f.remove() : await f.service.setDiscount(f.context, before.id, {
      revision: before.revision, discount: operation === 'replace' ? { code: 'sAvE-20' } : { discountId: replacement.id },
    });
    expect(after.revision).toBe(before.revision + 1);
    if (operation === 'remove') expect(after.discount).toBeNull();
    else expect(after.discount).toMatchObject({ discountId: replacement.id, cyclesLeft: 3 });
    const edited = await f.read();
    expect(edited.invoices).toEqual(billed.invoices); expect(edited.lines).toEqual(billed.lines); expect(edited.attempts).toEqual(billed.attempts);
    const history = await f.state();
    if (operation !== 'add') expect(history.applications.find(row => row.discountId === original.id)).toMatchObject({
      cyclesLeft: 2, endReason: operation === 'replace' ? 'replaced' : 'removed', endedAt: f.clock.now(),
    });
    expect(history.discounts.find(row => row.id === original.id)!.uses).toBe(operation === 'add' ? 0 : 1);
    expect(edited.audits.filter(row => row.action === (operation === 'remove' ? 'billing.membership.discount_removed' : 'billing.membership.discount_set')))
      .toContainEqual(expect.objectContaining({ actorUserId: f.context.actor.userId, before: expect.objectContaining({ revision: before.revision }),
        after: expect.objectContaining({ revision: after.revision }) }));
    await f.daily('2028-04-01');
    const april = (await f.read()).invoices.find(row => row.dueOn === '2028-04-01')!;
    expect(april.amountCents).toBe(operation === 'remove' ? 10_000 : 8_000);
  });

  it('a failed replacement preserves the old application, uses and membership revision', async () => {
    const f = await setup(), discount = await f.create({ maxUses: 1 });
    const before = await f.set(discount.id), state = await f.state(), audit = (await f.read()).audits;
    await expect(f.set(discount.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['discount_used_up'] } });
    expect(await f.get()).toEqual(before); expect(await f.state()).toEqual(state); expect((await f.read()).audits).toEqual(audit);
  });

  it('refuses a signup-fee-only discount without ending the live one or taking a use', async () => {
    const f = await setup(), discount = await f.create(), waiver = await f.create({ percentBasisPoints: undefined, duration: undefined,
      cycles: undefined, waivesSignupFee: true });
    const before = await f.set(discount.id), state = await f.state();
    await expect(f.set(waiver.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.get()).toEqual(before); expect(await f.state()).toEqual(state);
  });

  it('reapplying the same discount is a fresh use and concurrent stale revisions commit only once', async () => {
    const f = await setup(), discount = await f.create(), before = await f.set(discount.id);
    const request = { revision: before.revision, discount: { discountId: discount.id } };
    const results = await Promise.allSettled([f.service.setDiscount(f.context, before.id, request), f.service.removeDiscount(f.context, before.id, { revision: before.revision })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }]);
    const row = await f.get();
    if (!row.discount) await f.set(discount.id);
    else expect((await f.state()).applications).toHaveLength(2);
    expect((await f.state()).discounts[0]!.uses).toBe(2);
  });

  it.each(['owner', 'admin', 'coach', 'front_desk'] as const)('enforces plans.manage for %s on both routes', async role => {
    const f = await setup(), discount = await f.create(), allowed = role === 'owner' || role === 'admin';
    expect((await f.call('PUT', { revision: (await f.get()).revision, discount: { discountId: discount.id } }, role)).status).toBe(allowed ? 200 : 403);
    expect((await f.call('DELETE', { revision: (await f.get()).revision }, role)).status).toBe(allowed ? 200 : 403);
  });

  it('rejects stale revisions and foreign membership or discount IDs on the routes', async () => {
    const f = await setup(), other = await setup(), discount = await f.create(), foreign = await other.create();
    const before = await f.set(discount.id);
    for (const method of ['PUT', 'DELETE']) {
      const discountBody = method === 'PUT' ? { discount: { discountId: discount.id } } : {};
      expect((await f.call(method, { revision: before.revision - 1, ...discountBody })).status).toBe(409);
      expect((await f.call(method, { revision: 1, ...discountBody }, 'owner', other.membership.id)).status).toBe(404);
    }
    expect((await f.call('PUT', { revision: before.revision, discount: { discountId: foreign.id } })).status).toBe(404);
    expect(await f.get()).toEqual(before);
    expect((await other.state()).discounts[0]!.uses).toBe(0);
  });
});

describe('discounts through plan switches', () => {
  it('does not label malformed billed discount terms as an unbilled period', async () => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    await f.set((await f.create()).id); await f.daily('2028-03-01');
    const line = (await f.read()).lines.find(row => row.kind === 'membership')!;
    await db.forGym(f.gymId, tx => tx.update(invoiceLineItems).set({ billedDiscount: { ...line.billedDiscount!, name: ' ' } })
      .where(eq(invoiceLineItems.id, line.id)));
    f.clock.set('2028-03-16T17:00:00Z');
    await expect(f.preview(plan.id, 'now')).rejects.toBeInstanceOf(RangeError);
  });
  it('resolves the live application at scheduled execution after a staff replacement', async () => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    await f.set((await f.create()).id); await f.daily('2028-03-01');
    await f.change(plan.id, 'next_billing_date');
    const replacement = await f.create({ planIds: [f.plan.id], percentBasisPoints: 2_000 });
    f.clock.set('2028-03-16T17:00:00Z'); await f.set(replacement.id);
    expect((await f.preview(plan.id, 'next_billing_date')).discount).toBe('ended');
    await f.daily('2028-04-01');
    expect((await f.get()).discount).toBeNull();
    expect((await f.state()).applications.find(row => row.discountId === replacement.id)).toMatchObject({ cyclesLeft: 3, endReason: 'switch' });
    expect((await f.read()).invoices.find(row => row.dueOn === '2028-04-01')!.amountCents).toBe(20_000);
  });

  it('a discount added after billing affects only the new side, including a second upgrade at the same instant', async () => {
    const f = await setup(), first = await factory('plans', f.gymId, { amountCents: 20_000 }), second = await factory('plans', f.gymId, { amountCents: 30_000 });
    await f.daily('2028-03-01'); await f.daily('2028-04-01'); f.clock.set('2028-04-16T17:00:00Z');
    const discount = await f.create({ percentBasisPoints: 2_000 }); await f.set(discount.id);
    const one = await f.change(first.id, 'now'), two = await f.change(second.id, 'now');
    const state = await f.read();
    expect(state.invoices.find(row => row.id === one.invoiceId)!.amountCents).toBe(3_000);
    expect(state.invoices.find(row => row.id === two.invoiceId)!.amountCents).toBe(4_000);
    expect((await f.get()).discount).toMatchObject({ cyclesLeft: 3 });
  });

  it('credits the billed price after an upgrade followed by an immediate downgrade to the original plan', async () => {
    const f = await setup(), premium = await factory('plans', f.gymId, { amountCents: 20_000 }), highest = await factory('plans', f.gymId, { amountCents: 30_000 });
    await f.set((await f.create()).id); await f.daily('2028-03-01'); await f.daily('2028-04-01');
    f.clock.set('2028-04-16T17:00:00Z');
    const first = await f.change(premium.id, 'now'); await f.change(f.plan.id, 'now');
    expect(await f.get()).toMatchObject({ planId: f.plan.id, amountCents: 20_000 });
    const next = await f.change(highest.id, 'now'), state = await f.read();
    expect(state.invoices.find(row => row.id === first.invoiceId)!.amountCents).toBe(2_500);
    expect(state.invoices.find(row => row.id === next.invoiceId)!.amountCents).toBe(2_500);
    expect((await f.get()).discount).toMatchObject({ cyclesLeft: 1 });
  });

  it('credits the stored line without an issuance audit snapshot or application timestamp fallback', async () => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    f.clock.set('2028-02-28T17:00:00Z'); await f.set((await f.create()).id);
    await f.daily('2028-03-01');
    const issued = (await f.read()).audits.find(row => row.action === 'billing.invoice.issued')!;
    const legacy = Object.fromEntries(Object.entries(issued.after as Record<string, unknown>).filter(([key]) => key !== 'membershipPricing'));
    // Issuance audit shape and mutable application history are no longer the source of billed terms.
    await rewriteAuditFixture(f.gymId, issued.id, legacy);
    f.clock.set('2028-03-16T17:00:00Z'); await f.remove();
    expect((await f.preview(plan.id, 'now')).proration!.totalCents).toBe(7_742);
  });

  it('keeps a 100 percent discount through two zero-invoice upgrades at the same instant', async () => {
    const f = await setup(), first = await factory('plans', f.gymId, { amountCents: 20_000 }), second = await factory('plans', f.gymId, { amountCents: 30_000 });
    await f.set((await f.create({ percentBasisPoints: 10_000, duration: 'forever', cycles: undefined })).id);
    await f.daily('2028-03-01'); f.clock.set('2028-03-16T17:00:00Z');
    expect((await f.change(first.id, 'now')).invoiceId).toBeNull();
    expect((await f.preview(second.id, 'now')).proration!.totalCents).toBe(0);
    expect((await f.change(second.id, 'now')).invoiceId).toBeNull();
    expect((await f.get()).amountCents).toBe(30_000);
    expect((await f.read()).invoices).toHaveLength(1);
  });

  it('uses a zero-invoice upgrade audit when the older bill has no recoverable stored terms', async () => {
    const f = await setup(), first = await factory('plans', f.gymId, { amountCents: 20_000 }), second = await factory('plans', f.gymId, { amountCents: 30_000 });
    await f.set((await f.create({ percentBasisPoints: 10_000, duration: 'forever', cycles: undefined })).id);
    await f.daily('2028-03-01'); f.clock.set('2028-03-16T17:00:00Z');
    expect((await f.change(first.id, 'now')).invoiceId).toBeNull();
    await db.forGym(f.gymId, tx => tx.update(invoiceLineItems).set({ billedUnitAmountCents: null, billedDiscount: null })
      .where(eq(invoiceLineItems.membershipId, f.membership.id)));
    expect((await f.preview(second.id, 'now')).proration!.totalCents).toBe(0);
    expect((await f.change(second.id, 'now')).invoiceId).toBeNull();
  });

  it('refuses unknown legacy terms without trying the old issuance audit at quote time', async () => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    await f.daily('2028-03-01');
    await db.forGym(f.gymId, tx => tx.update(invoiceLineItems).set({ billedUnitAmountCents: null, billedDiscount: null })
      .where(eq(invoiceLineItems.membershipId, f.membership.id)));
    f.clock.set('2028-03-16T17:00:00Z');
    await expect(f.preview(plan.id, 'now')).rejects.toMatchObject({ code: 'conflict', details: { reason: ['period_not_billed'] } });
  });

  it('stores assignment-time discount terms even when assignment and issuance share an instant and the audit has no snapshot', async () => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    const discount = await f.create({ duration: 'once', cycles: undefined });
    const service = createMembershipService({ ...f.serviceOptions, onAssigned: f.runner.onAssigned });
    const member = await factory('members', f.gymId, { householdId: f.home.id });
    const assigned = await service.assign(f.context, { id: uuidv7(), householdId: f.home.id, memberId: member.id, planId: f.plan.id,
      startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now', initialStatus: 'active', discount: { discountId: discount.id } });
    const line = (await f.read()).lines.find(row => row.membershipId === assigned.id && row.kind === 'membership')!;
    expect(line).toMatchObject({ billedUnitAmountCents: 10_000, billedDiscount: { discountId: discount.id, cyclesLeft: 1 } });
    const issued = (await f.read()).audits.find(row => row.action === 'billing.invoice.issued' && row.targetId === line.invoiceId)!;
    await rewriteAuditFixture(f.gymId, issued.id, {});
    await f.daily('2028-03-01'); f.clock.set('2028-03-16T17:00:00Z');
    expect((await service.previewSwitch(f.gymId, assigned.id, { planId: plan.id, timing: 'now' })).proration!.totalCents).toBe(7_742);
  });

  it.each(['now', 'next_billing_date'] as const)('a %s switch keeps the snapshotted eligibility and remaining cycles after catalog edits', async timing => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    const discount = await f.create({ planIds: [f.plan.id, plan.id] });
    await f.set(discount.id); await f.daily('2028-03-01');
    await f.catalog.update(f.context, discount.id, { revision: (await f.catalog.get(f.gymId, discount.id)).revision, planIds: [f.plan.id], active: false });
    f.clock.set('2028-03-16T17:00:00Z');
    expect((await f.preview(plan.id, timing)).discount).toBe('kept');
    const switched = await f.change(plan.id, timing);
    expect(switched.membership.discount).toMatchObject({ discountId: discount.id, cyclesLeft: 2 });
    await f.daily('2028-04-01');
    expect((await f.read()).invoices.find(row => row.dueOn === '2028-04-01')!.amountCents).toBe(10_000);
    expect((await f.get()).discount).toMatchObject({ discountId: discount.id, cyclesLeft: 1 });
    expect((await f.state()).discounts[0]!.uses).toBe(1);
  });

  it.each(['now', 'next_billing_date'] as const)('a %s switch ends an ineligible snapshot even if the catalog now allows the plan', async timing => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    const discount = await f.create({ planIds: [f.plan.id] });
    await f.set(discount.id); await f.daily('2028-03-01');
    await f.catalog.update(f.context, discount.id, { revision: (await f.catalog.get(f.gymId, discount.id)).revision, planIds: [] });
    f.clock.set('2028-03-16T17:00:00Z');
    expect((await f.preview(plan.id, timing)).discount).toBe('ended');
    const result = await f.change(plan.id, timing);
    expect(result.membership.discount === null).toBe(timing === 'now');
    await f.daily('2028-04-01');
    expect((await f.get()).discount).toBeNull();
    expect((await f.state()).applications[0]).toMatchObject({ endReason: 'switch', cyclesLeft: 2 });
    expect((await f.read()).invoices.find(row => row.dueOn === '2028-04-01')!.amountCents).toBe(20_000);
  });

  it.each([
    { name: 'percentage kept', fixed: false, kept: true },
    { name: 'fixed kept', fixed: true, kept: true },
    { name: 'percentage ended', fixed: false, kept: false },
  ])('an upgrade now prices $name against the billed discount before the family discount', async ({ fixed, kept }) => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    await db.forGym(f.gymId, tx => tx.update(households).set({ familyDiscountBasisPoints: 1_000 }).where(eq(households.id, f.home.id)));
    const discount = await f.create({ ...(fixed ? { percentBasisPoints: undefined, amountCents: 3_000 } : { percentBasisPoints: 3_000 }),
      planIds: kept ? [] : [f.plan.id] });
    await f.set(discount.id); await f.daily('2028-03-01');
    const original = await f.read();
    // Exactly half the 30-day April period, avoiding rounding in the expected arithmetic.
    await f.daily('2028-04-01'); f.clock.set('2028-04-16T17:00:00Z');
    const quote = await f.preview(plan.id, 'now');
    // Kept 30%: (14000 - 7000)/2 * .9 = 3150; kept fixed: (17000 - 7000)/2 * .9 = 4500.
    // Ended 30%: (20000 - 7000)/2 * .9 = 5850.
    const expected = fixed ? 4_500 : kept ? 3_150 : 5_850;
    expect(quote.proration!.totalCents).toBe(expected);
    const result = await f.change(plan.id, 'now');
    expect((await f.read()).invoices.find(row => row.id === result.invoiceId)!.amountCents).toBe(expected);
    expect((await f.get()).discount?.cyclesLeft ?? null).toBe(kept ? 1 : null);
    expect((await f.read()).invoices.find(row => row.id === original.invoices[0]!.id)).toEqual(original.invoices[0]);
  });

  it.each(['replace', 'remove', 'completed'] as const)('credits the invoice snapshot after the billed discount is %s', async operation => {
    const f = await setup(), plan = await factory('plans', f.gymId, { amountCents: 20_000 });
    const discount = await f.create({ ...(operation === 'completed' ? { duration: 'once', cycles: undefined } : {}) });
    await f.set(discount.id); await f.daily('2028-03-01'); f.clock.set('2028-03-16T17:00:00Z');
    if (operation === 'replace') await f.set((await f.create({ percentBasisPoints: 2_000 })).id);
    if (operation === 'remove') await f.remove();
    const quote = await f.preview(plan.id, 'now');
    // Current cycle billed 5000. New effective price is 16000 after replacement, otherwise 20000.
    expect(quote.proration!.totalCents).toBe(operation === 'replace' ? 5_677 : 7_742);
    const result = await f.change(plan.id, 'now');
    expect((await f.read()).invoices.find(row => row.id === result.invoiceId)!.amountCents).toBe(quote.proration!.totalCents);
  });
});
