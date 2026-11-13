// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test stores the gym's encrypted SMTP settings in real PostgreSQL.
import { gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createBackupKeyResponseSchema, integrationsResponseSchema } from '@plaingym/shared/contracts';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { encryptSmtpConfig } from '../areas/settings/smtp.js';
import { parseEncryptionKey } from './secrets.js';
import { clock } from './clock.js';
import { startRuntime, type Runtime } from './runtime.js';
import { s3Server } from '../infra/storage/s3-server.test-helper.js';

const db = useTestDatabase(), factory = createFactories(db);
let runtime: Runtime | undefined, directory: string | undefined, storage: Awaited<ReturnType<typeof s3Server>> | undefined;
afterAll(async () => {
  await runtime?.stop();
  await storage?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('serves Settings → Email, Payments and Backups with the runtime’s key, auth rules and account lookup', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-integrations-runtime-'));
  // The new destination is listed with its credentials before a key is made for it.
  storage = await s3Server();
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
    AUTH_SECRET: 'runtime-integrations-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'auto', TENANCY: 'single',
    PUBLIC_ORIGIN: 'https://gym.example.test', NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') };
  const key = parseEncryptionKey(env.APP_ENCRYPTION_KEY), gymId = uuidv7();
  await factory('gyms', gymId);
  const owner = await createAccountService(authConfig(env), () => db.system.db)
    .createPasswordUser(gymId, 'owner@example.test', 'Owner', 'original-owner-password', clock);
  await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
  runtime = await startRuntime(env);
  const request = (path: string, method = 'GET', body?: unknown, cookie = '') => runtime!.app.request(env.PUBLIC_ORIGIN + path, { method,
    headers: { host: 'gym.example.test', origin: env.PUBLIC_ORIGIN, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const login = await request('/api/auth/sign-in/email', 'POST', { email: 'owner@example.test', password: 'original-owner-password' });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  // The gym's own SMTP turns password login off under `auto`, so it is saved after signing in.
  await db.forGym(gymId, (tx) => tx.update(gyms).set({ smtpConfig: encryptSmtpConfig(key, gymId, { host: 'smtp.gym.example.test', port: 587,
    security: 'starttls', from: 'desk@gym.example.test', username: 'gym', password: 'runtime-smtp-secret' }) }).where(eq(gyms.id, gymId)));

  const read = await request('/api/settings/integrations', 'GET', undefined, cookie);
  expect(read.status, await read.clone().text()).toBe(200);
  const status = integrationsResponseSchema.parse(await read.json()).data;
  // The runtime's key decrypts the stored settings; its auth rules and the owner's password decide removal.
  expect(status).toMatchObject({ sandbox: false, email: { source: 'gym', host: 'smtp.gym.example.test', signInAfterRemove: { password: true, magicLink: false },
    removeBlocked: false }, payments: { configured: false }, backups: { configured: false, pending: null } });
  const removed = await request('/api/settings/integrations/email', 'DELETE', { revision: status.revision }, cookie);
  expect(removed.status, await removed.clone().text()).toBe(200);
  expect(integrationsResponseSchema.parse(await removed.json()).data.email.source).toBe('none');
  const created = await request('/api/settings/integrations/backups', 'POST', { revision: status.revision + 1,
    destination: { endpoint: storage.endpoint, region: 'auto', bucket: 'backups', accessKeyId: 'id', secretAccessKey: 'secret' } }, cookie);
  expect(created.status, await created.clone().text()).toBe(200);
  // The answer holds the new private key, shown once; no cache may keep it.
  expect(created.headers.get('cache-control')).toBe('no-store');
  expect(createBackupKeyResponseSchema.parse(await created.json()).data.integrations.backups?.pending?.destination.bucket).toBe('backups');
});
