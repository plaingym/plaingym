// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { healthResponseSchema, healthTileIds, healthTileSchema, type HealthTile } from '@plaingym/shared/contracts';
import { AppError, errorResponse, staffRoles } from '@plaingym/shared';
import { FakeHealthTileProvider } from '../../core/interfaces/extensions.js';
import type { StaffProviderContext } from '../../core/interfaces/extensions.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { encryptSmtpConfig, installSmtpFingerprint } from '../settings/smtp.js';
import { createEmailStatusRecorder } from '../settings/email-status.js';
import { SmtpDeliveryError } from '../../infra/email/smtp.js';
import { encryptSmsConfig } from '../settings/sms.js';
import { encryptGoogleConfig } from '../settings/google-login.js';
import { PostgresJobStatsQuery } from '../../infra/jobs/postgres.js';
import { createStatusProviders, type StatusOptions } from './status.providers.js';
import { setLogSink } from '../../core/log.js';
import * as secrets from '../../core/secrets.js';
import { createHealthService, healthProvider } from './status.js';
import { createStatusRoutes } from './status.routes.js';

const database = useTestDatabase(), factory = createFactories(database), gymA = uuidv7(), gymB = uuidv7();
const clock = new TestClock('2026-10-22T12:00:00Z'), key = Buffer.alloc(32, 9);
const context = (gymId = gymA): StaffProviderContext => ({ gymId, roles: ['owner'], clock });
const env = { APP_ENCRYPTION_KEY: key.toString('hex'), TENANCY: 'multi', UPLOADS_DIR: '/uploads', BACKUP_STAGING_DIR: '/staging', APP_VERSION: '0.1.0', SOURCE_URL: 'https://example.test/source/v0.1.0' };
const disk = vi.fn(async () => ({ blocks: 20_000_000, bsize: 1024, bavail: 10_000_000 }));
const device = vi.fn(async () => 1);
const providers = () => createStatusProviders({ env, scope: database.forGym, jobs: new PostgresJobStatsQuery(database), disk, device });
const service = () => createHealthService(providers());
let userId: string;
beforeAll(async () => {
  await factory('gyms', gymA, { smtpConfig: encryptSmtpConfig(key, gymA, { host: 'private.host', port: 587, security: 'starttls', from: 'owner@example.test', username: 'private-user', password: 'private-password' }) });
  await factory('gyms', gymB);
  userId = (await factory('authUser', gymA)).id;
  await factory('jobs', gymB, { status: 'failed', runAt: new Date('2026-10-20T10:00:00Z') });
});
function server(principal: Principal, gymId = gymA) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'test' }); await next(); });
  app.onError((error, c) => c.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createStatusRoutes(service) }).mount(app, authorize, new Set());
  return app;
}
const owner = (gymId = gymA): Principal => ({ kind: 'staff', gymId, userId, roles: ['owner'] });
async function tile(id: HealthTile['id'], gymId = gymA, options: Parameters<typeof createStatusProviders>[0] = {}) {
  const list = createStatusProviders({ env, scope: database.forGym, jobs: new PostgresJobStatsQuery(database), disk, device, ...options });
  return healthTileSchema.parse(await list.find((provider) => provider.id === id)!.read(context(gymId)));
}

