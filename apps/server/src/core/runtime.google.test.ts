// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { clock } from './clock.js';
import { startRuntime, type Runtime } from './runtime.js';

// Composition test: the runtime builds the Google extension from the environment, reports it in the login methods,
// and registers the automatic updates tile.
const db = useTestDatabase(), factory = createFactories(db), gymId = uuidv7();
const origin = 'https://gym.example.test';
let runtime: Runtime | undefined, directory: string;
beforeAll(async () => { await factory('gyms', gymId); });
beforeEach(async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-google-runtime-'));
});
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const environment = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
  AUTH_SECRET: 'runtime-google-auth-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'auto', TENANCY: 'single',
  PUBLIC_ORIGIN: origin, NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads'), ...extra });
const request = (path: string, init: RequestInit & { cookie?: string } = {}) => runtime!.app.request(origin + path, { ...init,
  headers: { host: 'gym.example.test', origin, 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) } });

it('offers Google sign-in only when both credentials are configured', async () => {
  runtime = await startRuntime(environment({ GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'client-secret' }));
  const bootstrap = await request('/api/auth/bootstrap');
  expect((await bootstrap.json()).data.login.google).toBe(true);
  const start = await request('/api/auth/sign-in/social', { method: 'POST', body: JSON.stringify({ provider: 'google' }) });
  expect(start.status).toBe(200);
  const { url } = await start.json() as { url: string };
  expect(new URL(url).origin).toBe('https://accounts.google.com');
  expect(new URL(url).searchParams.get('redirect_uri')).toBe(origin + '/api/auth/callback/google');
  await runtime.stop();

  runtime = await startRuntime(environment());
  expect((await (await request('/api/auth/bootstrap')).json()).data.login).not.toHaveProperty('google');
  expect((await request('/api/auth/sign-in/social', { method: 'POST', body: JSON.stringify({ provider: 'google' }) })).status).toBe(404);
});

it('refuses to start with only half of the Google configuration', async () => {
  await expect(startRuntime(environment({ GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com' }))).rejects.toThrow();
});

it('registers the automatic updates tile, on by default and never run', async () => {
  const accounts = createAccountService(authConfig(environment()), () => db.system.db);
  const owner = await accounts.createPasswordUser(gymId, 'owner@example.test', 'Owner', 'original-owner-password', clock);
  await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
  runtime = await startRuntime(environment());
  const login = await request('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: 'owner@example.test', password: 'original-owner-password' }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const health = await request('/api/health', { cookie });
  expect(health.status).toBe(200);
  const tile = (await health.json()).data.tiles.find((candidate: { id: string }) => candidate.id === 'automatic_updates');
  expect(tile.details).toMatchObject({ enabled: true, result: 'never_run' });
});
