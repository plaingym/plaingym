// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test changes the gym's encrypted SMTP and inspects reset side effects in real PostgreSQL.
import { authAccount, authSession, auditEvents, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { encryptSmtpConfig } from '../areas/settings/smtp.js';
import { parseEncryptionKey } from './secrets.js';
import { clock } from './clock.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db);
let runtime: Runtime | undefined, directory: string | undefined;
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('uses the runtime account service and refuses staff resets after the gym configures its own SMTP under auto', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-auth-runtime-'));
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
    AUTH_SECRET: 'runtime-staff-auth-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'auto', TENANCY: 'single',
    PUBLIC_ORIGIN: 'https://gym.example.test', NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') };
  const gymId = uuidv7(); await factory('gyms', gymId);
  const accounts = createAccountService(authConfig(env), () => db.system.db);
  const admin = await accounts.createPasswordUser(gymId, 'admin@example.test', 'Admin', 'original-admin-password', clock);
  await factory('staffRoles', gymId, { userId: admin.userId, role: 'admin' });
  const target = await accounts.createPasswordUser(gymId, 'member@example.test', 'Member', 'original-member-password', clock);
  await factory('householdUsers', gymId, { userId: target.userId });
  runtime = await startRuntime(env);
  const post = (path: string, body: unknown, cookie = '') => runtime!.app.request(env.PUBLIC_ORIGIN + path, {
    method: 'POST', headers: { host: 'gym.example.test', origin: env.PUBLIC_ORIGIN, 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  const login = await post('/api/auth/sign-in/email', { email: 'admin@example.test', password: 'original-admin-password' });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const path = '/api/staff/users/' + target.userId + '/reset-password';
  expect((await post(path, { newPassword: 'first-replacement-password' }, cookie)).status).toBe(200);
  await factory('authSession', gymId, { userId: target.userId });
  const snapshot = async () => ({
    accounts: await db.system.db.select().from(authAccount).where(eq(authAccount.userId, target.userId)),
    sessions: await db.system.db.select().from(authSession).where(eq(authSession.userId, target.userId)),
    audits: await db.forGym(gymId, tx => tx.select().from(auditEvents)),
  });
  await db.forGym(gymId, tx => tx.update(gyms).set({ smtpConfig: encryptSmtpConfig(parseEncryptionKey(env.APP_ENCRYPTION_KEY), {
    host: 'smtp.gym.example.test', port: 587, security: 'starttls', from: 'desk@gym.example.test', username: 'gym', password: 'smtp-test-secret',
  }) }).where(eq(gyms.id, gymId)));
  const bootstrap = await runtime.app.request(env.PUBLIC_ORIGIN + '/api/auth/bootstrap', { headers: { host: 'gym.example.test', cookie } });
  expect((await bootstrap.json()).data.login).toEqual({ password: false, magicLink: true });
  const before = await snapshot();
  expect((await post(path, { newPassword: 'refused-replacement-password' }, cookie)).status).toBe(403);
  expect(await snapshot()).toEqual(before);
});
