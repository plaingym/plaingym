// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { setupContracts } from '@plaingym/shared/contracts';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { startRuntime, type Runtime } from './runtime.js';

const database = useTestDatabase();
const origin = 'https://fresh.example.test', setupToken = 'fresh-runtime-setup-token-with-32-characters';
let runtime: Runtime | undefined, directory: string | undefined;
afterAll(async () => {
  await runtime?.stop();
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('serves first-boot setup on a fresh install with the runtime\'s own key, origin and environment', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'runtime-setup-'));
  // Nothing in the process environment: setup must use only what the runtime was given.
  runtime = await startRuntime({ DATABASE_URL: database.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32), TENANCY: 'single',
    AUTH_SECRET: 'fresh-runtime-secret-with-at-least-32-characters', PUBLIC_ORIGIN: origin, NODE_ENV: 'production',
    SETUP_TOKEN: setupToken, UPLOADS_DIR: join(directory, 'uploads') });
  const response = await runtime.app.request(origin + '/api/setup', {
    headers: { host: new URL(origin).host, 'x-setup-token': setupToken } });
  expect(response.status, await response.clone().text()).toBe(200);
  const { data } = setupContracts.status.response.parse(await response.json());
  expect(data).toMatchObject({ currentStep: 0, completed: false });
});
