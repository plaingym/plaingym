// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { betterAuth } from 'better-auth';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAuthService } from './service.js';
import { authConfig } from './config.js';
import { passwordAdapter } from './password.js';

vi.mock('better-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth')>();
  return { ...actual, betterAuth: vi.fn(actual.betterAuth) };
});

const database = useTestDatabase();
const factory = createFactories(database);
const secret = 'auth-instances-test-secret-at-least-32-characters';
const config = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on' }, false);
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  vi.stubEnv('AUTH_SECRET', secret); vi.stubEnv('AUTH_PASSWORD_LOGIN', 'on'); vi.stubEnv('TENANCY', 'single');
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

it('serves password and login-link requests through the one Better Auth instance a binding builds', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const user = await factory('authUser', gymId, { emailVerified: true });
  await factory('authAccount', gymId, { userId: user.id, accountId: user.id, password: await passwordAdapter.hash('instance-password-123') });
  const origin = `https://${gymId}.example.test`, delivered: string[] = [];
  const service = createAuthService({ config, database: () => database.system.db, sendMagicLink: async ({ email }) => { delivered.push(email); } });
  const request = (path: string, body: unknown) => new Request(new URL('/api/auth' + path, origin), {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  vi.mocked(betterAuth).mockClear();
  const bound = service.bind({ gymId, origin, clientIp: '198.51.100.7' });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await bound.handler(request('/sign-in/email', { email: user.email, password: 'wrong-password-123' }))).status);
  statuses.push((await bound.handler(request('/sign-in/magic-link', { email: user.email }))).status);
  expect(statuses).toEqual([401, 401, 401, 200]);
  expect(delivered).toEqual([user.email.toLowerCase()]);
  expect(betterAuth).toHaveBeenCalledTimes(1);
});
