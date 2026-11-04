// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { clock } from '../../core/clock.js';
import { startRuntime, type Runtime } from '../../core/runtime.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { configureWebsite, websiteModule } from './index.js';

// Composition test: the entry point hands the runtime the website module and its configuration, as `index.ts` does.
const db = useTestDatabase(), factory = createFactories(db), gymId = uuidv7();
const origin = 'https://gym.example.test';
let runtime: Runtime | undefined, directory: string;
beforeAll(async () => { await factory('gyms', gymId); });
beforeEach(async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-website-runtime-'));
});
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const environment = (): NodeJS.ProcessEnv => ({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
  AUTH_SECRET: 'runtime-website-auth-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'auto', TENANCY: 'single',
  PUBLIC_ORIGIN: origin, NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') });
const request = (path: string, init: RequestInit & { cookie?: string } = {}) => runtime!.app.request(origin + path, { ...init,
  headers: { host: 'gym.example.test', origin, 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) } });

it('sends / to the portal while the website is off, and serves it and its settings once the owner turns it on', async () => {
  const accounts = createAccountService(authConfig(environment()), () => db.system.db);
  const owner = await accounts.createPasswordUser(gymId, 'owner@example.test', 'Owner', 'original-owner-password', clock);
  await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
  runtime = await startRuntime(environment(), { modules: [websiteModule], configureModules: configureWebsite });
  const off = await request('/');
  expect(off.status).toBe(302);
  expect(off.headers.get('location')).toBe('/portal');

  const login = await request('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: 'owner@example.test', password: 'original-owner-password' }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const { data: { revision } } = await (await request('/api/settings', { cookie })).json() as { data: { revision: number } };
  expect((await request('/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ websiteEnabled: true, revision }) })).status).toBe(200);

  const home = await request('/');
  expect(home.status).toBe(200);
  expect(home.headers.get('content-type')).toContain('text/html');
  // Configured by the runtime: without `configureWebsite` the module's settings routes answer 503.
  expect((await request('/api/website', { cookie })).status).toBe(200);
});
