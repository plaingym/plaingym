// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, chargeTypes, gyms, taxRates, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { gymSettingsResponseSchema, publicContracts } from '@plaingym/shared/contracts';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../core/app.js';
import { authorize } from '../staff/auth.permissions.js';
import { createCatalogService } from '../billing/catalog.js';
import { createWaiversService } from '../waivers/waivers.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createPublicPagesService } from '../../public/pages/service.js';
import { createPublicRoutes } from '../../public/pages/pages.routes.js';
import { createSettingsService, createGymSettingsAccessor } from './settings.js';
import { createSettingsRoutes } from './settings.routes.js';
import { createGymDeleteService } from './gym-delete.js';
import { createDropInFee } from './drop-in-fee.js';

const database = useTestDatabase(), factory = createFactories(database);
const origin = 'https://drop-in.example.test';
async function fixture() {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock('2026-11-01T17:00:00Z');
  await factory('gyms', gymId, { currency: 'CAD' });
  await factory('gyms', otherGym, { currency: 'CAD' });
  // A charge type named like a drop-in fee is never picked up unless staff choose it.
  await factory('chargeTypes', gymId, { name: 'Drop-in', amountCents: 9900, currency: 'CAD' });
  const mat = await factory('chargeTypes', gymId, { name: 'Mat fee', amountCents: 2500, currency: 'CAD' });
  const foreign = await factory('chargeTypes', otherGym, { name: 'Other gym mat fee', amountCents: 1500, currency: 'CAD' });
  await factory('waiverTemplates', gymId, { name: 'Participation' });
  const userId = (await factory('authUser', gymId)).id, otherUser = (await factory('authUser', otherGym)).id;
  const options = { scope: database.forGym, clock }, service = createSettingsService(options);
  const catalog = createCatalogService({ ...options, settings: createGymSettingsAccessor(options) });
  const dropInFeeFor = createDropInFee({ scope: database.forGym });
  const uploads = new FakeUploads(gymId, clock);
  const pages = createPublicPagesService({ ...options, settings: service, dropInFeeFor, notifyStaff: async () => {},
    waivers: createWaiversService({ ...options, uploadsFor: async () => uploads }) });
  const routes = [...createSettingsRoutes(service), ...createPublicRoutes({ service: pages, stylesheet: async () => '' })];
  function server(role: StaffRole = 'owner', principal: { gymId: string; userId: string } = { gymId, userId }, resolved = gymId) {
    return createApp({ clock, origin, authorize, contributions: { routes },
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: resolved, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal: { kind: 'staff', ...principal, roles: [role] } }); await next(); },
    });
  }
  const patch = (body: unknown, role: StaffRole = 'owner', principal?: { gymId: string; userId: string }, resolved?: string) =>
    server(role, principal, resolved).request(origin + '/api/settings/drop-in', {
      method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const revision = async (id = gymId) => (await service.get(id)).revision;
  async function choose(dropInChargeTypeId: string | null) {
    const response = await patch({ revision: await revision(), dropInChargeTypeId });
    expect(response.status).toBe(200);
    return gymSettingsResponseSchema.parse(await response.json()).data;
  }
  const page = async () => (await server().request(origin + '/drop-in')).text();
  const config = async () => publicContracts.config.response.parse(await (await server().request(origin + '/api/public/config')).json()).data.dropInFee;
  const archive = async (id: string, active = false) => catalog.updateChargeType({ gymId, actor: { kind: 'system' } }, id,
    { revision: (await catalog.getChargeType(gymId, id)).revision, active });
  return { gymId, otherGym, clock, mat, foreign, otherUser, service, catalog, dropInFeeFor, patch, revision, choose, page, config, archive };
}

describe('drop-in fee setting through real PostgreSQL and the settings and public routes', () => {
  it('starts with no fee and never infers one from a charge type name or shows zero', async () => {
    const f = await fixture();
    expect((await f.service.get(f.gymId)).dropInChargeTypeId).toBeNull();
    expect(await f.dropInFeeFor(f.gymId)).toBeNull();
    expect(await f.config()).toBeNull();
    const html = await f.page();
    expect(html).toContain('Contact the gym to confirm the mat fee');
    expect(html).not.toMatch(/\$99\.00|\$0\.00/);
  });

  it('sets the fee to a chosen charge type, audits it and shows its current price on the next page load', async () => {
    const f = await fixture();
    const saved = await f.choose(f.mat.id);
    expect(saved).toMatchObject({ dropInChargeTypeId: f.mat.id, revision: 2, updatedAt: f.clock.now().toISOString() });
    expect((await f.service.get(f.gymId)).dropInChargeTypeId).toBe(f.mat.id);
    const [audit] = await database.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.drop_in.updated')));
    expect(audit).toMatchObject({ actorKind: 'user', targetType: 'gym', targetId: f.gymId,
      before: { dropInChargeTypeId: null }, after: { dropInChargeTypeId: f.mat.id } });
    expect(await f.config()).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: false });
    expect(await f.page()).toContain('Drop-in mat fee: CA$25.00');

    // The setting names the charge type, not a copied price: a catalog price change shows on the next load.
    await f.catalog.updateChargeType({ gymId: f.gymId, actor: { kind: 'system' } }, f.mat.id, { revision: 1, amountCents: 3000 });
    expect(await f.config()).toEqual({ amountCents: 3000, currency: 'CAD', plusTax: false });
    expect(await f.page()).toContain('Drop-in mat fee: CA$30.00');
  });

  it('clears the fee so the page asks visitors to contact the gym', async () => {
    const f = await fixture();
    await f.choose(f.mat.id);
    expect(await f.choose(null)).toMatchObject({ dropInChargeTypeId: null, revision: 3 });
    expect(await f.dropInFeeFor(f.gymId)).toBeNull();
    expect(await f.page()).toContain('Contact the gym to confirm the mat fee');
  });

  it('shows no fee while the chosen charge type is archived, and refuses choosing an archived one', async () => {
    const f = await fixture();
    await f.choose(f.mat.id);
    await f.archive(f.mat.id);
    expect((await f.service.get(f.gymId)).dropInChargeTypeId).toBe(f.mat.id);
    expect(await f.config()).toBeNull();
    const html = await f.page();
    expect(html).toContain('Contact the gym to confirm the mat fee');
    expect(html).not.toContain('CA$25.00');
    const refused = await f.patch({ revision: await f.revision(), dropInChargeTypeId: f.mat.id });
    expect(refused.status).toBe(409);
    // Restoring the charge type shows its price again without saving the setting.
    await f.archive(f.mat.id, true);
    expect(await f.config()).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: false });
  });

  it('refuses another gym\'s charge type, unknown IDs and stale revisions without changing the setting', async () => {
    const f = await fixture();
    const revision = await f.revision();
    for (const dropInChargeTypeId of [f.foreign.id, uuidv7()]) {
      const response = await f.patch({ revision, dropInChargeTypeId });
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toContain('Other gym');
    }
    expect(await f.service.get(f.gymId)).toMatchObject({ dropInChargeTypeId: null, revision });
    expect((await f.patch({ revision: revision + 1, dropInChargeTypeId: f.mat.id })).status).toBe(409);
    expect((await f.patch({ revision, dropInChargeTypeId: 'not-an-id' })).status).toBe(400);
    expect((await f.patch({ revision, dropInChargeTypeId: f.mat.id, amountCents: 100 })).status).toBe(400);
    // Even another gym's ID written straight to the column shows no fee: the reader matches the charge type on the gym.
    await database.forGym(f.gymId, tx => tx.update(gyms).set({ dropInChargeTypeId: f.foreign.id }).where(eq(gyms.id, f.gymId)));
    expect(await f.dropInFeeFor(f.gymId)).toBeNull();
    const html = await f.page();
    expect(html).toContain('Contact the gym to confirm the mat fee');
    expect(html).not.toContain('CA$15.00');
  });

  it('keeps each gym\'s setting and staff to their own gym', async () => {
    const f = await fixture();
    // The other gym's owner holds no role here, so the staff authorizer refuses them before the handler, and nothing changes.
    const crossed = await f.patch({ revision: await f.revision(), dropInChargeTypeId: f.mat.id }, 'owner', { gymId: f.otherGym, userId: f.otherUser });
    expect(crossed.status).toBe(403);
    expect((await f.service.get(f.gymId)).dropInChargeTypeId).toBeNull();
    await f.choose(f.mat.id);
    expect(await f.dropInFeeFor(f.otherGym)).toBeNull();
    const other = await f.patch({ revision: await f.revision(f.otherGym), dropInChargeTypeId: f.foreign.id }, 'owner', { gymId: f.otherGym, userId: f.otherUser }, f.otherGym);
    expect(other.status).toBe(200);
    expect(await f.dropInFeeFor(f.otherGym)).toEqual({ amountCents: 1500, currency: 'CAD', plusTax: false });
    expect(await f.dropInFeeFor(f.gymId)).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: false });
  });

  it.each(staffRoles)('requires settings.manage for %s', async (role) => {
    const f = await fixture();
    const response = await f.patch({ revision: await f.revision(), dropInChargeTypeId: f.mat.id }, role);
    expect(response.status).toBe(['owner', 'admin'].includes(role) ? 200 : 403);
  });

  it('adds "+ tax" to the fee only when an exclusive rate above zero is attached to the charge type', async () => {
    const f = await fixture(), plus = '\u00a0+\u00a0tax';
    const attach = async (rate: { id: string }, chargeTypeId = f.mat.id, gymId = f.gymId) =>
      factory('chargeTypeTaxRates', gymId, { chargeTypeId, taxRateId: rate.id });
    const rate = (name: string, rateMillionths: number, inclusive: boolean, active = true, gymId = f.gymId) =>
      factory('taxRates', gymId, { name, rateMillionths, inclusive, active });
    await f.choose(f.mat.id);
    // No rate: the catalog price stands alone.
    expect(await f.dropInFeeFor(f.gymId)).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: false });
    expect(await f.page()).toContain('Drop-in mat fee: CA$25.00<');
    // A tax-inclusive rate is already in the price.
    await attach(await rate('QST included', 99_750, true));
    expect(await f.config()).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: false });
    expect(await f.page()).not.toContain(plus);
    // A zero exclusive rate adds nothing to an invoice.
    await attach(await rate('Zero', 0, false));
    expect((await f.dropInFeeFor(f.gymId))?.plusTax).toBe(false);
    // An exclusive rate beside the inclusive one: the page shows the catalog price and the note, never a total.
    const gst = await rate('GST', 149_750, false);
    await attach(gst);
    expect(await f.config()).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: true });
    const html = await f.page();
    expect(html).toContain(`Drop-in mat fee: CA$25.00${plus}<`);
    expect(html).not.toContain('28.74'); expect(html).not.toContain('CA$26');
    // Invoicing refuses an archived rate on a one-off charge and never applies it, so the note goes with it.
    await database.forGym(f.gymId, tx => tx.update(taxRates).set({ active: false }).where(eq(taxRates.id, gst.id)));
    expect(await f.page()).not.toContain(plus);
    expect((await f.dropInFeeFor(f.gymId))?.plusTax).toBe(false);
    // Archiving the charge type still hides the fee altogether.
    await f.archive(f.mat.id);
    expect(await f.dropInFeeFor(f.gymId)).toBeNull();
  });

  it('reads the fee and its tax flag in one query, counted at the driver', async () => {
    const f = await fixture();
    await factory('chargeTypeTaxRates', f.gymId, { chargeTypeId: f.mat.id, taxRateId: (await factory('taxRates', f.gymId, { name: 'GST', rateMillionths: 50_000, inclusive: false })).id });
    await f.choose(f.mat.id);
    // The test pool's postgres.js debug hook sees every statement sent to the server, whatever builds it.
    const statements: string[] = [];
    const options = database.app.sql.options, previous = options.debug;
    options.debug = (_connection, query) => { statements.push(query); };
    try {
      expect(await f.dropInFeeFor(f.gymId)).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: true });
    } finally { options.debug = previous; }
    const reads = statements.filter(query => query.trimStart().toLowerCase().startsWith('select') && !query.includes('set_config'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/exists/i);
  });

  it('shares the caller\'s transaction when given one, and gives null for an archived charge type', async () => {
    const f = await fixture();
    await factory('chargeTypeTaxRates', f.gymId, { chargeTypeId: f.mat.id, taxRateId: (await factory('taxRates', f.gymId, { name: 'GST', rateMillionths: 50_000, inclusive: false })).id });
    await f.choose(f.mat.id);
    expect(await database.forGym(f.gymId, tx => createDropInFee({ scope: () => { throw new Error('opened its own scope'); } })(f.gymId, tx)))
      .toEqual({ amountCents: 2500, currency: 'CAD', plusTax: true });
    await f.archive(f.mat.id);
    expect(await database.forGym(f.gymId, tx => f.dropInFeeFor(f.gymId, tx))).toBeNull();
  });

  it('reads the config for a missing gym without reading the drop-in fee', async () => {
    const f = await fixture();
    const reads: string[] = [];
    const pages = createPublicPagesService({ scope: database.forGym, clock: f.clock, notifyStaff: async () => {},
      dropInFeeFor: async gymId => { reads.push(gymId); return null; }, waivers: createWaiversService({ scope: database.forGym, clock: f.clock, uploadsFor: async () => new FakeUploads(f.gymId, f.clock) }) });
    await expect(pages.config(uuidv7())).rejects.toMatchObject({ code: 'not_found' });
    expect(reads).toEqual([]);
    await pages.config(f.gymId);
    expect(reads).toEqual([f.gymId]);
  });

  it('reads only the choosing gym\'s tax rates', async () => {
    const f = await fixture();
    // The other gym taxes its own mat fee. Its rate and attachment are invisible to this gym, and to its reader.
    const foreignRate = await factory('taxRates', f.otherGym, { name: 'Other GST', rateMillionths: 50_000, inclusive: false });
    await factory('chargeTypeTaxRates', f.otherGym, { chargeTypeId: f.foreign.id, taxRateId: foreignRate.id });
    await f.choose(f.mat.id);
    const other = await f.patch({ revision: await f.revision(f.otherGym), dropInChargeTypeId: f.foreign.id }, 'owner', { gymId: f.otherGym, userId: f.otherUser }, f.otherGym);
    expect(other.status).toBe(200);
    expect(await f.dropInFeeFor(f.otherGym)).toEqual({ amountCents: 1500, currency: 'CAD', plusTax: true });
    expect(await f.dropInFeeFor(f.gymId)).toEqual({ amountCents: 2500, currency: 'CAD', plusTax: false });
    expect(await f.page()).not.toMatch(/\+\s*tax/);
    // This gym's reader, run as another gym's scope, finds neither the charge type nor its rate.
    expect(await createDropInFee({ scope: (_gymId, fn) => database.forGym(f.otherGym, fn) })(f.gymId)).toBeNull();
  });

  it('still deletes a gym whose drop-in fee names one of its charge types', async () => {
    const f = await fixture();
    await f.choose(f.mat.id);
    const remove = createGymDeleteService({ clock: f.clock, removeUploads: async () => {}, scope: database.forGym, system: database.forSystem });
    await remove.remove(f.gymId, await f.revision());
    expect(await database.forSystem(tx => tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, f.gymId)))).toEqual([]);
    expect(await database.forGym(f.otherGym, tx => tx.select({ id: chargeTypes.id }).from(chargeTypes))).toEqual([{ id: f.foreign.id }]);
  });
});
