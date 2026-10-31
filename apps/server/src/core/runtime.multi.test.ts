// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { atomicJson } from '../areas/health/backups.files.js';
import { startRuntime, type Runtime } from './runtime.js';

const database = useTestDatabase(), factory = createFactories(database);
const origin = 'https://install.multi.example.test', setupToken = 'multi-runtime-setup-token-with-32-characters';
let runtime: Runtime | undefined, directory: string | undefined;
afterAll(async () => {
  await runtime?.stop();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('builds no restore gate in multi mode and answers setup restore as unavailable, even with restore staging set by hand', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'runtime-multi-'));
  const staging = join(directory, 'staging');
  await mkdir(staging);
  // A closed restore state that only a gate would act on: nothing in multi mode reopens it.
  await atomicJson(join(directory, 'restore-state.json'), { phase: 'database' });
  const gymId = uuidv7();
  await factory('gyms', gymId); await factory('gymDomains', gymId, { hostname: 'gym.multi.example.test' });
  const env = { DATABASE_URL: database.appUrl, APP_ENCRYPTION_KEY: 'ef'.repeat(32), TENANCY: 'multi', NODE_ENV: 'production',
    AUTH_SECRET: 'multi-runtime-secret-with-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'off', PUBLIC_ORIGIN: origin,
    SETUP_TOKEN: setupToken, SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'gym@example.test', BACKUP_STAGING_DIR: staging,
    UPLOADS_S3_BUCKET: 'multi-uploads', UPLOADS_S3_ENDPOINT: 'https://storage.example.test',
    UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test' };
  // Setup's restore reads the process environment, which is the runtime's own in production.
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  runtime = await startRuntime(env);

  const gym = await runtime.app.request('https://gym.multi.example.test/api/public/config', { headers: { host: 'gym.multi.example.test' } });
  expect(gym.status).toBe(200);
  const restore = await runtime.app.request(origin + '/api/setup/restore', { method: 'POST',
    headers: { host: new URL(origin).host, origin, 'content-type': 'application/json', 'x-setup-token': setupToken },
    body: JSON.stringify({ choice: 'restore', snapshotPrefix: 'snapshots/one', privateKey: 'AGE-SECRET-KEY-1ABC',
      source: { endpoint: 'https://backups.example.test', region: 'auto', bucket: 'backups', accessKeyId: 'id', secretAccessKey: 'secret' } }),
  });
  expect(restore.status).toBe(503);
  expect(JSON.stringify(await restore.json())).toContain('Restore is not configured');
});
