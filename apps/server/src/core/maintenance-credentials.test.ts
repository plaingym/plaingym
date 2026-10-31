// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, describe, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import type { JobHandler } from '../infra/jobs/index.js';
import { DurableUploads } from '../infra/storage/common.js';
import { PostgresMaintenance } from '../areas/health/backups.database.js';
import { UPLOAD_SWEEP_JOB } from '../areas/health/uploads-sweep.js';
import { clock } from './clock.js';
import { assertMaintenanceCredentials, maintenanceVariables } from './maintenance-credentials.js';
import { startRuntime, type Runtime } from './runtime.js';

const secret = 'maintenance:private-password@postgres:5432/plaingym';
const credentials = { MAINTENANCE_PASSWORD: 'private-password', MAINTENANCE_DATABASE_URL: 'postgres://' + secret };
const production = { NODE_ENV: 'production' };
describe('maintenance credentials', () => {
  it.each(maintenanceVariables)('refuses %s in multi mode, naming the variable but never its value', (name) => {
    const start = () => assertMaintenanceCredentials({ ...production, TENANCY: 'multi', [name]: credentials[name] });
    expect(start).toThrow(name);
    try { start(); } catch (error) { expect((error as Error).message).not.toContain('private-password'); }
  });
  it('leaves single mode (the default) unchanged', () => {
    expect(() => assertMaintenanceCredentials({ ...production, TENANCY: 'single', ...credentials })).not.toThrow();
    expect(() => assertMaintenanceCredentials({ ...production, ...credentials })).not.toThrow();
  });
  it('accepts multi mode without them, including variables left empty by Compose', () => {
    expect(() => assertMaintenanceCredentials({ ...production, TENANCY: 'multi' })).not.toThrow();
    expect(() => assertMaintenanceCredentials({ ...production, TENANCY: 'multi', MAINTENANCE_PASSWORD: '', MAINTENANCE_DATABASE_URL: '' })).not.toThrow();
  });
  it('lets local development share one .env with the migration command', () => {
    expect(() => assertMaintenanceCredentials({ TENANCY: 'multi', ...credentials })).not.toThrow();
    expect(() => assertMaintenanceCredentials({ NODE_ENV: 'development', TENANCY: 'multi', ...credentials })).not.toThrow();
  });
  it('rejects an unknown tenancy mode', () => {
    expect(() => assertMaintenanceCredentials({ ...production, TENANCY: 'shared' })).toThrow('Invalid TENANCY mode');
  });
});

const database = useTestDatabase(), factory = createFactories(database);
let runtime: Runtime | undefined;
afterAll(async () => {
  await runtime?.stop();
  vi.restoreAllMocks();
});

it('starts and serves gyms in multi mode without maintenance credentials, never opening the maintenance role', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const handlers = new Map<string, JobHandler>(), register = PostgresJobs.prototype.handle;
  vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler) {
    handlers.set(name, handler); register.call(this, name, handler);
  });
  const locked = vi.spyOn(PostgresMaintenance.prototype, 'locked');
  const sweep = vi.spyOn(DurableUploads.prototype, 'sweep').mockResolvedValue([]);
  const gymA = uuidv7(), gymB = uuidv7();
  await factory('gyms', gymA); await factory('gymDomains', gymA, { hostname: 'a.multi.example.test' });
  await factory('gyms', gymB); await factory('gymDomains', gymB, { hostname: 'b.multi.example.test' });
  const env = { DATABASE_URL: database.appUrl, APP_ENCRYPTION_KEY: 'cd'.repeat(32), TENANCY: 'multi', NODE_ENV: 'production',
    AUTH_SECRET: 'multi-runtime-secret-with-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'off',
    SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'gym@example.test',
    UPLOADS_S3_BUCKET: 'multi-uploads', UPLOADS_S3_ENDPOINT: 'https://storage.example.test',
    // As in the multi-gym Compose files: no restore staging, so no restore gate.
    UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test' };
  assertMaintenanceCredentials(env);
  runtime = await startRuntime(env);

  for (const host of ['a.multi.example.test', 'b.multi.example.test']) {
    const response = await runtime.app.request(`https://${host}/api/public/config`, { headers: { host } });
    expect(response.status).toBe(200);
  }
  expect((await runtime.app.request('https://unknown.multi.example.test/api/public/config',
    { headers: { host: 'unknown.multi.example.test' } })).status).toBe(404);
  // The daily upload sweep runs without the install-wide backup lock, which only the maintenance role can take.
  await handlers.get(UPLOAD_SWEEP_JOB)!({}, { gymId: gymA, clock, timezone: 'UTC', jobId: uuidv7(), attempt: 1 });
  expect(sweep).toHaveBeenCalledOnce();
  expect(locked).not.toHaveBeenCalled();
});
