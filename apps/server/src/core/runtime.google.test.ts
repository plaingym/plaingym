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
import { googleTokenEndpoint } from '../infra/auth/google.js';
import { setLogSink } from './log.js';
import { clock } from './clock.js';
import { startRuntime, type Runtime } from './runtime.js';

// Composition test: the runtime builds the Google extension from the environment, reports it in the login methods,
// registers the automatic updates tile, and starts without the install's Google client when its variables are malformed.
const db = useTestDatabase(), factory = createFactories(db), gymId = uuidv7();
const origin = 'https://gym.example.test';
let runtime: Runtime | undefined, directory: string, ownerCreated = false;
beforeAll(async () => { await factory('gyms', gymId); });
beforeEach(async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  // Google's token endpoint, faked: a save asks it about the client (and it knows every client here); nothing else is faked.
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input instanceof Request ? input.url : input) === googleTokenEndpoint
    ? Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 })) : original(input, init));
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


/** Starts the runtime and signs in the gym's owner (created once, with a password), returning the session cookie. */
async function startAsOwner(extra: NodeJS.ProcessEnv = {}): Promise<string> {
  const accounts = createAccountService(authConfig(environment()), () => db.system.db);
  if (!ownerCreated) {
    const owner = await accounts.createPasswordUser(gymId, 'owner@example.test', 'Owner', 'original-owner-password', clock);
    await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
    ownerCreated = true;
  }
  runtime = await startRuntime(environment(extra));
  const login = await request('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: 'owner@example.test', password: 'original-owner-password' }) });
  expect(login.status).toBe(200);
  return login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

it('uses a client the owner stored in Settings, without a restart, until it is removed', async () => {
  const cookie = await startAsOwner();
  const bootstrap = async () => (await (await request('/api/auth/bootstrap')).json()).data.login;
  const startGoogle = () => request('/api/auth/sign-in/social', { method: 'POST', body: JSON.stringify({ provider: 'google' }) });
  expect(await bootstrap()).not.toHaveProperty('google');
  expect((await startGoogle()).status).toBe(404);

  const current = (await (await request('/api/settings/integrations/google', { cookie })).json()).data as { revision: number };
  const saved = await request('/api/settings/integrations/google', { method: 'PUT', cookie,
    body: JSON.stringify({ revision: current.revision, clientId: 'stored-client.apps.googleusercontent.com', clientSecret: 'stored-client-secret' }) });
  expect(saved.status).toBe(200);
  expect(await bootstrap()).toMatchObject({ google: true });
  const start = await startGoogle();
  expect(start.status).toBe(200);
  const { url } = await start.json() as { url: string };
  expect(new URL(url).origin).toBe('https://accounts.google.com');
  expect(new URL(url).searchParams.get('client_id')).toBe('stored-client.apps.googleusercontent.com');

  const removed = await request('/api/settings/integrations/google', { method: 'DELETE', cookie,
    body: JSON.stringify({ revision: (await saved.json()).data.revision }) });
  expect(removed.status).toBe(200);
  expect(await bootstrap()).not.toHaveProperty('google');
  expect((await startGoogle()).status).toBe(404);
});

it('lets the install\'s variables win over a stored client', async () => {
  const cookie = await startAsOwner();
  const current = (await (await request('/api/settings/integrations/google', { cookie })).json()).data as { revision: number };
  expect((await request('/api/settings/integrations/google', { method: 'PUT', cookie,
    body: JSON.stringify({ revision: current.revision, clientId: 'stored-client', clientSecret: 'stored-client-secret' }) })).status).toBe(200);
  await runtime!.stop();
  runtime = await startRuntime(environment({ GOOGLE_CLIENT_ID: 'install-client', GOOGLE_CLIENT_SECRET: 'install-client-secret' }));
  const start = await request('/api/auth/sign-in/social', { method: 'POST', body: JSON.stringify({ provider: 'google' }) });
  expect(new URL((await start.json() as { url: string }).url).searchParams.get('client_id')).toBe('install-client');
});

it.each([
  ['only one of the two set', { GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com' }, { variable: 'GOOGLE_CLIENT_SECRET', reason: 'missing' }, 'GOOGLE_CLIENT_SECRET is not set'],
  ['whitespace', { GOOGLE_CLIENT_ID: 'client id', GOOGLE_CLIENT_SECRET: 'client-secret' }, { variable: 'GOOGLE_CLIENT_ID', reason: 'whitespace' }, 'GOOGLE_CLIENT_ID contains a space'],
  ['too long', { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 's'.repeat(513) }, { variable: 'GOOGLE_CLIENT_SECRET', reason: 'too_long' }, 'GOOGLE_CLIENT_SECRET is longer than 512 characters'],
] as const)('starts without Google when the configuration has %s, and says why on Health and in Settings', async (_name, extra, problem, text) => {
  const lines: string[] = [], previous = setLogSink((line) => lines.push(line));
  let cookie: string;
  try { cookie = await startAsOwner(extra); } finally { setLogSink(previous); }
  expect(lines.filter((line) => line.includes('auth.google_environment_invalid')).map((line) => JSON.parse(line) as Record<string, string>))
    .toEqual([expect.objectContaining({ ...problem, message: expect.stringContaining(text) })]);
  // The malformed install client is ignored, so the client the owner stored earlier in this file signs in.
  const start = await request('/api/auth/sign-in/social', { method: 'POST', body: JSON.stringify({ provider: 'google' }) });
  expect(new URL((await start.json() as { url: string }).url).searchParams.get('client_id')).toBe('stored-client');
  const tile = (await (await request('/api/health', { cookie })).json()).data.tiles.find((candidate: { id: string }) => candidate.id === 'google_login');
  expect(tile).toMatchObject({ status: 'warning', details: { configured: true }, message: expect.stringContaining(problem.variable) });
  expect(tile.message).toContain("this gym's own client");
  const settings = (await (await request('/api/settings/integrations/google', { cookie })).json()).data;
  expect(settings).toMatchObject({ source: 'gym', editable: true, installProblem: problem });
  expect(JSON.stringify([lines, tile, settings])).not.toMatch(/client id|client-secret|ssss/);
});

it('reads the update banner route from the environment the runtime runs with', async () => {
  const cookie = await startAsOwner({ UPDATE_CHECK: 'off' });
  const update = await request('/api/health/update', { cookie });
  expect(update.status).toBe(200);
  expect((await update.json()).data).toMatchObject({ id: 'update_available', status: 'not_configured', message: 'Update checks are turned off.' });
});

it('registers the automatic updates tile, on by default and never run', async () => {
  const cookie = await startAsOwner();
  const health = await request('/api/health', { cookie });
  expect(health.status).toBe(200);
  const tile = (await health.json()).data.tiles.find((candidate: { id: string }) => candidate.id === 'automatic_updates');
  expect(tile.details).toMatchObject({ enabled: true, result: 'never_run' });
});