describe('health permissions and isolation against PostgreSQL', () => {
  it.each(staffRoles)('allows only settings managers: %s', async (role) => {
    const response = await server({ kind: 'staff', gymId: gymA, userId, roles: [role] }).request('/api/health');
    expect(response.status).toBe(role === 'owner' || role === 'admin' ? 200 : 403);
    if (response.ok) { expect(healthResponseSchema.safeParse(await response.json()).success).toBe(true); expect(response.headers.get('cache-control')).toBe('no-store'); }
  });
  it('rejects anonymous, kiosk and member principals', async () => {
    for (const principal of [{ kind: 'anonymous' }, { kind: 'kiosk', gymId: gymA, deviceId: uuidv7() },
      { kind: 'member', userId, scope: { gymId: gymA, householdId: uuidv7(), role: 'payer' } }] as Principal[]) {
      expect((await server(principal).request('/api/health')).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
    }
  });
  it('rejects a gym A principal on gym B and scopes jobs, SMTP and query parameters to the resolved gym', async () => {
    expect((await server(owner(), gymB).request('/api/health')).status).toBe(403);
    const a = healthResponseSchema.parse(await (await server(owner()).request('/api/health?gymId=' + gymB)).json()).data;
    const b = healthResponseSchema.parse(await (await server(owner(gymB), gymB).request('/api/health')).json()).data;
    expect(a.tiles.find((t) => t.id === 'failed_jobs')).toMatchObject({ status: 'healthy', details: { failed: 0 } });
    expect(b.tiles.find((t) => t.id === 'failed_jobs')).toMatchObject({ status: 'error', details: { failed: 1, oldestFailureAt: '2026-10-20T10:00:00.000Z' } });
    expect(a.tiles.find((t) => t.id === 'smtp')).toMatchObject({ status: 'healthy', message: expect.stringContaining('own SMTP') });
    expect(b.tiles.find((t) => t.id === 'smtp')).toMatchObject({ status: 'not_configured' });
    expect(JSON.stringify(a)).not.toMatch(/private.host|private-user|private-password|v1\./);
  });
});

describe('built-in providers', () => {
  it('keeps an old failure in error and reports the oldest failure independently of pending jobs', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    expect(await tile('failed_jobs', gymId)).toMatchObject({ status: 'healthy', details: { failed: 0, oldestFailureAt: null } });
    await factory('jobs', gymId, { status: 'failed', runAt: new Date('2026-09-01T00:00:00Z') });
    expect(await tile('failed_jobs', gymId)).toMatchObject({ status: 'error', details: { failed: 1, oldestFailureAt: '2026-09-01T00:00:00.000Z' } });
    await factory('jobs', gymId, { status: 'failed', runAt: new Date('2026-08-01T00:00:00Z') });
    await factory('jobs', gymId, { status: 'pending', runAt: new Date('2026-07-01T00:00:00Z') });
    expect(await tile('failed_jobs', gymId)).toMatchObject({ status: 'error', details: { failed: 2, pending: 1, oldestFailureAt: '2026-08-01T00:00:00.000Z' } });
  });
  it('leaves acknowledged failures out of the tile status and oldest failure time', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    await factory('jobs', gymId, { status: 'failed', runAt: new Date('2026-08-01T00:00:00Z'), acknowledgedAt: clock.now() });
    expect(await tile('failed_jobs', gymId)).toMatchObject({ status: 'healthy', details: { failed: 0, oldestFailureAt: null } });
    await factory('jobs', gymId, { status: 'failed', runAt: new Date('2026-09-01T00:00:00Z') });
    expect(await tile('failed_jobs', gymId)).toMatchObject({ status: 'error', details: { failed: 1, oldestFailureAt: '2026-09-01T00:00:00.000Z' } });
  });
  it('names unreadable SMTP settings, parses the key once and logs once across polls', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId, { smtpConfig: 'corrupt-smtp' });
    const lines: string[] = [], previous = setLogSink(line => lines.push(line));
    const parse = vi.spyOn(secrets, 'parseEncryptionKey');
    try {
      const list = providers();
      expect(parse).not.toHaveBeenCalled();
      for (let poll = 0; poll < 3; poll++) {
        expect(await list.find(provider => provider.id === 'smtp')!.read(context(gymId))).toMatchObject({
          status: 'warning', details: { configured: false, lastTestAt: null },
          message: expect.stringContaining('stored SMTP settings could not be read') });
        await list.find(provider => provider.id === 'google_login')!.read(context(gymId));
      }
      expect(parse).toHaveBeenCalledTimes(1);
      expect(lines.filter(line => line.includes('settings.smtp_config_unreadable'))).toHaveLength(1);
    } finally { parse.mockRestore(); setLogSink(previous); }
  });
  it('reports the demo outbox as ready without requiring SMTP', async () => {
    expect(await tile('smtp', gymB, { env: { ...env, DEMO_MODE: 'true', SMTP_HOST: '', SMTP_FROM: '' } }))
      .toMatchObject({ status: 'healthy', details: { configured: true, lastTestAt: null }, message: expect.stringContaining('in-app outbox') });
  });
  it('reports install SMTP fallback and prefers the gym settings', async () => {
    const fallback = { ...env, SMTP_HOST: 'fallback.private', SMTP_FROM: 'install@example.test', SMTP_USER: 'fallback-user', SMTP_PASS: 'fallback-secret' };
    expect(await tile('smtp', gymB, { env: fallback })).toMatchObject({ status: 'healthy', message: expect.stringContaining("install's") });
    expect(await tile('smtp', gymA, { env: fallback })).toMatchObject({ status: 'healthy', message: expect.stringContaining('own SMTP') });
    const id = uuidv7();
    await factory('gyms', id, { smtpConfig: 'corrupt-smtp' });
    expect(await tile('smtp', id, { env: fallback })).toMatchObject({
      status: 'warning', details: { configured: true, lastTestAt: null },
      message: "Email uses the install's SMTP settings. The gym's stored SMTP settings could not be read. Replace or remove them in Settings → Email.",
    });
  });
  it('shows when the gym\'s own SMTP settings last passed a test email', async () => {
    const id = uuidv7(), smtp = { host: 'tested.host', port: 587, security: 'starttls', from: 'owner@example.test', username: 'u', password: 'p' } as const;
    await factory('gyms', id, { smtpConfig: encryptSmtpConfig(key, id, smtp) });
    const audit = (action: string, occurredAt: string, after: unknown = null) => database.forGym(id, (tx) =>
      writeAudit(tx, { gymId: id, actorKind: 'system', action, targetType: 'gym', targetId: id, after, occurredAt: new Date(occurredAt) }));
    expect(await tile('smtp', id)).toMatchObject({ status: 'healthy', details: { configured: true, lastTestAt: null } });
    // The wizard's email step sends its test before it saves; other steps say nothing about email.
    await audit('setup.step_completed', '2026-10-20T09:00:00Z', { step: 5, revision: 6 });
    await audit('setup.step_completed', '2026-10-20T09:05:00Z', { step: 6, revision: 7 });
    expect(await tile('smtp', id)).toMatchObject({ details: { lastTestAt: '2026-10-20T09:00:00.000Z' } });
    await audit('setup.step_completed', '2026-10-20T11:00:00Z', { step: 5, test: 'not_sent' });
    expect(await tile('smtp', id)).toMatchObject({ details: { lastTestAt: '2026-10-20T09:00:00.000Z' } });
    await audit('integrations.email_saved', '2026-10-21T10:00:00Z');
    expect(await tile('smtp', id)).toMatchObject({ details: { lastTestAt: '2026-10-21T10:00:00.000Z' } });
    await audit('integrations.email_tested', '2026-10-21T11:00:00Z', { test: 'failed' });
    expect(await tile('smtp', id)).toMatchObject({ status: 'warning', details: { configured: true, lastTestAt: '2026-10-21T11:00:00.000Z' },
      message: expect.stringContaining('latest test of submitted email settings failed') });
    await audit('setup.email_tested', '2026-10-21T12:00:00Z', { test: 'sent' });
    expect(await tile('smtp', id)).toMatchObject({ status: 'healthy', details: { lastTestAt: '2026-10-21T12:00:00.000Z' } });
    // Another gym's test says nothing about this one.
    expect(await tile('smtp', gymA)).toMatchObject({ details: { lastTestAt: null } });
    await audit('integrations.email_removed', '2026-10-22T10:00:00Z');
    expect(await tile('smtp', id)).toMatchObject({ details: { lastTestAt: null } });
    // A failed test of settings that were never saved says nothing about the install's settings in use.
    const bare = uuidv7(); await factory('gyms', bare);
    await database.forGym(bare, (tx) => writeAudit(tx, { gymId: bare, actorKind: 'system', action: 'integrations.email_tested', targetType: 'gym', targetId: bare,
      after: { test: 'failed' }, occurredAt: new Date('2026-10-21T11:00:00Z') }));
    expect(await tile('smtp', bare, { env: { ...env, SMTP_HOST: 'fallback.private', SMTP_FROM: 'install@example.test' } }))
      .toMatchObject({ status: 'healthy', details: { configured: true, lastTestAt: null }, message: expect.stringContaining("install's") });
  });
  it('warns about the last email the sending service refused, until a send works', async () => {
    const id = uuidv7(), smtp = { host: 'sending.host', port: 587, security: 'starttls', from: 'owner@example.test', username: 'u', password: 'p' } as const;
    await factory('gyms', id, { smtpConfig: encryptSmtpConfig(key, id, smtp) });
    const sendClock = new TestClock('2026-11-21T09:00:00Z'), report = createEmailStatusRecorder({ scope: database.forGym, clock: sendClock })(id, { ...smtp, source: 'gym' });
    await report({ ok: false, error: new SmtpDeliveryError('not_accepted', 'SMTP authentication failed', { cause: { code: 'EAUTH', responseCode: 535 } }) });
    const failed = await tile('smtp', id);
    expect(failed).toMatchObject({ status: 'warning', details: { configured: true, lastTestAt: null } });
    expect(failed.message).toContain('own SMTP');
    expect(failed.message).toContain('the service rejected the login');
    expect(failed.message).toContain('Settings → Integrations → Email');
    expect(failed.message).not.toContain('SMTP_USER');
    // Another gym's failure says nothing about this one.
    expect((await tile('smtp', gymA)).message).not.toContain('The last email failed');
    sendClock.advance(60_000);
    await report({ ok: true });
    const recovered = await tile('smtp', id);
    expect(recovered).toMatchObject({ status: 'healthy', details: { configured: true, lastTestAt: null } });
    expect(recovered.message).not.toContain('the service rejected the login');
  });
  it('words a refused login through the install\'s settings for the server or its operator, and keeps other classes', async () => {
    const id = uuidv7(); await factory('gyms', id);
    const install = { ...env, SMTP_HOST: 'fallback.private', SMTP_FROM: 'install@example.test', SMTP_USER: 'fallback-user', SMTP_PASS: 'fallback-secret' };
    // Written after this process started, so the install-source failure stands.
    const failure = (failed: string) => database.forGym(id, (tx) => writeAudit(tx, { gymId: id, actorKind: 'system', action: 'email.delivery_failed',
      targetType: 'gym', targetId: id, after: { failure: failed, source: 'install' }, occurredAt: new Date() }));
    await failure('authentication');
    const single = await tile('smtp', id, { env: { ...install, TENANCY: 'single' } });
    expect(single).toMatchObject({ status: 'warning', details: { configured: true } });
    expect(single.message).toContain("install's SMTP settings");
    expect(single.message).toContain('SMTP_USER and SMTP_PASS');
    expect(single.message).not.toContain('Settings → Integrations → Email');
    const multi = await tile('smtp', id, { env: install });
    expect(multi).toMatchObject({ status: 'warning' });
    expect(multi.message).toContain('Whoever runs this install');
    expect(multi.message).not.toContain('SMTP_USER');
    await failure('connection');
    expect((await tile('smtp', id, { env: { ...install, TENANCY: 'single' } })).message)
      .toContain("The last email failed: the app couldn't connect to the sending service.");
  });
  it('words a refused login by the settings it went through, not the ones in use now', async () => {
    // The gym's stored value can no longer be read (restored under another key), so mail now goes through the install's.
    const id = uuidv7(), smtp = { host: 'sending.host', port: 587, security: 'starttls', from: 'owner@example.test', username: 'u', password: 'p' } as const;
    await factory('gyms', id, { smtpConfig: encryptSmtpConfig(Buffer.alloc(32, 3), id, smtp) });
    await database.forGym(id, (tx) => writeAudit(tx, { gymId: id, actorKind: 'system', action: 'email.delivery_failed',
      targetType: 'gym', targetId: id, after: { failure: 'authentication', source: 'gym' }, occurredAt: new Date() }));
    const install = { ...env, TENANCY: 'single', SMTP_HOST: 'fallback.private', SMTP_FROM: 'install@example.test', SMTP_USER: 'fallback-user', SMTP_PASS: 'fallback-secret' };
    const unreadable = await tile('smtp', id, { env: install });
    expect(unreadable).toMatchObject({ status: 'warning', details: { configured: true } });
    expect(unreadable.message).toContain("install's");
    expect(unreadable.message).toContain('the service rejected the login');
    expect(unreadable.message).toContain('Settings → Integrations → Email');
    expect(unreadable.message).not.toContain('SMTP_USER');
  });
  it('keeps a failure through the install\'s settings across a restart while they stay the same', async () => {
    const id = uuidv7(); await factory('gyms', id);
    const install = { ...env, TENANCY: 'single', SMTP_HOST: 'fallback.private', SMTP_FROM: 'install@example.test', SMTP_USER: 'fallback-user', SMTP_PASS: 'fallback-secret' };
    // Recorded before this process started, with the settings' fingerprint.
    await database.forGym(id, (tx) => writeAudit(tx, { gymId: id, actorKind: 'system', action: 'email.delivery_failed', targetType: 'gym', targetId: id,
      after: { failure: 'authentication', source: 'install', settings: installSmtpFingerprint(key, install) }, occurredAt: new Date(Date.now() - 86_400_000) }));
    const same = await tile('smtp', id, { env: install });
    expect(same).toMatchObject({ status: 'warning' });
    expect(same.message).toContain('SMTP_USER and SMTP_PASS');
    expect(await tile('smtp', id, { env: { ...install, SMTP_PASS: 'changed-secret' } })).toMatchObject({ status: 'healthy' });
  });
  it('reports no settings as not configured, even with a standing send failure', async () => {
    const id = uuidv7(); await factory('gyms', id);
    await database.forGym(id, (tx) => writeAudit(tx, { gymId: id, actorKind: 'system', action: 'email.delivery_failed',
      targetType: 'gym', targetId: id, after: { failure: 'authentication' }, occurredAt: new Date() }));
    expect(await tile('smtp', id)).toMatchObject({ status: 'not_configured', details: { configured: false }, message: 'Email is not configured.' });
  });
  it('reports Google sign-in: the install’s client, the gym’s own, none, and a malformed variable by name and reason', async () => {
    const single = { ...env, TENANCY: 'single' };
    expect(await tile('google_login', gymA, { env: { ...env, GOOGLE_CLIENT_ID: 'install-id', GOOGLE_CLIENT_SECRET: 'install-secret' } }))
      .toMatchObject({ status: 'healthy', details: { configured: true }, message: expect.stringContaining('server configuration') });
    expect(await tile('google_login', gymA, { env })).toMatchObject({ status: 'not_configured', details: { configured: false }, message: 'Google sign-in is off.' });
    const own = uuidv7();
    await factory('gyms', own, { googleConfig: encryptGoogleConfig(key, own, { clientId: 'gym-client-id', clientSecret: 'private-gym-secret' }) });
    expect(await tile('google_login', own, { env: single })).toMatchObject({ status: 'healthy', message: expect.stringContaining('own client') });
    // Multi-gym installs ignore a stored client.
    expect(await tile('google_login', own, { env })).toMatchObject({ status: 'not_configured' });
    for (const [bad, text] of [[{ GOOGLE_CLIENT_ID: 'has space', GOOGLE_CLIENT_SECRET: 'private-secret' }, 'GOOGLE_CLIENT_ID contains a space'],
      [{ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'x'.repeat(513) }, 'GOOGLE_CLIENT_SECRET is longer than 512 characters'],
      [{ GOOGLE_CLIENT_ID: 'only-the-id' }, 'GOOGLE_CLIENT_SECRET is not set']] as const) {
      const result = await tile('google_login', own, { env: { ...single, ...bad } });
      expect(result).toMatchObject({ status: 'warning', details: { configured: true }, message: expect.stringContaining(text) });
      expect(result.message).toContain("this gym's own client");
      expect(await tile('google_login', gymB, { env: { ...single, ...bad } })).toMatchObject({ status: 'error', details: null });
      expect(await tile('google_login', own, { env: { ...env, ...bad } })).toMatchObject({ status: 'not_configured', message: 'Google sign-in is off.' });
      expect(JSON.stringify(result)).not.toMatch(/has space|private|xxxx|only-the-id|gym-client-id/);
    }
  });
  it('counts corrupt encrypted SMTP as unconfigured without leaking its contents', async () => {
    const id = uuidv7(); await factory('gyms', id, { smtpConfig: 'sensitive-invalid-ciphertext' });
    const result = await createHealthService(providers()).get(context(id));
    expect(result.data.tiles.find((t) => t.id === 'smtp')).toMatchObject({ status: 'warning', details: { configured: false },
      message: "The gym's stored SMTP settings could not be read. Replace or remove them in Settings → Email." });
    expect(JSON.stringify(result)).not.toContain('sensitive-invalid');
  });
  it('invites the owner to turn texts on when the saved provider is readable', async () => {
    const id = uuidv7();
    await factory('gyms', id, { memberSmsEnabled: false, smsConfig: encryptSmsConfig(key, id, {
      accountSid: 'AC' + '1'.repeat(32), auth: { token: 'local-test-token' }, sender: { from: '+12025550111' },
    }) });
    expect(await tile('sms', id, { env: { ...env, TENANCY: 'single' } })).toMatchObject({
      status: 'warning', details: { configured: true, memberSmsEnabled: false },
      message: "The gym's saved provider handles member texts. Member texts are off. Turn them on in Go-live when ready.",
    });
  });
  it.each([
    { smsConfig: null, status: 'not_configured', message: 'No SMS provider is configured.' },
    { smsConfig: 'sensitive-invalid-ciphertext', status: 'warning', message: 'The saved SMS settings could not be read. Replace or remove them in Settings.' },
  ])('reports $status without an invitation to turn texts on', async ({ smsConfig, status, message }) => {
    const id = uuidv7();
    await factory('gyms', id, { memberSmsEnabled: false, smsConfig });
    expect(await tile('sms', id)).toMatchObject({ status, details: { configured: false, memberSmsEnabled: false }, message });
  });
  it('keeps the SMS-on warning and latest failed test when saved settings are unreadable', async () => {
    const id = uuidv7();
    await factory('gyms', id, { memberSmsEnabled: true, smsConfig: 'sensitive-invalid-ciphertext' });
    await database.forGym(id, (tx) => writeAudit(tx, { gymId: id, actorKind: 'system', action: 'integrations.sms_tested',
      targetType: 'gym', targetId: id, after: { test: 'failed' }, occurredAt: clock.now() }));
    const result = await tile('sms', id);
    expect(result).toMatchObject({
      status: 'warning', details: { configured: false, memberSmsEnabled: true, lastTestAt: clock.now().toISOString(), lastTestResult: 'failed' },
      message: [
        'Member texts are on, but cannot be sent until a working SMS provider is saved.',
        'The saved SMS settings could not be read. Replace or remove them in Settings.',
        'The latest owner test failed. Saved SMS settings were kept.',
      ].join(' '),
    });
    expect(JSON.stringify(result)).not.toContain('sensitive-invalid');
  });
  it('checks free space in both directories, including a low staging disk and a full uploads disk', async () => {
    // UPDATE_CHECK=off: reading every tile of a single-gym install would otherwise ask GitHub for the latest release.
    const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
    const separate = vi.fn(async (path: string) => path === '/staging' ? 2 : 1);
    const check = vi.fn(async (path: string) => ({ blocks: 20_000_000, bsize: 1024, bavail: path === '/staging' ? 500_000 : 10_000_000 }));
    expect(await tile('disk', gymA, { env: single, device: separate })).toMatchObject({ status: 'healthy', details: {
      uploads: { totalBytes: 20_480_000_000, availableBytes: 10_240_000_000 },
      backupStaging: { totalBytes: 20_480_000_000, availableBytes: 10_240_000_000 },
    } });
    expect(await tile('disk', gymA, { env: single, disk: check, device: separate })).toMatchObject({ status: 'warning', details: {
      uploads: { totalBytes: 20_480_000_000, availableBytes: 10_240_000_000 },
      backupStaging: { totalBytes: 20_480_000_000, availableBytes: 512_000_000 },
    }, message: expect.stringContaining('staging 0.51 GB') });
    expect(check.mock.calls.map(([path]) => path).sort()).toEqual(['/staging', '/uploads']);
    expect(await tile('disk', gymA, { env: single, device: separate, disk: async () => ({ blocks: 1000, bsize: 1024, bavail: 0 }) })).toMatchObject({ status: 'error' });
    const result = await createHealthService(createStatusProviders({ env: single, device: separate, disk: async () => { throw new Error('/private/path secret'); } })).get(context());
    expect(result.data.tiles.find((t) => t.id === 'disk')).toMatchObject({ status: 'unavailable', details: null });
    expect(JSON.stringify(result)).not.toContain('/private/path');
  });
  it('shows when uploads and backup staging are one filesystem while keeping both figures and the status rules', async () => {
    const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
    const shared = vi.fn(async (_path: string) => 7);
    expect(await tile('disk', gymA, { env: single, device: shared })).toMatchObject({ status: 'healthy', details: {
      sameFilesystem: true,
      uploads: { totalBytes: 20_480_000_000, availableBytes: 10_240_000_000 },
      backupStaging: { totalBytes: 20_480_000_000, availableBytes: 10_240_000_000 },
    }, message: 'Free space: uploads and backup staging (one volume) 10.24 GB.' });
    expect(shared.mock.calls.map(([path]) => path).sort()).toEqual(['/staging', '/uploads']);
    const separate = vi.fn(async (path: string) => path === '/staging' ? 2 : 1);
    expect(await tile('disk', gymA, { env: single, device: separate })).toMatchObject({ details: { sameFilesystem: false },
      message: 'Free space: uploads 10.24 GB; backup staging 10.24 GB.' });
    const noStaging = vi.fn(async (_path: string) => 7);
    expect(await tile('disk', gymA, { env: { ...single, BACKUP_STAGING_DIR: undefined }, device: noStaging })).toMatchObject({
      details: { backupStaging: null, sameFilesystem: false }, message: 'Free space: uploads 10.24 GB.' });
    expect(noStaging.mock.calls.map(([path]) => path)).toEqual(['/uploads']);
    // A shared filesystem is still checked as each volume's figures, with the same error and warning thresholds.
    expect(await tile('disk', gymA, { env: single, device: shared, disk: async () => ({ blocks: 20_000_000, bsize: 1024, bavail: 100 }) }))
      .toMatchObject({ status: 'error', details: { sameFilesystem: true } });
    expect(await tile('disk', gymA, { env: single, device: shared, disk: async () => ({ blocks: 20_000_000, bsize: 1024, bavail: 500_000 }) }))
      .toMatchObject({ status: 'warning', details: { sameFilesystem: true }, message: expect.stringContaining('(one volume)') });
  });
  it('checks a same-device staging quota twice and still shows separate volumes', async () => {
    const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
    const shared = vi.fn(async (_path: string) => 7);
    const quota = vi.fn(async (path: string) => path === '/staging'
      ? { blocks: 1_000_000_000, bsize: 1000, bavail: 500_000_000 }
      : { blocks: 10_000_000_000, bsize: 1000, bavail: 5_000_000_000 });
    expect(await tile('disk', gymA, { env: single, device: shared, disk: quota })).toMatchObject({
      status: 'healthy', details: {
        sameFilesystem: false,
        uploads: { totalBytes: 10_000_000_000_000, availableBytes: 5_000_000_000_000 },
        backupStaging: { totalBytes: 1_000_000_000_000, availableBytes: 500_000_000_000 },
      }, message: 'Free space: uploads 5,000 GB; backup staging 500 GB.',
    });
    expect(quota.mock.calls.map(([path]) => path)).toEqual(['/uploads', '/staging', '/uploads', '/staging']);
  });
  it.each([
    { stagingDevice: 2, stagingBlocks: 10_000_000, sameFilesystem: false },
    { stagingDevice: 7, stagingBlocks: 20_000_000, sameFilesystem: true },
  ])('reads each path once when staging device $stagingDevice reports $stagingBlocks blocks',
    async ({ stagingDevice, stagingBlocks, sameFilesystem }) => {
      const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
      const device = async (path: string) => path === '/staging' ? stagingDevice : 7;
      const disk = vi.fn(async (path: string) => ({
        blocks: path === '/staging' ? stagingBlocks : 20_000_000, bsize: 1024, bavail: 5_000_000,
      }));
      expect(await tile('disk', gymA, { env: single, device, disk })).toMatchObject({ details: { sameFilesystem } });
      expect(disk.mock.calls.map(([path]) => path)).toEqual(['/uploads', '/staging']);
    });
  it('uses the second pair of readings for the whole tile when same-device drift clears', async () => {
    const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
    const bsize = 4096, uploadsTotal = 10_000_000_000_000;
    const disk = vi.fn<NonNullable<StatusOptions['disk']>>()
      .mockResolvedValueOnce({ blocks: uploadsTotal / bsize, bsize, bavail: 0 })
      .mockResolvedValueOnce({ blocks: (uploadsTotal - 67_112_960) / bsize, bsize, bavail: 100 })
      .mockResolvedValueOnce({ blocks: uploadsTotal / bsize, bsize, bavail: 1_000_000_000 })
      .mockResolvedValueOnce({ blocks: uploadsTotal / bsize, bsize, bavail: 500_000_000 });
    expect(await tile('disk', gymA, { env: single, device: async () => 7, disk })).toMatchObject({
      status: 'healthy', details: {
        sameFilesystem: true,
        uploads: { totalBytes: uploadsTotal, availableBytes: 4_096_000_000_000 },
        backupStaging: { totalBytes: uploadsTotal, availableBytes: 2_048_000_000_000 },
      }, message: 'Free space: uploads and backup staging (one volume) 2,048 GB.',
    });
    expect(disk.mock.calls.map(([path]) => path)).toEqual(['/uploads', '/staging', '/uploads', '/staging']);
  });
  it('treats totals within both bounds on one device as one shared volume', async () => {
    const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
    const shared = vi.fn(async (_path: string) => 7);
    // 100 GB and 4 KB more: ZFS or btrfs derive the total from used plus free, so two statfs calls can differ by a few KB.
    const nearlyEqual = vi.fn(async (path: string) => path === '/staging'
      ? { blocks: 100_000_004, bsize: 1000, bavail: 20_000_000 }
      : { blocks: 100_000_000, bsize: 1000, bavail: 20_000_000 });
    expect(await tile('disk', gymA, { env: single, device: shared, disk: nearlyEqual })).toMatchObject({
      status: 'healthy', details: {
        sameFilesystem: true,
        uploads: { totalBytes: 100_000_000_000, availableBytes: 20_000_000_000 },
        backupStaging: { totalBytes: 100_000_004_000, availableBytes: 20_000_000_000 },
      }, message: 'Free space: uploads and backup staging (one volume) 20 GB.',
    });
    expect(nearlyEqual.mock.calls.map(([path]) => path).sort()).toEqual(['/staging', '/uploads']);
  });
  it('treats totals 0.05% apart as one volume and reports the uploads free figure when free space ties', async () => {
    const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
    const apart = vi.fn(async (path: string) => path === '/staging'
      ? { blocks: 5_002_500, bsize: 1000, bavail: 2_000_000 }
      : { blocks: 5_000_000, bsize: 1000, bavail: 2_000_000 });
    expect(await tile('disk', gymA, { env: single, device: async () => 7, disk: apart })).toMatchObject({
      details: { sameFilesystem: true, uploads: { availableBytes: 2_000_000_000 }, backupStaging: { availableBytes: 2_000_000_000 } },
      message: 'Free space: uploads and backup staging (one volume) 2 GB.',
    });
  });
  it('keeps volumes separate when their totals differ by more than 0.1%', async () => {
    const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
    const shared = vi.fn(async (_path: string) => 7);
    const onePercent = vi.fn(async (path: string) => path === '/staging'
      ? { blocks: 5_050_000, bsize: 1000, bavail: 2_000_000 }
      : { blocks: 5_000_000, bsize: 1000, bavail: 2_000_000 });
    expect(await tile('disk', gymA, { env: single, device: shared, disk: onePercent })).toMatchObject({
      details: { sameFilesystem: false }, message: 'Free space: uploads 2 GB; backup staging 2 GB.',
    });
  });
  it.each([
    { difference: 67_108_864, sameFilesystem: true },
    { difference: 67_112_960, sameFilesystem: false },
  ])('reports sameFilesystem as $sameFilesystem for a $difference-byte capacity gap on a 10 TB device',
    async ({ difference, sameFilesystem }) => {
      const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
      const uploadsTotal = 10_000_000_000_000;
      const bsize = 4096;
      const disk = async (path: string) => ({
        blocks: (path === '/staging' ? uploadsTotal - difference : uploadsTotal) / bsize,
        bsize,
        bavail: 1_000_000_000,
      });
      expect(await tile('disk', gymA, { env: single, device: async () => 7, disk }))
        .toMatchObject({ details: { sameFilesystem } });
    });
  it.each([
    { stagingBlocks: 999_000, sameFilesystem: true },
    { stagingBlocks: 998_999, sameFilesystem: false },
  ])('reports sameFilesystem as $sameFilesystem at $stagingBlocks staging blocks on a 1 GB device',
    async ({ stagingBlocks, sameFilesystem }) => {
      const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
      const disk = async (path: string) => ({
        blocks: path === '/staging' ? stagingBlocks : 1_000_000, bsize: 1000, bavail: 500_000,
      });
      expect(await tile('disk', gymA, { env: single, device: async () => 7, disk }))
        .toMatchObject({ details: { sameFilesystem } });
    });
  it('shows the lower free figure when a shared volume reports less free space in staging', async () => {
    const single = { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' };
    const shared = vi.fn(async (_path: string) => 7);
    const stagingLower = vi.fn(async (path: string) => path === '/staging'
      ? { blocks: 100_000_000, bsize: 1000, bavail: 512_000 }
      : { blocks: 100_000_000, bsize: 1000, bavail: 10_000_000 });
    expect(await tile('disk', gymA, { env: single, device: shared, disk: stagingLower })).toMatchObject({
      status: 'warning', details: {
        sameFilesystem: true,
        uploads: { totalBytes: 100_000_000_000, availableBytes: 10_000_000_000 },
        backupStaging: { totalBytes: 100_000_000_000, availableBytes: 512_000_000 },
      }, message: 'Free space: uploads and backup staging (one volume) 0.51 GB.',
    });
  });
  it('checks the uploads volume alone when no restore staging is kept, as in multi-gym mode', async () => {
    const multi = { ...env, BACKUP_STAGING_DIR: undefined };
    const check = vi.fn(async (_path: string) => ({ blocks: 20_000_000, bsize: 1024, bavail: 500_000 }));
    const result = await tile('disk', gymA, { env: multi, disk: check });
    expect(result).toMatchObject({ status: 'warning', details: { uploads: { totalBytes: 20_480_000_000, availableBytes: 512_000_000 }, backupStaging: null, sameFilesystem: false }, message: 'Free space: uploads 0.51 GB.' });
    expect(check.mock.calls.map(([path]) => path)).toEqual(['/uploads']);
    // A nearly full disk still shows its figure rather than rounding to 0 GB.
    expect(await tile('disk', gymA, { env: multi, disk: async () => ({ blocks: 20_000_000, bsize: 1024, bavail: 4_000 }) }))
      .toMatchObject({ status: 'error', message: 'Free space: uploads 0.0041 GB.' });
    expect(await tile('disk', gymA, { env: { ...multi, BACKUP_STAGING_DIR: '' } })).toMatchObject({ status: 'healthy' });
    expect(await tile('disk', gymA, { env: { ...multi, UPLOADS_DIR: '' } })).toMatchObject({ status: 'not_configured' });
    // The app ignores a staging directory set by hand in multi-gym mode, so the tile does too.
    const handSet = vi.fn(async (_path: string) => ({ blocks: 20_000_000, bsize: 1024, bavail: 10_000_000 }));
    await tile('disk', gymA, { env, disk: handSet });
    expect(handSet.mock.calls.map(([path]) => path)).toEqual(['/uploads']);
    // A single-gym install without staging reports the uploads volume alone too.
    expect(await tile('disk', gymA, { env: { ...multi, TENANCY: 'single' } })).toMatchObject({ status: 'healthy', details: { backupStaging: null }, message: 'Free space: uploads 10.24 GB.' });
  });
  it('never reports healthy or fabricates free space when a configured staging directory is missing', async () => {
    const check = vi.fn(async (path: string) => {
      if (path === '/staging') throw Object.assign(new Error('ENOENT /private/staging'), { code: 'ENOENT' });
      return { blocks: 20_000_000, bsize: 1024, bavail: 10_000_000 };
    });
    const result = await createHealthService(createStatusProviders({ env: { ...env, TENANCY: 'single', UPDATE_CHECK: 'off' }, device, disk: check })).get(context());
    expect(result.data.tiles.find(t => t.id === 'disk')).toMatchObject({ status: 'unavailable', details: null });
    expect(check.mock.calls.map(([path]) => path).sort()).toEqual(['/staging', '/uploads']);
    expect(JSON.stringify(result)).not.toContain('/private/staging');
  });
  it('reports missing disk paths and invalid disk statistics safely', async () => {
    expect(await tile('disk', gymA, { env: { ...env, UPLOADS_DIR: '' } })).toMatchObject({ status: 'not_configured' });
    await expect(tile('disk', gymA, { disk: async () => ({ blocks: 0, bsize: 1024, bavail: 0 }) })).rejects.toThrow('Invalid disk');
  });
  it('reports the running version and rejects unsafe source URLs', async () => {
    expect(await tile('version')).toMatchObject({ status: 'healthy', details: { version: '0.1.0', sourceUrl: env.SOURCE_URL } });
    await expect(tile('version', gymA, { env: { ...env, SOURCE_URL: 'javascript:private' } })).rejects.toThrow('Invalid SOURCE_URL');
  });
});

