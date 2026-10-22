// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
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
import { encryptSmtpConfig } from '../settings/smtp.js';
import { PostgresJobStatsQuery } from '../../infra/jobs/postgres.js';
import { createStatusProviders } from './status.providers.js';
import { createHealthService, healthProvider } from './status.js';
import { createStatusRoutes } from './status.routes.js';

const database = useTestDatabase(), factory = createFactories(database), gymA = uuidv7(), gymB = uuidv7();
const clock = new TestClock('2026-10-22T12:00:00Z'), key = Buffer.alloc(32, 9);
const context = (gymId = gymA): StaffProviderContext => ({ gymId, roles: ['owner'], clock });
const env = { APP_ENCRYPTION_KEY: key.toString('hex'), TENANCY: 'multi', UPLOADS_DIR: '/uploads', BACKUP_STAGING_DIR: '/staging', APP_VERSION: '0.1.0', SOURCE_URL: 'https://example.test/source/v0.1.0' };
const disk = vi.fn(async () => ({ blocks: 20_000_000, bsize: 1024, bavail: 10_000_000 }));
const providers = () => createStatusProviders({ env, scope: database.forGym, jobs: new PostgresJobStatsQuery(database), disk });
const service = () => createHealthService(providers());
let userId: string;
beforeAll(async () => {
  await factory('gyms', gymA, { smtpConfig: encryptSmtpConfig(key, { host: 'private.host', port: 587, security: 'starttls', from: 'owner@example.test', username: 'private-user', password: 'private-password' }) });
  await factory('gyms', gymB);
  userId = (await factory('authUser', gymA)).id;
  await factory('jobs', gymB, { status: 'failed' });
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
  const list = createStatusProviders({ env, scope: database.forGym, jobs: new PostgresJobStatsQuery(database), disk, ...options });
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
    expect(b.tiles.find((t) => t.id === 'failed_jobs')).toMatchObject({ status: 'error', details: { failed: 1, oldestFailureAt: null } });
    expect(a.tiles.find((t) => t.id === 'smtp')).toMatchObject({ status: 'healthy', message: expect.stringContaining('own SMTP') });
    expect(b.tiles.find((t) => t.id === 'smtp')).toMatchObject({ status: 'not_configured' });
    expect(JSON.stringify(a)).not.toMatch(/private.host|private-user|private-password|v1\./);
  });
});

describe('built-in providers', () => {
  it('reports install SMTP fallback and prefers the gym settings', async () => {
    const fallback = { ...env, SMTP_HOST: 'fallback.private', SMTP_FROM: 'install@example.test', SMTP_USER: 'fallback-user', SMTP_PASS: 'fallback-secret' };
    expect(await tile('smtp', gymB, { env: fallback })).toMatchObject({ status: 'healthy', message: expect.stringContaining('install�s') });
    expect(await tile('smtp', gymA, { env: fallback })).toMatchObject({ status: 'healthy', message: expect.stringContaining('own SMTP') });
  });
  it('surfaces corrupt encrypted SMTP as unavailable without leaking its contents', async () => {
    const id = uuidv7(); await factory('gyms', id, { smtpConfig: 'sensitive-invalid-ciphertext' });
    const result = await createHealthService(providers()).get(context(id));
    expect(result.data.tiles.find((t) => t.id === 'smtp')).toMatchObject({ status: 'unavailable', details: null });
    expect(JSON.stringify(result)).not.toContain('sensitive-invalid');
  });
  it('checks free space in both directories, including a low staging disk and a full uploads disk', async () => {
    const check = vi.fn(async (path: string) => ({ blocks: 20_000_000, bsize: 1024, bavail: path === '/staging' ? 500_000 : 10_000_000 }));
    expect(await tile('disk')).toMatchObject({ status: 'healthy', details: { availableBytes: 10_240_000_000 } });
    expect(await tile('disk', gymA, { disk: check })).toMatchObject({ status: 'warning', details: { availableBytes: 512_000_000 }, message: expect.stringContaining('staging 488 MiB') });
    expect(check.mock.calls.map(([path]) => path).sort()).toEqual(['/staging', '/uploads']);
    expect(await tile('disk', gymA, { disk: async () => ({ blocks: 1000, bsize: 1024, bavail: 0 }) })).toMatchObject({ status: 'error' });
    const result = await createHealthService(createStatusProviders({ env, disk: async () => { throw new Error('/private/path secret'); } })).get(context());
    expect(result.data.tiles.find((t) => t.id === 'disk')).toMatchObject({ status: 'unavailable', details: null });
    expect(JSON.stringify(result)).not.toContain('/private/path');
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
  last_backup: { latestRestorableAt: clock.now().toISOString(), ageSeconds: 0, overdue: false, retainedBytes: 1, retentionBudgetBytes: 1000, pruningStopped: false, keyReminder: true },
  failed_jobs: { failed: 0, pending: 0, running: 0, oldestFailureAt: null }, smtp: { configured: true, lastTestAt: null },
  disk: { totalBytes: 100, availableBytes: 50 }, version: { version: '0.1.0', sourceUrl: 'https://example.test/source' },
  stripe_webhooks: { lastReceivedAt: null, lastProcessedAt: null, pending: 0, failed: 0 },
  last_charge_run: { lastStartedAt: null, lastCompletedAt: null, result: 'succeeded', invoicesProcessed: 1, failures: 0 },
  automatic_updates: { enabled: true, lastAttemptAt: null, result: 'up_to_date', fromVersion: null, toVersion: null },
  update_available: { currentVersion: '0.1.0', latestVersion: '0.1.0', available: false, releaseUrl: null },
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
    expect(result.data.tiles.filter((t) => t.status === 'not_configured')).toHaveLength(7);
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
