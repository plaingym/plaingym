// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7, RevisionConflictError } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, canStaff, staffRoles, errorResponse, type StaffRole } from '@plaingym/shared';
import { gymSettingsResponseSchema } from '@plaingym/shared/contracts';
import { createSettingsService, createGymSettingsAccessor } from './settings.js';
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
    expect(JSON.stringify(a)).not.toMatch(/smtp|password|privateConfig|secret/);
    const accessor = createGymSettingsAccessor({ scope: database.forGym });
    expect(Object.keys(await accessor.get(gymA)).sort()).toEqual(['gymId', 'timezone', 'currency', 'billingEnabled', 'memberEmailsEnabled', 'websiteEnabled', 'bookingWindowDays', 'cancellationCutoffMinutes', 'openMatCountsAsClass', 'revision'].sort());
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
  it('names every refused field of a general update, each with its own code, and leaves the gym unchanged', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const app = server('owner', gymId);
    const before = await service.get(gymId);
    const response = await patch(app, '/api/settings', { revision: before.revision, name: ' ', timezone: 'PST',
      address: { country: 'canada' }, existingSiteUrl: 'ftp://example.org' });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { details: unknown } }).error.details).toEqual({
      name: ['invalid'], timezone: ['invalid_timezone'], 'address.country': ['invalid'], existingSiteUrl: ['invalid'] });
    // One bad field that isn't the timezone is named too, and a body that supplies no change names none.
    const named = await patch(app, '/api/settings', { revision: before.revision, existingSiteUrl: 'ftp://example.org' });
    expect((await named.json() as { error: { details: unknown } }).error.details).toEqual({ existingSiteUrl: ['invalid'] });
    const empty = await patch(app, '/api/settings', { revision: before.revision });
    expect(empty.status).toBe(400);
    expect((await empty.json() as { error: { details?: unknown } }).error.details).toBeUndefined();
    expect(await service.get(gymId)).toEqual(before);
  });
  it('serializes racing saves so only one update wins', async () => {
    const revision = (await service.get(gymA)).revision;
    const results = await Promise.allSettled([service.update(mutation, 'booking', { revision, bookingWindowDays: 10 }), service.update(mutation, 'booking', { revision, bookingWindowDays: 20 })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
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
  it('does not accept switches, encrypted fields, a target gym or private settings through general updates', async () => {
    const app = server('owner');
    for (const values of [{ smtpConfig: 'plaintext' }, { billingEnabled: true }, { memberEmailsEnabled: true }, { id: gymB }, { settings: {} }]) {
      const response = await patch(app, '/api/settings', { revision: (await service.get(gymA)).revision, ...values });
      expect(response.status).toBe(400);
    }
    const row = await database.forGym(gymA, (tx) => tx.select({ smtp: gyms.smtpConfig }).from(gyms).where(eq(gyms.id, gymA)));
    expect(row[0]!.smtp).toMatch(/^v2\./);
  });
});
