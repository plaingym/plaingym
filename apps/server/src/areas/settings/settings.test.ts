// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
// eslint-disable-next-line database/system-tables -- One test reads backend PIDs to verify a currency change waits on an uncommitted payment-method insert.
import { eq, sql } from 'drizzle-orm';
import { auditEvents, gyms, paymentMethods, uuidv7, RevisionConflictError } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, canStaff, staffRoles, errorResponse, type StaffRole } from '@plaingym/shared';
import { gymSettingsResponseSchema } from '@plaingym/shared/contracts';
import { createSettingsService, createGymSettingsAccessor, readGymSettings, readPreviewSettings } from './settings.js';
import { readGymAndModuleSettings } from './module-settings.js';
import { createSettingsRoutes } from './settings.routes.js';
import { createServerRegistry } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { encryptSecret, parseEncryptionKey } from '../../core/secrets.js';
const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-22T12:00:00Z');
const service = createSettingsService({ scope: database.forGym, clock });
const gymA = uuidv7(), gymB = uuidv7();
let userId: string;
beforeAll(async () => {
  const secret = encryptSecret(parseEncryptionKey('aa'.repeat(32)), { secretClass: 'smtp_config', owner: gymA }, 'private-smtp-password');
  await factory('gyms', gymA, { name: 'Gym A', smtpConfig: secret, settings: { privateConfig: 'secret' } });
  await factory('gyms', gymB, { name: 'Gym B' });
  userId = (await factory('authUser', gymA)).id;
});
const mutation = { gymId: gymA, actor: { kind: 'system' } } as const;
function server(role: StaffRole, gymId = gymA, principalGym = gymId) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId: principalGym, userId, roles: [role] }, clock, requestId: 'test' }); await next();
  });
  app.onError((error, c) => {
    const known = error instanceof RevisionConflictError ? new AppError('conflict', 'The record changed') : error;
    return c.json(errorResponse(known, 'test'), known instanceof AppError ? known.status : 500);
  });
  createServerRegistry({ routes: createSettingsRoutes(service) }).mount(app, (permission) => async (c, next) => {
    const principal = c.get('context').principal;
    if (principal.kind !== 'staff' || principal.gymId !== c.get('context').gym.gymId) return c.notFound();
    if (permission.kind !== 'staff' || !canStaff(principal.roles, permission.capability)) return c.json({ error: 'forbidden' }, 403);
    await next();
  }, new Set());
  return app;
}
const patch = (app: ReturnType<typeof server>, path: string, body: unknown) => app.request(path, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
describe('settings service and routes', () => {
  it('projects only explicit safe settings and never returns another gym or opaque config', async () => {
    const a = await service.get(gymA), b = await service.get(gymB);
    expect(a.name).toBe('Gym A'); expect(b.name).toBe('Gym B');
    const response = await server('owner').request('/api/settings');
    expect(response.status).toBe(200);
    expect(gymSettingsResponseSchema.parse(await response.json()).data.bankDebitsEnabled).toBe(false);
    expect(JSON.stringify(a)).not.toMatch(/smtp|password|privateConfig|secret/);
    const accessor = createGymSettingsAccessor({ scope: database.forGym });
    expect(Object.keys(await accessor.get(gymA)).sort()).toEqual(['gymId', 'timezone', 'currency', 'billingEnabled', 'memberEmailsEnabled', 'memberSmsEnabled', 'smsDailyCap', 'country', 'websiteEnabled', 'bookingWindowDays', 'cancellationCutoffMinutes', 'openMatCountsAsClass', 'revision'].sort());
    await expect(service.get(uuidv7())).rejects.toMatchObject({ code: 'not_found' });
  });
  it.each(staffRoles)('checks all settings endpoints for %s before validation', async (role) => {
    const app = server(role), allowed = role === 'owner' || role === 'admin';
    expect((await app.request('/api/settings')).status).toBe(allowed ? 200 : 403);
    for (const path of ['/api/settings', '/api/settings/booking', '/api/settings/billing', '/api/settings/currency', '/api/settings/drop-in']) {
      expect((await patch(app, path, {})).status).toBe(allowed ? 400 : 403);
      const revision = (await service.get(gymA)).revision;
      const body = path.endsWith('booking') ? { revision, bookingWindowDays: 30 } : path.endsWith('billing') ? { revision, retryDays: [3, 7] } : path.endsWith('currency') ? { revision, currency: 'USD' } : path.endsWith('drop-in') ? { revision, dropInChargeTypeId: null } : { revision, name: 'Gym A' };
      const result = await patch(app, path, body); expect(result.status).toBe(allowed ? 200 : 403);
      if (allowed) expect(gymSettingsResponseSchema.safeParse(await result.json()).success).toBe(true);
    }
  });
  it('returns 404 for a different gym principal on every endpoint and leaves that gym untouched', async () => {
    const app = server('owner', gymB, gymA), before = await service.get(gymB);
    expect((await app.request('/api/settings')).status).toBe(404);
    for (const path of ['/api/settings', '/api/settings/booking', '/api/settings/billing', '/api/settings/currency', '/api/settings/drop-in'])
      expect((await patch(app, path, { revision: before.revision, name: 'Forged' })).status).toBe(404);
    expect(await service.get(gymB)).toEqual(before);
  });
  it('reads address and branding a newer release added keys to, and a save keeps those keys', async () => {
    const gymId = uuidv7(), newer = { gymId, actor: { kind: 'system' } } as const;
    await factory('gyms', gymId, { address: { city: 'North', line2: 'Unit 1', newerKey: 'kept' }, branding: { primaryColor: '#123456', newerKey: 'kept' } });
    const before = await service.get(gymId);
    expect(before).toMatchObject({ address: { city: 'North', line2: 'Unit 1' }, branding: { primaryColor: '#123456' } });
    expect(JSON.stringify(before)).not.toContain('newerKey');
    const after = await service.update(newer, 'general', { revision: before.revision, address: { city: 'South' }, branding: {} });
    expect(after).toMatchObject({ address: { city: 'South' }, branding: {} });
    // A field the owner cleared stays cleared; only keys this release doesn't know survive.
    const [row] = await database.forGym(gymId, (tx) => tx.select({ address: gyms.address, branding: gyms.branding }).from(gyms).where(eq(gyms.id, gymId)));
    expect(row).toEqual({ address: { city: 'South', newerKey: 'kept' }, branding: { newerKey: 'kept' } });
    // A save of something else leaves them alone.
    await service.update(newer, 'general', { revision: after.revision, name: 'Renamed' });
    const [same] = await database.forGym(gymId, (tx) => tx.select({ address: gyms.address }).from(gyms).where(eq(gyms.id, gymId)));
    expect(same).toEqual({ address: { city: 'South', newerKey: 'kept' } });
  });
  it('leaves a stored branding value that doesn\'t parse out of the whole read and the module read', async () => {
    const gymId = uuidv7(), logoKey = `${gymId}/logo.png`;
    await factory('gyms', gymId, { branding: { logoKey, primaryColor: 'red', newerKey: 'kept' } });
    expect((await database.forGym(gymId, (tx) => readGymSettings(tx, gymId))).branding).toStrictEqual({ logoKey });
    const both = await database.forGym(gymId, (tx) => readGymAndModuleSettings(tx, gymId, 'website'));
    expect(both.gym.branding).toStrictEqual({ logoKey });
    expect(both.module.branding).toStrictEqual({ logoKey, newerKey: 'kept' });
  });
  it.each<{ name: string; stored: unknown }>([
    { name: 'null', stored: sql`'null'::jsonb` },
    { name: 'an array', stored: [] },
    { name: 'a string', stored: 'text' },
  ])('reads stored branding that is $name as empty through both reads', async ({ stored }) => {
    const gymId = uuidv7();
    await factory('gyms', gymId);
    await database.forGym(gymId, (tx) => tx.update(gyms).set({ branding: stored }).where(eq(gyms.id, gymId)));
    expect((await database.forGym(gymId, (tx) => readGymSettings(tx, gymId))).branding).toStrictEqual({});
    const both = await database.forGym(gymId, (tx) => readGymAndModuleSettings(tx, gymId, 'website'));
    expect(both.gym.branding).toStrictEqual({});
    expect(both.module.branding).toStrictEqual({});
  });
  it('saves the gym name beside a stored branding value that doesn\'t parse and leaves the stored branding alone', async () => {
    const gymId = uuidv7(), logoKey = `${gymId}/logo.png`, branding = { logoKey, primaryColor: 'red', newerKey: 'kept' };
    await factory('gyms', gymId, { branding });
    const { revision } = await service.get(gymId);
    const after = await service.update({ gymId, actor: { kind: 'system' } }, 'general', { revision, name: 'Renamed' });
    expect(after).toMatchObject({ name: 'Renamed' });
    expect(after.branding).toStrictEqual({ logoKey });
    const [row] = await database.forGym(gymId, (tx) => tx.select({ branding: gyms.branding }).from(gyms).where(eq(gyms.id, gymId)));
    expect(row!.branding).toStrictEqual(branding);
    const [audit] = await database.forGym(gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.general.updated')));
    expect((audit!.before as { branding: unknown }).branding).toStrictEqual({ logoKey });
    expect((audit!.after as { branding: unknown }).branding).toStrictEqual({ logoKey });
  });
  it('leaves a stored address value that doesn\'t parse out of the whole read and the module read', async () => {
    const gymId = uuidv7();
    await factory('gyms', gymId, { address: { line1: '1 Main', country: 'usa', newerKey: 'kept' } });
    expect((await database.forGym(gymId, (tx) => readGymSettings(tx, gymId))).address).toStrictEqual({ line1: '1 Main' });
    const both = await database.forGym(gymId, (tx) => readGymAndModuleSettings(tx, gymId, 'website'));
    expect(both.gym.address).toStrictEqual({ line1: '1 Main' });
  });
  it.each<{ name: string; stored: unknown }>([
    { name: 'null', stored: sql`'null'::jsonb` },
    { name: 'an array', stored: [] },
    { name: 'a string', stored: 'text' },
    { name: 'an object with a null city', stored: { city: null } },
  ])('reads stored address that is $name as empty through both reads', async ({ stored }) => {
    const gymId = uuidv7();
    await factory('gyms', gymId);
    await database.forGym(gymId, (tx) => tx.update(gyms).set({ address: stored }).where(eq(gyms.id, gymId)));
    expect((await database.forGym(gymId, (tx) => readGymSettings(tx, gymId))).address).toStrictEqual({});
    const both = await database.forGym(gymId, (tx) => readGymAndModuleSettings(tx, gymId, 'website'));
    expect(both.gym.address).toStrictEqual({});
  });
  it('keeps a stored address value that doesn\'t parse until a save writes the address, which keeps only newer keys', async () => {
    const gymId = uuidv7(), context = { gymId, actor: { kind: 'system' } } as const;
    const address = { city: 'North', country: 'usa', newerKey: 'kept' };
    await factory('gyms', gymId, { address });
    const read = () => database.forGym(gymId, (tx) => tx.select({ address: gyms.address }).from(gyms).where(eq(gyms.id, gymId)));
    const { revision } = await service.get(gymId);
    const renamed = await service.update(context, 'general', { revision, name: 'Renamed' });
    expect((await read())[0]!.address).toStrictEqual(address);
    await service.update(context, 'general', { revision: renamed.revision, address: { city: 'South' } });
    expect((await read())[0]!.address).toStrictEqual({ city: 'South', newerKey: 'kept' });
    const audits = await database.forGym(gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.general.updated')));
    const audit = audits.find((item) => (item.after as { address: { city?: string } }).address.city === 'South')!;
    expect((audit.before as { address: unknown }).address).toStrictEqual({ city: 'North' });
  });
  it.each<{ name: string; stored: unknown }>([
    { name: 'null', stored: sql`'null'::jsonb` },
    { name: 'a string', stored: 'text' },
    { name: 'an array', stored: ['a', 'b'] },
  ])('replaces stored branding that is $name with what a save sends', async ({ stored }) => {
    const gymId = uuidv7();
    await factory('gyms', gymId);
    await database.forGym(gymId, (tx) => tx.update(gyms).set({ branding: stored }).where(eq(gyms.id, gymId)));
    const { revision } = await service.get(gymId);
    await service.update({ gymId, actor: { kind: 'system' } }, 'general', { revision, branding: { primaryColor: '#123456' } });
    const [row] = await database.forGym(gymId, (tx) => tx.select({ branding: gyms.branding }).from(gyms).where(eq(gyms.id, gymId)));
    expect(row!.branding).toStrictEqual({ primaryColor: '#123456' });
  });
  it.each<{ name: string; stored: unknown }>([
    { name: 'null', stored: sql`'null'::jsonb` },
    { name: 'a string', stored: 'text' },
    { name: 'an array', stored: ['a'] },
  ])('replaces a stored address that is $name with what a save sends', async ({ stored }) => {
    const gymId = uuidv7();
    await factory('gyms', gymId);
    await database.forGym(gymId, (tx) => tx.update(gyms).set({ address: stored }).where(eq(gyms.id, gymId)));
    const { revision } = await service.get(gymId);
    await service.update({ gymId, actor: { kind: 'system' } }, 'general', { revision, address: { city: 'South' } });
    const [row] = await database.forGym(gymId, (tx) => tx.select({ address: gyms.address }).from(gyms).where(eq(gyms.id, gymId)));
    expect(row!.address).toStrictEqual({ city: 'South' });
  });
  it('compares revisions, audits safe fields in the same transaction and reads the injected clock', async () => {
    const before = await service.get(gymA);
    const after = await service.update(mutation, 'general', { revision: before.revision, websiteEnabled: true });
    expect(after.revision).toBe(before.revision + 1); expect(after.updatedAt).toBe(clock.now().toISOString());
    expect((await patch(server('owner'), '/api/settings', { revision: before.revision, name: 'Stale' })).status).toBe(409);
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents));
    const last = audits.find((item) => item.action === 'settings.general.updated' && (item.after as { revision: number }).revision === after.revision)!;
    expect(last.occurredAt).toEqual(clock.now()); expect(JSON.stringify(audits)).not.toContain('private-smtp-password');
    expect(await service.get(gymB)).toMatchObject({ websiteEnabled: false });
  });
  it('refuses a new timezone outside the shared rule with the field path, and never rewrites a stored one', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { timezone: 'CET' });
    const app = server('owner', gymId);
    const { revision } = await service.get(gymId);
    for (const timezone of ['EST5EDT', 'PST', 'CET', 'Mars/Olympus', 'Etc/GMT+5']) {
      const response = await patch(app, '/api/settings', { revision, timezone });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_request', details: { timezone: ['invalid_timezone'] } } });
    }
    expect((await service.get(gymId)).timezone).toBe('CET');
    // The form leaves `timezone` out while it is unchanged, so the stored zone stays as it is whatever else is saved.
    const renamed = await patch(app, '/api/settings', { revision, name: 'Renamed' });
    expect(renamed.status).toBe(200);
    const saved = (await renamed.json() as { data: { revision: number; timezone: string; name: string } }).data;
    expect(saved).toMatchObject({ name: 'Renamed', timezone: 'CET' });
    // A new zone is stored under its canonical name, and spaces around it are dropped, as in setup and `gyms create`.
    expect((await patch(app, '/api/settings', { revision: saved.revision, timezone: 'america/vancouver' })).status).toBe(200);
    expect((await service.get(gymId)).timezone).toBe('America/Vancouver');
    expect((await patch(app, '/api/settings', { revision: saved.revision + 1, timezone: ' America/Toronto ' })).status).toBe(200);
    expect((await service.get(gymId)).timezone).toBe('America/Toronto');
  });
  it('refuses a gym country the phone library does not support, and saves GB', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const app = server('owner', gymId);
    const before = await service.get(gymId);
    const refused = await patch(app, '/api/settings', { revision: before.revision, address: { country: 'UK' } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_request', details: { 'address.country': ['unsupported_country'] } } });
    expect(await service.get(gymId)).toEqual(before);
    const combined = await patch(app, '/api/settings', { revision: before.revision, name: '', address: { country: 'UK' } });
    expect(combined.status).toBe(400);
    expect((await combined.json() as { error: { details: unknown } }).error.details).toEqual({
      name: ['invalid'], 'address.country': ['unsupported_country'] });
    expect(await service.get(gymId)).toEqual(before);
    const saved = await patch(app, '/api/settings', { revision: before.revision, address: { country: 'GB' } });
    expect(saved.status).toBe(200);
    expect((await service.get(gymId)).address.country).toBe('GB');
  });
  it('still reads a stored gym row holding an unsupported country', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { address: { country: 'UK' } });
    const response = await server('owner', gymId).request('/api/settings');
    expect(response.status).toBe(200);
    expect(gymSettingsResponseSchema.parse(await response.json()).data.address.country).toBe('UK');
  });
  it('names every refused field of a general update, each with its own code, and leaves the gym unchanged', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const app = server('owner', gymId);
    const before = await service.get(gymId);
    const response = await patch(app, '/api/settings', { revision: before.revision, name: ' ', timezone: 'PST',
      address: { country: 'canada' }, existingSiteUrl: 'ftp://example.org' });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { details: unknown } }).error.details).toEqual({
      name: ['invalid'], timezone: ['invalid_timezone'], 'address.country': ['unsupported_country'], existingSiteUrl: ['invalid'] });
    // One bad field that isn't the timezone is named too, and a body that supplies no change names none.
    const named = await patch(app, '/api/settings', { revision: before.revision, existingSiteUrl: 'ftp://example.org' });
    expect((await named.json() as { error: { details: unknown } }).error.details).toEqual({ existingSiteUrl: ['invalid'] });
    const empty = await patch(app, '/api/settings', { revision: before.revision });
    expect(empty.status).toBe(400);
    expect((await empty.json() as { error: { details?: unknown } }).error.details).toBeUndefined();
    expect(await service.get(gymId)).toEqual(before);
  });
  it('answers a malformed settings body with the shared body reader and keeps the body validation answer', async () => {
    const before = await service.get(gymA), app = server('owner');
    for (const path of ['/api/settings', '/api/settings/billing']) {
      const response = await app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"revision":' });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request', message: 'Request body must be JSON' },
      });
    }
    expect(await service.get(gymA)).toEqual(before);
    const invalid = await patch(server('owner'), '/api/settings', { revision: before.revision, timezone: 'Mars/Olympus' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'invalid_request', details: { timezone: ['invalid_timezone'] } },
    });
  });
  it('serializes racing saves so only one update wins', async () => {
    const revision = (await service.get(gymA)).revision;
    const results = await Promise.allSettled([service.update(mutation, 'booking', { revision, bookingWindowDays: 10 }), service.update(mutation, 'booking', { revision, bookingWindowDays: 20 })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('reports a stale revision before the currency lock', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'CAD' });
    await factory('plans', gymId);
    await service.update({ ...mutation, gymId }, 'general', { revision: 1, name: 'Academy' });
    await expect(service.update({ ...mutation, gymId }, 'currency', { revision: 1, currency: 'USD' })).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(service.update({ ...mutation, gymId }, 'currency', { revision: 2, currency: 'USD' }))
      .rejects.toMatchObject({ code: 'conflict', message: 'Currency cannot change after billing records exist' });
    expect(await service.get(gymId)).toMatchObject({ currency: 'CAD', revision: 2 });
  });
  it('reports a stale revision before an archived drop-in charge type', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const archived = await factory('chargeTypes', gymId, { active: false });
    await service.update({ ...mutation, gymId }, 'general', { revision: 1, name: 'Academy' });
    await expect(service.update({ ...mutation, gymId }, 'drop_in', { revision: 1, dropInChargeTypeId: archived.id }))
      .rejects.toBeInstanceOf(RevisionConflictError);
    await expect(service.update({ ...mutation, gymId }, 'drop_in', { revision: 2, dropInChargeTypeId: archived.id }))
      .rejects.toMatchObject({ code: 'conflict', message: 'Choose an active charge type' });
    expect(await service.get(gymId)).toMatchObject({ revision: 2 });
  });
  it.each(['plans', 'chargeTypes', 'memberships', 'invoices', 'classPacks'] as const)('locks currency when %s exist', async (table) => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    await service.update({ ...mutation, gymId }, 'currency', { revision: 1, currency: 'CAD' });
    await factory(table, gymId);
    await expect(service.update({ ...mutation, gymId }, 'currency', { revision: 2, currency: 'USD' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.get(gymId)).currency).toBe('CAD');
    expect((await patch(server('owner', gymId), '/api/settings/currency', { revision: 2, currency: 'USD' })).status).toBe(409);
    await service.update({ ...mutation, gymId }, 'currency', { revision: 2, currency: 'CAD' });
  });
  it('locks currency while active bank accounts of the current currency exist, and allows change when revoked or of another currency type', async () => {
    const usdGym = uuidv7(); await factory('gyms', usdGym, { currency: 'USD' });
    const usdHome = await factory('households', usdGym);
    const usBank = await factory('paymentMethods', usdGym, { householdId: usdHome.id, processorId: 'pm_us_lock', type: 'us_bank_account', last4: '6789' });

    await expect(service.update({ ...mutation, gymId: usdGym }, 'currency', { revision: 1, currency: 'CAD' }))
      .rejects.toMatchObject({ code: 'conflict', message: 'Currency cannot change after billing records exist' });
    expect((await patch(server('owner', usdGym), '/api/settings/currency', { revision: 1, currency: 'CAD' })).status).toBe(409);
    expect(await service.get(usdGym)).toMatchObject({ currency: 'USD', revision: 1 });

    await database.forGym(usdGym, tx => tx.update(paymentMethods).set({ revokedAt: clock.now() }).where(eq(paymentMethods.id, usBank.id)));
    expect(await service.update({ ...mutation, gymId: usdGym }, 'currency', { revision: 1, currency: 'CAD' }))
      .toMatchObject({ currency: 'CAD', revision: 2 });

    const usdWithPad = uuidv7(); await factory('gyms', usdWithPad, { currency: 'USD' });
    const usdWithPadHome = await factory('households', usdWithPad);
    await factory('paymentMethods', usdWithPad, { householdId: usdWithPadHome.id, processorId: 'pm_pad_in_usd', type: 'acss_debit', mandateId: 'mandate_cad', last4: '1111' });
    expect(await service.update({ ...mutation, gymId: usdWithPad }, 'currency', { revision: 1, currency: 'CAD' }))
      .toMatchObject({ currency: 'CAD', revision: 2 });

    const cadGym = uuidv7(); await factory('gyms', cadGym, { currency: 'CAD' });
    const cadHome = await factory('households', cadGym);
    await factory('paymentMethods', cadGym, { householdId: cadHome.id, processorId: 'pm_cad_lock', type: 'acss_debit', mandateId: 'mandate_cad', last4: '2222' });
    await expect(service.update({ ...mutation, gymId: cadGym }, 'currency', { revision: 1, currency: 'USD' }))
      .rejects.toMatchObject({ code: 'conflict', message: 'Currency cannot change after billing records exist' });
    expect(await service.get(cadGym)).toMatchObject({ currency: 'CAD', revision: 1 });
  });
  it('waits for an uncommitted US bank account insert and refuses the currency change once it commits', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'USD' });
    const home = await factory('households', gymId);
    const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const inserting = database.forGym(gymId, async tx => {
      // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
      const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
      await tx.insert(paymentMethods).values({
        id: uuidv7(), gymId, householdId: home.id, processorId: 'pm_concurrent_us', type: 'us_bank_account',
        last4: '6789', isDefault: false, createdAt: clock.now(),
      });
      locked.resolve(pid);
      await release.promise;
    });
    const pid = await locked.promise;

    let finished = false;
    const changing = service.update({ ...mutation, gymId }, 'currency', { revision: 1, currency: 'CAD' })
      .finally(() => { finished = true; })
      .then(value => ({ value }), (error: unknown) => ({ error }));
    let sawWait = false;
    try {
      const deadline = Date.now() + 2000;
      while (!sawWait && !finished && Date.now() < deadline) {
        // eslint-disable-next-line database/system-tables -- The lock-wait probe.
        sawWait = (await database.system.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
        if (!sawWait) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(sawWait).toBe(true);
      expect(finished).toBe(false);
    } finally {
      release.resolve();
      await inserting;
    }
    expect(await changing).toMatchObject({ error: { code: 'conflict', message: 'Currency cannot change after billing records exist' } });
    expect(await service.get(gymId)).toMatchObject({ currency: 'USD', revision: 1 });
  });
  it('does not accept switches, encrypted fields, a target gym or private settings through general updates', async () => {
    const app = server('owner');
    for (const values of [{ smtpConfig: 'plaintext' }, { billingEnabled: true }, { memberEmailsEnabled: true }, { id: gymB }, { settings: {} }]) {
      const response = await patch(app, '/api/settings', { revision: (await service.get(gymA)).revision, ...values });
      expect(response.status).toBe(400);
    }
    const row = await database.forGym(gymA, (tx) => tx.select({ smtp: gyms.smtpConfig }).from(gyms).where(eq(gyms.id, gymA)));
    expect(row[0]!.smtp).toMatch(/^v2\./);
  });
  it.each<{ name: string; stored: unknown; country: string | null }>([
    { name: 'JSON null', stored: sql`'null'::jsonb`, country: null },
    { name: 'a lowercase country', stored: { country: 'us' }, country: null },
    { name: 'a numeric country', stored: { country: 3 }, country: null },
    { name: 'empty', stored: {}, country: null },
    { name: 'a valid country', stored: { country: 'US' }, country: 'US' },
  ])('reads the import preview settings for a stored address that is $name', async ({ stored, country }) => {
    const gymId = uuidv7();
    await factory('gyms', gymId, { currency: 'CAD', bankDebitsEnabled: true });
    await database.forGym(gymId, (tx) => tx.update(gyms).set({ address: stored }).where(eq(gyms.id, gymId)));
    expect(await database.forGym(gymId, (tx) => readPreviewSettings(tx, gymId)))
      .toStrictEqual({ currency: 'CAD', country, bankDebitsEnabled: true });
  });
});
