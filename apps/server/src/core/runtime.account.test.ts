// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { clock } from './clock.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db);
const origin = 'https://gym.example.test', gymId = uuidv7();
let runtime: Runtime | undefined, directory: string | undefined, accounts: ReturnType<typeof createAccountService>;
beforeAll(async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-account-runtime-'));
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ef'.repeat(32),
    AUTH_SECRET: 'runtime-account-secret-at-least-32-characters-long', AUTH_PASSWORD_LOGIN: 'on', TENANCY: 'single',
    PUBLIC_ORIGIN: origin, NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads'),
    SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'gym@example.test' };
  await factory('gyms', gymId, {});
  accounts = createAccountService(authConfig(env), () => db.system.db);
  runtime = await startRuntime(env);
});
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const headers = (cookie = '') => ({ host: 'gym.example.test', origin, 'content-type': 'application/json', cookie });

it('offers the sign-in email change once the runtime wires the account routes to the gym mail', async () => {
  await accounts.createPasswordUser(gymId, 'owner@example.test', 'Owner', 'account-owner-password', clock);
  const signedIn = await runtime!.app.request(origin + '/api/auth/sign-in/email', { method: 'POST', headers: headers(),
    body: JSON.stringify({ email: 'owner@example.test', password: 'account-owner-password' }) });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

  // Unwired, the page reports `no_email` and the request answers 503; wired, the gym's SMTP makes the change available.
  const account = await runtime!.app.request(origin + '/api/account', { headers: headers(cookie) });
  expect(account.status).toBe(200);
  expect((await account.json()).data).toMatchObject({ email: 'owner@example.test', emailChange: 'available' });
  expect((await runtime!.app.request(origin + '/api/account', { headers: headers() })).status).toBe(401);
});