const examples: Record<HealthTile['id'], NonNullable<HealthTile['details']>> = {
  invoice_effects: { exhausted: 0 },
  last_backup: { latestRestorableAt: clock.now().toISOString(), ageSeconds: 0, overdue: false, noneUnderCurrentKey: false, pruningHeld: false, damagedGuardSnapshot: null, missingGuardSnapshot: null, destinationFailure: null, retainedBytes: 1, retentionBudgetBytes: 1000, pruningStopped: false, keyReminder: true },
  failed_jobs: { failed: 0, pending: 0, running: 0, oldestFailureAt: null, failedVersion: 'none' }, smtp: { configured: true, lastTestAt: null },
  disk: { uploads: { totalBytes: 100, availableBytes: 50 }, backupStaging: null, sameFilesystem: false }, version: { version: '0.1.0', sourceUrl: 'https://example.test/source' },
  stripe_webhooks: { lastReceivedAt: null, lastProcessedAt: null, pending: 0, failed: 0 },
  last_charge_run: { lastStartedAt: null, lastCompletedAt: null, result: 'succeeded', invoicesProcessed: 1, failures: 0 },
  automatic_updates: { enabled: true, lastAttemptAt: null, result: 'up_to_date', fromVersion: null, toVersion: null },
  update_available: { currentVersion: '0.1.0', latestVersion: '0.1.0', available: false, releaseUrl: null },
  google_login: { configured: true },
  sms: { configured: true, memberSmsEnabled: true, sentToday: 0, refusedToday: 0, smsDailyCap: 1000, lastTestAt: null, lastTestResult: null },
};
describe('generic provider composition', () => {
  it.each(healthTileIds)('accepts healthy and failing states for %s through the frozen provider interface', async (id) => {
    const fake = new FakeHealthTileProvider(id, healthTileSchema), composed = createHealthService([fake]);
    for (const status of ['healthy', 'error'] as const) {
      fake.set(gymA, healthTileSchema.parse({ id, status, checkedAt: clock.now().toISOString(), details: examples[id], message: status }));
      const result = await composed.get(context());
      expect(result.data.tiles).toHaveLength(healthTileIds.length);
      expect(result.data.tiles.find((tile) => tile.id === id)).toMatchObject({ status, checkedAt: clock.now().toISOString() });
    }
    expect((await composed.get(context(gymB))).data.tiles.find((tile) => tile.id === id)).toMatchObject({ status: 'unavailable' });
  });
  it('fills all missing providers with not set up and isolates thrown errors and malformed payloads', async () => {
    const result = await createHealthService([
      healthProvider('smtp', async () => { throw new Error('SMTP credentials'); }),
      healthProvider('disk', async () => ({ id: 'disk', status: 'healthy', checkedAt: null, details: null, message: 'bad' })),
    ]).get(context());
    expect(result.data.tiles.map((t) => t.id)).toEqual(healthTileIds);
    expect(result.data.tiles.find((t) => t.id === 'smtp')).toMatchObject({ status: 'unavailable' });
    expect(result.data.tiles.find((t) => t.id === 'disk')).toMatchObject({ status: 'unavailable' });
    expect(result.data.tiles.filter((t) => t.status === 'not_configured')).toHaveLength(healthTileIds.length - 2);
    expect(JSON.stringify(result)).not.toContain('SMTP credentials');
  });
  it('does not call providers for a denied role and rejects duplicate registration', async () => {
    const read = vi.fn();
    await expect(createHealthService([healthProvider('smtp', read)]).get({ ...context(), roles: ['coach'] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(healthProvider('smtp', read).read({ ...context(), roles: ['coach'] })).rejects.toMatchObject({ code: 'not_found' });
    expect(read).not.toHaveBeenCalled();
    expect(() => createHealthService([healthProvider('smtp', read), healthProvider('smtp', read)])).toThrow('Duplicate');
  });
});
