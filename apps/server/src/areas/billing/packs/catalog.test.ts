// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, classPackTaxRates, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createCatalogService } from '../catalog.js';
import { createPackCatalogService } from './catalog.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-10T12:00:00Z');
async function fixture(currency = 'CAD') {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency });
  const user = await factory('authUser', gymId), tax = await factory('taxRates', gymId);
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const options = { scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }) };
  const service = createPackCatalogService(options), catalog = createCatalogService(options);
  const input = { name: 'Ten classes', amountCents: 10000, currency, credits: 10, taxRateIds: [tax.id] };
  return { gymId, tax, context, service, catalog, input };
}

describe('pack catalog', () => {
  it('creates, edits, archives, lists archived and restores with atomic actor and time audits', async () => {
    const f = await fixture(), pack = await f.service.create(f.context, { ...f.input, expiryDays: 90 });
    expect(pack).toMatchObject({ revision: 1, active: true, credits: 10, expiryDays: 90, createdAt: clock.now().toISOString(), taxRateIds: [f.tax.id] });
    const edited = await f.service.update(f.context, pack.id, { revision: 1, credits: 20, amountCents: 15000, expiryDays: null, taxRateIds: [] });
    expect(edited).toMatchObject({ revision: 2, credits: 20, expiryDays: null, taxRateIds: [] });
    await expect(f.service.update(f.context, pack.id, { revision: 1, name: 'Stale' })).rejects.toMatchObject({ name: 'RevisionConflictError' });
    await f.service.update(f.context, pack.id, { revision: 2, active: false });
    expect((await f.service.list(f.gymId, {})).data).toMatchObject([{ id: pack.id, active: false }]);
    expect((await f.service.list(f.gymId, { active: 'true' })).data).toEqual([]);
    expect((await f.service.list(f.gymId, { active: 'false', currency: 'CAD' })).pagination.total).toBe(1);
    expect((await f.service.list(f.gymId, { currency: 'EUR' })).data).toEqual([]);
    expect((await f.service.list(f.gymId, { limit: 1, offset: 1 })).data).toEqual([]);
    await f.service.update(f.context, pack.id, { revision: 3, active: true });
    expect((await f.service.get(f.gymId, pack.id)).revision).toBe(4);
    const events = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, pack.id)));
    expect(events).toHaveLength(4);
    for (const event of events) expect(event).toMatchObject({ actorKind: 'user', actorUserId: f.context.actor.userId,
      occurredAt: clock.now(), targetType: 'class_pack' });
    expect(events.find(event => event.action === 'billing.class_pack.created')?.after).toMatchObject({ credits: 10, expiryDays: 90 });
  });
  it('rejects foreign resources, taxes and currency without committing a change or audit', async () => {
    const f = await fixture(), other = await fixture(), pack = await other.service.create(other.context, other.input);
    await expect(f.service.get(f.gymId, pack.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.update(f.context, pack.id, { revision: 1, name: 'Foreign' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.create(f.context, { ...f.input, taxRateIds: [other.tax.id] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.create(f.context, { ...f.input, currency: 'EUR' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.service.list(f.gymId, {})).data).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).toEqual([]);
  });
  it.each([['KWD', 1251, 1250], ['ISK', 501, 500], ['JPY', 101, 101]] as const)('checks %s price steps on create and amount-only update', async (currency, invalid, valid) => {
      const f = await fixture(currency);
      if (invalid !== valid) await expect(f.service.create(f.context, { ...f.input, amountCents: invalid })).rejects.toThrow();
      const pack = await f.service.create(f.context, { ...f.input, amountCents: valid });
      if (invalid !== valid) await expect(f.service.update(f.context, pack.id, { revision: 1, amountCents: invalid })).rejects.toMatchObject({ code: 'invalid_request' });
      expect(await f.service.update(f.context, pack.id, { revision: 1, amountCents: valid })).toMatchObject({ amountCents: valid, revision: 2 });
    });
  it('serializes simultaneous revisions so only one edit and audit commit', async () => {
    const f = await fixture(), pack = await f.service.create(f.context, f.input);
    const results = await Promise.allSettled(['First', 'Second'].map(name => f.service.update(f.context, pack.id, { revision: 1, name })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, pack.id)))).toHaveLength(2);
  });
});

describe('tax archive integration', () => {
  it('counts active and archived packs, refuses archive and detaches all pack links on confirmation', async () => {
    const f = await fixture(), other = await fixture();
    const active = await f.service.create(f.context, f.input);
    const archived = await f.service.create(f.context, { ...f.input, name: 'Archived', active: false });
    await other.service.create(other.context, other.input);
    expect(await f.catalog.getTaxRateUsage(f.gymId, f.tax.id)).toEqual({ chargeTypes: [], plans: [], memberships: 0,
      packs: [{ id: archived.id, name: 'Archived', active: false }, { id: active.id, name: active.name, active: true }] });
    await expect(f.catalog.updateTaxRate(f.context, f.tax.id, { revision: 1, active: false }))
      .rejects.toMatchObject({ code: 'conflict', details: { packs: ['Archived', active.name] } });
    await f.catalog.updateTaxRate(f.context, f.tax.id, { revision: 1, active: false, detach: true });
    expect((await f.service.get(f.gymId, active.id)).taxRateIds).toEqual([]);
    expect((await f.service.get(f.gymId, archived.id)).taxRateIds).toEqual([]);
    expect(await db.forGym(other.gymId, tx => tx.select().from(classPackTaxRates))).toHaveLength(1);
    const audit = (await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.tax_rate.archived'))))[0]!;
    expect(audit.after).toMatchObject({ detachedFrom: { packs: [{ id: archived.id }, { id: active.id }] } });
    await expect(f.service.create(f.context, f.input)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.update(f.context, active.id, { revision: 1, taxRateIds: [f.tax.id] })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('cannot reattach a rate while a confirmed detach races a pack edit', async () => {
    const f = await fixture(), pack = await f.service.create(f.context, f.input);
    await Promise.allSettled([
      f.catalog.updateTaxRate(f.context, f.tax.id, { revision: 1, active: false, detach: true }),
      f.service.update(f.context, pack.id, { revision: 1, taxRateIds: [f.tax.id] }),
    ]);
    const rate = await f.catalog.getTaxRate(f.gymId, f.tax.id);
    const links = (await f.service.get(f.gymId, pack.id)).taxRateIds;
    expect(rate.active).toBe(false);
    expect(links).toEqual([]);
  });
});
