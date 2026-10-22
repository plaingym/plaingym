// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line no-restricted-imports -- Integration initializes the real app-role pool used by auth and loadBackupConfig; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { gyms, auditEvents, ranks, programs, staffRoles } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { setupContracts, setupStatusResponseSchema } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { createApp } from '../../core/app.js';
import { TestClock } from '../../core/clock.js';
import { createTenantResolver } from '../../core/tenancy.js';
import { parseEncryptionKey, decryptSecret } from '../../core/secrets.js';
import { authorize } from '../staff/auth.permissions.js';
import { createOwnerService } from '../staff/auth.owner.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig, passwordLogin } from '../../infra/auth/config.js';
import { createAuthService } from '../../infra/auth/service.js';
import { sessionMiddleware } from '../../infra/auth/middleware.js';
import { createSmtpResolver } from '../settings/smtp.js';
import { createContentPackRoutes } from '../ranks/packs.routes.js';
import { loadBackupConfig } from '../health/restore.config.js';
import { identityToRecipient, generateIdentity } from '../../infra/age/index.js';
import { createSetupService } from './setup.js';
import { createSetupRoutes } from './setup.routes.js';

const database = useTestDatabase(), clock = new TestClock('2026-10-22T12:00:00Z');
const key = parseEncryptionKey('ab'.repeat(32)), origin = 'http://gym.localhost';
const env = { AUTH_SECRET: 'setup-test-secret-with-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'auto' };
const config = authConfig(env), sendTest = vi.fn(async () => { assertNoTransaction('setup test email'); });
const ownerService = createOwnerService({ accounts: createAccountService(config), clock, async sendMagicLink() { throw new Error('Password bootstrap must not send a link'); } });
const service = createSetupService({ key, origin, clock, env, provisionOwner: ownerService, sendTest });
const smtp = createSmtpResolver({ key, env, scope: database.forGym });
const auth = createAuthService({ config, async sendMagicLink() {} });
let directory: string;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  directory = await mkdtemp(join(tmpdir(), 'setup-assets-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(join(directory, 'assets', 'app.js'), 'export {};');
});
afterAll(async () => { await closeDatabase(); await rm(directory, { recursive: true, force: true }); });
const app = () => createApp({ clock, installOrigin: origin, origin, publicDirectory: directory,
  contributions: { routes: [...createSetupRoutes(() => service), ...createContentPackRoutes()] },
  resolveGym: createTenantResolver(), authorize,
  session: sessionMiddleware({ auth, smtpConfigured: (gymId) => smtp.configured(gymId), resolve: (c) => ({
    gymId: c.get('context').gym.gymId, origin, clientIp: '127.0.0.1',
  }) }),
});
describe('first-boot setup', () => {
  it('limits owner passwords locally until the shared contract is aligned', async () => {
    const body = { name: 'Owner', email: 'owner@example.org', password: 'x'.repeat(129) };
    expect((await app().request(origin + '/api/setup/owner', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(400);
    expect(await service.status()).toMatchObject({ currentStep: 0 });
  });
  it('completes a fresh wizard with real owner authentication, packs, SMTP and compatible backups', async () => {
    const server = app();
    const call = (path: string, method = 'GET', body?: unknown, cookie?: string) => server.request(origin + path, {
      method, headers: { host: 'gym.localhost', origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect((await server.request(origin + '/setup', { headers: { accept: 'text/html' } })).status).toBe(200);
    expect((await call('/assets/app.js')).status).toBe(200);
    expect(setupStatusResponseSchema.parse(await (await call('/api/setup')).json()).data.currentStep).toBe(0);
    const catalog = await call('/api/content-packs/catalog'); expect(catalog.status).toBe(200);
    const pack = (await catalog.json() as { data: { id: string; version: number }[] }).data.find((p) => p.id === 'bjj')!;
    expect((await call('/api/setup/start', 'POST', { choice: 'fresh' })).status).toBe(200);
    const owner = { name: 'Gym Owner', email: 'owner@example.org', password: 'owner-password-123' };
    const created = await call('/api/setup/owner', 'POST', owner); expect(created.status).toBe(200);
    const userId = (await created.json() as { data: { userId: string } }).data.userId;
    const [gym] = await database.forSystem((tx) => tx.select().from(gyms));
    const gymId = gym!.id;
    expect(await database.forGym(gymId, (tx) => tx.select().from(staffRoles))).toMatchObject([{ userId, role: 'owner' }]);
    expect((await call('/api/setup/owner', 'POST', owner)).status).toBe(404);
    const login = await call('/api/auth/sign-in/email', 'POST', { email: owner.email, password: owner.password });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    expect(cookie).toBeTruthy();
    let revision = (await service.status()).revision;
    const details = { name: 'Mat Academy', timezone: 'America/Vancouver', currency: 'CAD', address: { street: '123 Main' }, branding: { logoKey: null, primaryColor: '#2563eb' } };
    expect((await call('/api/setup/gym', 'PUT', { ...details, revision })).status).toBe(401);
    expect((await call('/api/setup/website', 'PUT', { revision, websiteEnabled: true, existingSiteUrl: null }, cookie)).status).toBe(409);
    const updated = await call('/api/setup/gym', 'PUT', { ...details, revision }, cookie); expect(updated.status).toBe(200);
    expect((await call('/api/setup/gym', 'PUT', { ...details, revision }, cookie)).status).toBe(409);
    revision = (await service.status()).revision;
    expect((await call('/api/setup/packs', 'POST', { revision, packs: [{ packId: 'unknown', version: 1 }] }, cookie)).status).toBe(400);
    expect((await call('/api/setup/packs', 'POST', { revision, packs: [{ packId: pack.id, version: pack.version }] }, cookie)).status).toBe(200);
    const colors = await database.forGym(gymId, (tx) => tx.select({ color: ranks.color }).from(ranks));
    expect(colors.some((rank) => rank.color === '#ffffff')).toBe(true);
    expect((await database.forGym(gymId, (tx) => tx.select().from(programs))).length).toBeGreaterThan(0);
    revision = (await service.status()).revision;
    expect((await call('/api/setup/website', 'PUT', { revision, websiteEnabled: false, existingSiteUrl: 'https://academy.example.org' }, cookie)).status).toBe(200);
    revision = (await service.status()).revision;
    const mail = { choice: 'configure', revision, host: 'smtp.example.org', port: 587, secure: false,
      username: 'sender', password: 'private-smtp-password', from: 'gym@example.org', testTo: owner.email };
    sendTest.mockRejectedValueOnce(new Error('provider leaked secret'));
    const failure = await call('/api/setup/smtp', 'PUT', mail, cookie);
    expect(await failure.json()).toMatchObject({ data: { test: 'failed', configured: false, revision } });
    expect(await smtp.configured(gymId)).toBe(false);
    expect((await call('/api/setup/smtp', 'PUT', mail, cookie)).status).toBe(200);
    expect(sendTest).toHaveBeenCalledWith(expect.objectContaining({ security: 'starttls' }), expect.objectContaining({ to: owner.email }));
    expect(await smtp.configured(gymId)).toBe(true);
    expect(passwordLogin(config, await smtp.configured(gymId))).toBe(false);
    expect((await call('/api/auth/sign-in/email', 'POST', { email: owner.email, password: owner.password })).status).toBe(404);
    revision = (await service.status()).revision;
    expect((await call('/api/setup/stripe', 'PUT', { choice: 'skip', revision }, cookie)).status).toBe(200);
    revision = (await service.status()).revision;
    const destination = { endpoint: 'https://s3.example.org', region: 'auto', bucket: 'gym-backups', accessKeyId: 'access-key', secretAccessKey: 'private-storage-key' };
    const backup = await call('/api/setup/backups', 'POST', { revision, destination }, cookie); expect(backup.status).toBe(200);
    const keys = (await backup.json() as { data: { privateKey: string; publicKey: string; revision: number } }).data;
    revision = keys.revision;
    expect(await identityToRecipient(keys.privateKey)).toBe(keys.publicKey);
    await expect(loadBackupConfig(key)).rejects.toThrow('not configured');
    expect((await call('/api/setup/finish', 'POST', { choice: 'fresh', revision }, cookie)).status).toBe(409);
    expect((await call('/api/setup/backups/confirm', 'POST', { revision, privateKey: await generateIdentity() }, cookie)).status).toBe(400);
    expect((await call('/api/setup/backups/confirm', 'POST', { revision, privateKey: keys.privateKey }, cookie)).status).toBe(200);
    const saved = await loadBackupConfig(key);
    expect(saved.recipient).toBe(keys.publicKey); expect(saved.blobKey).toHaveLength(32); expect(saved.budgetBytes).toBe(8_000_000_000);
    expect(saved.destination).toEqual(destination);
    const [row] = await database.forSystem((tx) => tx.select().from(gyms));
    expect(decryptSecret(key, 's3_config', row!.s3Config!)).toContain('private-storage-key');
    const audits = await database.forGym(gymId, (tx) => tx.select().from(auditEvents));
    expect(JSON.stringify([row, audits], (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(keys.privateKey);
    expect(JSON.stringify(audits)).not.toMatch(/private-smtp-password|private-storage-key|owner-password/);
    expect(audits.every((audit) => audit.occurredAt.getTime() === clock.now().getTime())).toBe(true);
    revision = (await service.status()).revision;
    expect((await call('/api/setup/finish', 'POST', { choice: 'fresh', revision }, cookie)).status).toBe(200);
    for (const name of ['status', 'start', 'owner', 'gym', 'packs', 'website', 'smtp', 'stripe', 'backups', 'confirmBackupKey', 'finish'] as const) {
      const contract = setupContracts[name];
      const result = await call(contract.path, contract.method.toUpperCase(), name === 'status' ? undefined : name === 'start' ? { choice: 'fresh' } : name === 'owner' ? owner : name === 'gym' ? { ...details, revision } : name === 'packs' ? { revision, packs: [] } : name === 'website' ? { revision, websiteEnabled: true, existingSiteUrl: null } : name === 'smtp' || name === 'stripe' ? { revision, choice: 'skip' } : name === 'backups' ? { revision, destination } : name === 'confirmBackupKey' ? { revision, privateKey: keys.privateKey } : { revision, choice: 'fresh' }, cookie);
      expect(result.status, name).toBe(404);
    }
    const [finished] = await database.forSystem((tx) => tx.select().from(gyms).where(eq(gyms.id, gymId)));
    expect(finished).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false });
    expect(await service.assertEmpty().catch((error: unknown) => error)).toMatchObject({ code: 'not_found' });
  });
  it('hides first-boot setup in multi and demo mode', async () => {
    for (const env of [{ TENANCY: 'multi' }, { DEMO_MODE: 'true' }]) {
      await expect(createSetupService({ key, origin, env }).status()).rejects.toMatchObject({ code: 'not_found' });
    }
  });
});
