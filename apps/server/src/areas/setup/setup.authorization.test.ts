// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { gyms, auditEvents, uuidv7, RevisionConflictError } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { canStaff, staffRoles, type StaffRole } from '@plaingym/shared';
import { setupContracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { errorHandler, respondError } from '../../core/errors.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createSetupService } from './setup.js';
import { createSetupRoutes } from './setup.routes.js';
import { createSmtpResolver } from '../settings/smtp.js';
import { assertNoTransaction } from '@plaingym/shared/transaction';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-22T12:00:00Z');
const gymA = uuidv7(), gymB = uuidv7();
let userA: string, userB: string;
const service = createSetupService({ key: parseEncryptionKey('ab'.repeat(32)), origin: 'http://gym.localhost',
  scope: database.forGym, system: database.forSystem, clock });
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB);
  userA = (await factory('authUser', gymA)).id; userB = (await factory('authUser', gymB)).id;
  for (const [gymId, ownerId] of [[gymA, userA], [gymB, userB]]) await database.forGym(gymId!, (tx) => tx.update(gyms)
    .set({ settings: { setup: { completedSteps: [0, 1, 2, 3, 4, 5, 6, 7], completed: false, ownerId } } }).where(eq(gyms.id, gymId!)));
});
function app(principal: Principal, gymId = gymA) {
  const app = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, c) => { if (!result.success) return respondError(c, result.error); } });
  app.onError(errorHandler);
  app.use('*', async (c, next) => { c.set('context', { principal, gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, clock, requestId: 'test' }); await next(); });
  for (const entry of createSetupRoutes(() => service)) entry.mount(app, (permission) => async (c, next) => {
    if (permission.kind === 'public') return next();
    if (principal.kind === 'anonymous') return c.json({}, 401);
    // The handler itself must reject a principal from another gym even with capability approval.
    if (permission.kind !== 'staff' || principal.kind !== 'staff' || !canStaff(principal.roles, permission.capability)) return c.json({}, 403);
    await next();
  });
  return app;
}
const protectedContracts = Object.values(setupContracts).filter((contract) => contract.gate === 'setup_owner');
const request = (server: ReturnType<typeof app>, contract: { path: string; method: string }, body: unknown = {}) => server.request(contract.path, {
  method: contract.method.toUpperCase(), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
describe('setup owner authorization and tenant isolation', () => {
  it('finishes without S3 only after an explicit skip, and keeps stale attempts atomic', async () => {
    const gymId = uuidv7();
    await factory('gyms', gymId, { settings: { setup: { ownerId: userA, completed: false, completedSteps: [0, 1, 2, 3, 4, 5, 6] } } });
    const context = { gymId, actor: { kind: 'user', userId: userA } } as const;
    await expect(service.finish(context, { choice: 'fresh', revision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.finish(context, { choice: 'fresh', revision: 2, skipBackups: true })).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await database.forGym(gymId, (tx) => tx.select().from(gyms)))[0]!.revision).toBe(1);
    expect(await service.finish(context, { choice: 'fresh', revision: 1, skipBackups: true })).toMatchObject({ completed: true, revision: 2 });
    const [gym] = await database.forGym(gymId, (tx) => tx.select().from(gyms));
    expect(gym).toMatchObject({ backupDestination: null, backupPublicKey: null, s3Config: null, backupBlobKey: null,
      billingEnabled: false, memberEmailsEnabled: false, settings: { setup: { completed: true } } });
  });
  it.each(staffRoles)('checks every setup-owner endpoint for %s before validation', async (role: StaffRole) => {
    const server = app({ kind: 'staff', gymId: gymA, userId: userA, roles: [role] });
    for (const contract of protectedContracts) expect((await request(server, contract)).status, contract.path).toBe(role === 'owner' ? 400 : 403);
  });
  it('denies anonymous, member and kiosk principals on every protected endpoint', async () => {
    for (const principal of [{ kind: 'anonymous' }, { kind: 'kiosk', gymId: gymA, deviceId: uuidv7() },
      { kind: 'member', userId: userA, scope: { gymId: gymA, householdId: uuidv7(), role: 'payer' } }] as const) {
      for (const contract of protectedContracts) expect((await request(app(principal), contract)).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
    }
  });
  it('returns 404 for a foreign-gym owner on every route and never mutates that gym', async () => {
    const server = app({ kind: 'staff', gymId: gymA, userId: userA, roles: ['owner'] }, gymB);
    const input: Record<string, unknown> = {
      gym: { revision: 1, name: 'Forged', timezone: 'UTC', currency: 'USD', address: {}, branding: { logoKey: null, primaryColor: null } },
      packs: { revision: 1, packs: [] }, website: { revision: 1, websiteEnabled: true, existingSiteUrl: null },
      smtp: { revision: 1, choice: 'skip' }, stripe: { revision: 1, choice: 'skip' },
      backups: { revision: 1, destination: { endpoint: 'https://s3.example.org', bucket: 'x', region: 'auto', accessKeyId: 'x', secretAccessKey: 'x' } },
      confirmBackupKey: { revision: 1, privateKey: 'AGE-SECRET-KEY-1ABC' }, finish: { revision: 1, choice: 'fresh' },
    };
    for (const [name, contract] of Object.entries(setupContracts).filter(([, c]) => c.gate === 'setup_owner'))
      expect((await request(server, contract, input[name])).status, name).toBe(404);
    expect((await database.forGym(gymB, (tx) => tx.select().from(gyms)))[0]).toMatchObject({ revision: 1, websiteEnabled: false });
    expect(await database.forGym(gymB, (tx) => tx.select().from(auditEvents))).toHaveLength(0);
  });
  it('rejects an owner identity that does not own this setup, even with a forged gym principal', async () => {
    await expect(service.website({ gymId: gymB, actor: { kind: 'user', userId: userA } }, { revision: 1, websiteEnabled: true, existingSiteUrl: null })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('serializes simultaneous saves and keeps the audit atomic', async () => {
    const context = { gymId: gymA, actor: { kind: 'user', userId: userA } } as const;
    const results = await Promise.allSettled([service.website(context, { revision: 1, websiteEnabled: true, existingSiteUrl: null }), service.website(context, { revision: 1, websiteEnabled: false, existingSiteUrl: null })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await database.forGym(gymA, (tx) => tx.select().from(auditEvents))).toHaveLength(1);
  });
  it('preserves install SMTP on skip and maps implicit TLS correctly without transaction I/O', async () => {
    const key = parseEncryptionKey('ab'.repeat(32));
    const env = { SMTP_HOST: 'smtp.install.example', SMTP_FROM: 'gym@example.org' };
    const instance = createSetupService({ key, env, origin: 'http://gym.localhost', scope: database.forGym, system: database.forSystem, clock,
      sendTest: async (config) => { assertNoTransaction('setup test email'); expect(config.security).toBe('tls'); } });
    const context = { gymId: gymB, actor: { kind: 'user', userId: userB } } as const;
    expect(await instance.smtp(context, { choice: 'skip', revision: 1 })).toMatchObject({ configured: true, test: 'not_sent', revision: 2 });
    const resolver = createSmtpResolver({ key, env, scope: database.forGym });
    expect(await resolver.config(gymB)).toMatchObject({ host: env.SMTP_HOST });
    expect(await instance.smtp(context, { choice: 'configure', revision: 2, host: 'smtp.gym.example', port: 465, secure: true,
      username: 'user', password: 'secret', from: 'gym@example.org', testTo: 'owner@example.org' })).toMatchObject({ configured: true, test: 'sent', revision: 3 });
    expect(await resolver.config(gymB)).toMatchObject({ host: 'smtp.gym.example', security: 'tls' });
  });
  it('refuses changing currency once billing records exist', async () => {
    await factory('plans', gymA);
    await expect(service.gym({ gymId: gymA, actor: { kind: 'user', userId: userA } }, { revision: 2, name: 'Academy', timezone: 'UTC', currency: 'CAD', address: {}, branding: { logoKey: null, primaryColor: null } })).rejects.toMatchObject({ code: 'conflict' });
    expect((await database.forGym(gymA, (tx) => tx.select().from(gyms)))[0]).toMatchObject({ currency: 'USD', revision: 2 });
  });
});
