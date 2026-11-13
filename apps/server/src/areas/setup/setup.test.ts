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
import { googleCallbackPath, gymAddressSchema, setupContracts, setupStatusResponseSchema } from '@plaingym/shared/contracts';
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
import type { CheckGoogle } from '../settings/google-login.js';

const database = useTestDatabase(), clock = new TestClock('2026-10-22T12:00:00Z');
const key = parseEncryptionKey('ab'.repeat(32)), origin = 'http://gym.localhost';
const setupToken = 'private-setup-token-at-least-32-characters';
const env = { AUTH_SECRET: 'setup-test-secret-with-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'auto' };
const config = authConfig(env), sendTest = vi.fn(async () => { assertNoTransaction('setup test email'); });
const checkDestination = vi.fn(async () => { assertNoTransaction('setup backup destination check'); });
const ownerService = createOwnerService({ accounts: createAccountService(config), clock, async sendMagicLink() { throw new Error('Password bootstrap must not send a link'); } });
const checkGoogle = vi.fn<CheckGoogle>(async () => { assertNoTransaction('setup Google check'); return 'accepted'; });
const registered = vi.fn(async () => ({ endpointId: 'we_synthetic', webhookSecret: 'whsec_private_signing_secret', reused: false }));
const service = createSetupService({ key, origin, clock, env, provisionOwner: ownerService, sendTest, checkDestination, checkGoogle,
  stripeProvisioner: () => ({ async validate() { assertNoTransaction('setup Stripe validation'); }, register: registered,
    async retire() { return { deleted: [], failures: [] }; }, async remove() { return false; }, async check() { return { status: 'current' as const }; } }) });
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
const app = (setupRoutes = createSetupRoutes({ service: () => service })) => createApp({ clock, installOrigin: origin, origin, publicDirectory: directory, setupToken,
  contributions: { routes: [...setupRoutes, ...createContentPackRoutes()] },
  resolveGym: createTenantResolver(), authorize,
  session: sessionMiddleware({ auth, smtpConfigured: (gymId) => smtp.configured(gymId), resolve: (c) => ({
    gymId: c.get('context').gym.gymId, origin, clientIp: '127.0.0.1',
  }) }),
});
describe('first-boot setup', () => {
  it('rejects missing and incorrect tokens before public setup actions can reserve an install', async () => {
    const server = app();
    for (const contract of [setupContracts.start, setupContracts.owner, setupContracts.restore]) {
      for (const token of [undefined, 'wrong-token']) expect((await server.request(origin + contract.path, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', ...(token ? { 'x-setup-token': token } : {}) }, body: '{}',
      })).status).toBe(403);
    }
    expect((await server.request(origin + '/api/setup')).status).toBe(200);
    expect(await database.forSystem((tx) => tx.select().from(gyms))).toHaveLength(0);
  });
  it('uses the same password limit as the adapter', async () => {
    const body = { name: 'Owner', email: 'owner@example.org', password: 'x'.repeat(129) };
    expect((await app().request(origin + '/api/setup/owner', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-setup-token': setupToken }, body: JSON.stringify(body) })).status).toBe(400);
    expect(await service.status()).toMatchObject({ currentStep: 0 });
  });
  it('takes its key, origin and environment from the runtime options, and answers unavailable without them', async () => {
    const restore = { choice: 'restore', snapshotPrefix: 'snapshots/one', privateKey: 'AGE-SECRET-KEY-1ABC',
      source: { endpoint: 'https://s3.example.org', region: 'auto', bucket: 'backups', accessKeyId: 'access', secretAccessKey: 'secret' } };
    const start = (server: ReturnType<typeof app>) => server.request(origin + '/api/setup/restore', { method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-setup-token': setupToken }, body: JSON.stringify(restore) });
    const configured = app(createSetupRoutes({ config: { key, origin, env: {} } }));
    expect(await (await configured.request(origin + '/api/setup')).json()).toMatchObject({ data: { currentStep: 0 } });
    // Its environment is the one it was given: a multi-gym environment hides setup, and restore has no staging directory.
    expect((await app(createSetupRoutes({ config: { key, origin, env: { TENANCY: 'multi' } } })).request(origin + '/api/setup')).status).toBe(404);
    const noStaging = await start(configured);
    expect(noStaging.status).toBe(503);
    expect(JSON.stringify(await noStaging.json())).toContain('Restore is not configured');
    const unconfigured = app(createSetupRoutes());
    const status = await unconfigured.request(origin + '/api/setup');
    expect(status.status).toBe(503);
    expect(JSON.stringify(await status.json())).toContain('Setup is not configured');
    const refused = await start(unconfigured);
    expect(refused.status).toBe(503);
    expect(JSON.stringify(await refused.json())).toContain('Restore is not configured');
  });
  it('completes a fresh wizard with real owner authentication, packs, SMTP and compatible backups', async () => {
    const server = app();
    const call = (path: string, method = 'GET', body?: unknown, cookie?: string) => server.request(origin + path, {
      method, headers: { host: 'gym.localhost', origin, 'content-type': 'application/json', 'x-setup-token': setupToken, ...(cookie ? { cookie } : {}) },
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
    const details = { name: 'Mat Academy', timezone: 'America/Vancouver', currency: 'CAD', address: { line1: '123 Main' }, branding: { logoKey: null, primaryColor: '#2563eb' } };
    expect((await call('/api/setup/gym', 'PUT', { ...details, revision })).status).toBe(401);
    expect((await call('/api/setup/website', 'PUT', { revision, websiteEnabled: true, existingSiteUrl: null }, cookie)).status).toBe(409);
    // Settings and the shell bootstrap read the same address shape, so setup must not store any other.
    expect((await call('/api/setup/gym', 'PUT', { ...details, address: { street: '123 Main' }, revision }, cookie)).status).toBe(400);
    // A pasted zone with spaces around it is the same zone here as in settings and `gyms create`.
    const updated = await call('/api/setup/gym', 'PUT', { ...details, timezone: ' America/Vancouver ', revision }, cookie); expect(updated.status).toBe(200);
    const [stored] = await database.forSystem((tx) => tx.select({ address: gyms.address, timezone: gyms.timezone }).from(gyms));
    expect(gymAddressSchema.parse(stored!.address)).toEqual({ line1: '123 Main' });
    expect(stored!.timezone).toBe('America/Vancouver');
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
    const google = { clientId: 'setup-client.apps.googleusercontent.com', clientSecret: 'private-google-secret' };
    // The optional Google page follows the email step.
    expect((await call('/api/setup/google', 'PUT', { ...google, revision }, cookie)).status).toBe(409);
    expect((await call('/api/setup/decisions', 'PUT', { revision, decision: 'skip_google' }, cookie)).status).toBe(409);
    expect(checkGoogle).not.toHaveBeenCalled();
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
    expect((await call('/api/setup/google', 'PUT', { ...google, revision })).status).toBe(401);
    expect((await call('/api/setup/google', 'PUT', { ...google, clientSecret: 'has space', revision }, cookie)).status).toBe(400);
    expect((await call('/api/setup/google', 'PUT', { ...google, revision: revision - 1 }, cookie)).status).toBe(409);
    expect(checkGoogle).not.toHaveBeenCalled();
    // A client Google's token endpoint refused is a field error, and nothing is stored.
    checkGoogle.mockResolvedValueOnce('rejected');
    const googleRefused = await call('/api/setup/google', 'PUT', { ...google, revision }, cookie);
    expect(googleRefused.status).toBe(400);
    expect(await googleRefused.json()).toMatchObject({ error: { details: { reason: ['google_rejected'] } } });
    expect(await database.forSystem((tx) => tx.select({ google: gyms.googleConfig, revision: gyms.revision }).from(gyms))).toEqual([{ google: null, revision }]);
    const googleSaved = await call('/api/setup/google', 'PUT', { ...google, revision }, cookie);
    expect(await googleSaved.json()).toEqual({ data: { configured: true, check: 'accepted', revision: revision + 1 } });
    expect(checkGoogle).toHaveBeenLastCalledWith(google, origin + googleCallbackPath);
    const [withGoogle] = await database.forSystem((tx) => tx.select().from(gyms));
    expect(JSON.parse(decryptSecret(key, { secretClass: 'google_config', owner: gymId }, withGoogle!.googleConfig!))).toEqual(google);
    // It changes no step: payments come next.
    expect(await service.status()).toMatchObject({ currentStep: 6, completedSteps: [0, 1, 2, 3, 4, 5], googleSkipped: false, backupsLater: false });
    revision = (await service.status()).revision;
    // Recorded decisions survive a reopened wizard; backups can be set up later only after the payments step.
    expect((await call('/api/setup/decisions', 'PUT', { revision, decision: 'backups_later' }, cookie)).status).toBe(409);
    expect((await call('/api/setup/decisions', 'PUT', { revision, decision: 'skip_google' })).status).toBe(401);
    expect((await call('/api/setup/decisions', 'PUT', { revision: revision - 1, decision: 'skip_google' }, cookie)).status).toBe(409);
    const skipped = await call('/api/setup/decisions', 'PUT', { revision, decision: 'skip_google' }, cookie);
    expect(await skipped.json()).toMatchObject({ data: { currentStep: 6, completedSteps: [0, 1, 2, 3, 4, 5], googleSkipped: true, backupsLater: false, revision: revision + 1 } });
    revision = (await service.status()).revision;
    const stripe = await call('/api/setup/stripe', 'PUT', { choice: 'configure', restrictedKey: 'rk_test_PrivateSetupKey', revision }, cookie);
    expect(await stripe.json()).toMatchObject({ data: { configured: true, mode: 'test', webhookRegistered: true } });
    expect(registered).toHaveBeenCalledWith(gymId, origin, revision, undefined);
    const [configured] = await database.forSystem((tx) => tx.select().from(gyms));
    expect(JSON.parse(decryptSecret(key, { secretClass: 'stripe_config', owner: gymId }, configured!.stripeConfig!))).toEqual({ apiKey: 'rk_test_PrivateSetupKey',
      mode: 'test', endpointId: 'we_synthetic', webhookSecret: 'whsec_private_signing_secret' });
    revision = (await service.status()).revision;
    const later = await call('/api/setup/decisions', 'PUT', { revision, decision: 'backups_later' }, cookie);
    expect(await later.json()).toMatchObject({ data: { currentStep: 8, completedSteps: [0, 1, 2, 3, 4, 5, 6], googleSkipped: true, backupsLater: true } });
    expect(await service.status()).toMatchObject({ currentStep: 8, backupsLater: true });
    revision = (await service.status()).revision;
    const now = await call('/api/setup/decisions', 'PUT', { revision, decision: 'backups_now' }, cookie);
    expect(await now.json()).toMatchObject({ data: { currentStep: 7, backupsLater: false, googleSkipped: true } });
    revision = (await service.status()).revision;
    const destination = { endpoint: 'https://s3.example.org', region: 'auto', bucket: 'gym-backups', accessKeyId: 'access-key', secretAccessKey: 'private-storage-key' };
    checkDestination.mockRejectedValueOnce(new Error('Forbidden'));
    const refused = await call('/api/setup/backups', 'POST', { revision, destination }, cookie);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { details: { destination: ['unreachable'] } } });
    expect(await database.forSystem((tx) => tx.select({ recipient: gyms.backupPublicKey, destination: gyms.backupDestination, revision: gyms.revision }).from(gyms)))
      .toEqual([{ recipient: null, destination: null, revision }]);
    const backup = await call('/api/setup/backups', 'POST', { revision, destination }, cookie); expect(backup.status).toBe(200);
    // The private key is shown once; no cache may keep the answer.
    expect(backup.headers.get('cache-control')).toBe('no-store');
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
    // A key a newer release stored doesn't stop this release's snapshots.
    await database.forSystem((tx) => tx.update(gyms).set({ backupDestination: { ...row!.backupDestination as object, newerKey: true } }));
    expect((await loadBackupConfig(key)).destination).toEqual(destination);
    await database.forSystem((tx) => tx.update(gyms).set({ backupDestination: row!.backupDestination }));
    expect(decryptSecret(key, { secretClass: 's3_config', owner: gymId }, row!.s3Config!)).toContain('private-storage-key');
    const audits = await database.forGym(gymId, (tx) => tx.select().from(auditEvents));
    expect(audits.filter((audit) => audit.action === 'setup.email_tested').map((audit) => audit.after))
      .toEqual(expect.arrayContaining([{ test: 'failed' }, { test: 'sent' }]));
    expect(audits.find((audit) => audit.action === 'setup.step_completed' && (audit.after as { step?: number }).step === 5))
      .toMatchObject({ after: { step: 5, test: 'sent' } });
    expect(JSON.stringify([row, audits], (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(keys.privateKey);
    expect(JSON.stringify(audits)).not.toMatch(/private-smtp-password|private-storage-key|owner-password|PrivateSetupKey|whsec_|private-google-secret|setup-client/);
    expect(audits.find((audit) => audit.action === 'setup.google_saved')).toMatchObject({ before: { source: 'none' }, after: { source: 'gym' } });
    expect(audits.filter((audit) => audit.action === 'setup.decision_recorded').map((audit) => (audit.after as { decision: string }).decision).sort())
      .toEqual(['backups_later', 'backups_now', 'skip_google']);
    expect(audits.every((audit) => audit.occurredAt.getTime() === clock.now().getTime())).toBe(true);
    revision = (await service.status()).revision;
    expect((await call('/api/setup/finish', 'POST', { choice: 'fresh', revision }, cookie)).status).toBe(200);
    for (const name of ['status', 'start', 'owner', 'gym', 'packs', 'website', 'smtp', 'google', 'decide', 'stripe', 'backups', 'confirmBackupKey', 'finish'] as const) {
      const contract = setupContracts[name];
      const result = await call(contract.path, contract.method.toUpperCase(), name === 'status' ? undefined : name === 'start' ? { choice: 'fresh' } : name === 'owner' ? owner : name === 'gym' ? { ...details, revision } : name === 'packs' ? { revision, packs: [] } : name === 'website' ? { revision, websiteEnabled: true, existingSiteUrl: null } : name === 'smtp' || name === 'stripe' ? { revision, choice: 'skip' } : name === 'google' ? { ...google, revision } : name === 'decide' ? { revision, decision: 'skip_google' } : name === 'backups' ? { revision, destination } : name === 'confirmBackupKey' ? { revision, privateKey: keys.privateKey } : { revision, choice: 'fresh' }, cookie);
      expect(result.status, name).toBe(404);
    }
    const [finished] = await database.forSystem((tx) => tx.select().from(gyms).where(eq(gyms.id, gymId)));
    expect(finished).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false });
    expect(await service.assertEmpty().catch((error: unknown) => error)).toMatchObject({ code: 'not_found' });
  });
  it('hides first-boot setup in multi and demo mode', async () => {
    const google = { revision: 1, clientId: 'client', clientSecret: 'secret' };
    const context = { gymId: '01900000-0000-7000-8000-000000000001', actor: { kind: 'user' as const, userId: '01900000-0000-7000-8000-000000000002' } };
    for (const env of [{ TENANCY: 'multi' }, { DEMO_MODE: 'true' }]) {
      await expect(createSetupService({ key, origin, env }).status()).rejects.toMatchObject({ code: 'not_found' });
      await expect(createSetupService({ key, origin, env }).google(context, google)).rejects.toMatchObject({ code: 'not_found' });
    }
  });
  it('offers no Google page when the install’s configuration sets Google', async () => {
    const installEnv = { ...env, GOOGLE_CLIENT_ID: 'install-client', GOOGLE_CLIENT_SECRET: 'install-secret' };
    const context = { gymId: '01900000-0000-7000-8000-000000000001', actor: { kind: 'user' as const, userId: '01900000-0000-7000-8000-000000000002' } };
    await expect(createSetupService({ key, origin, env: installEnv }).google(context, { revision: 1, clientId: 'client', clientSecret: 'secret' }))
      .rejects.toMatchObject({ code: 'conflict', details: { google: ['install_configured'] } });
  });
});
