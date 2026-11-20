// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test stores the gym's encrypted SMS settings in real PostgreSQL.
import { gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { encryptSmsConfig } from '../areas/settings/sms.js';
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

it('turns member texts on only once the runtime finds the gym\'s saved provider', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-sms-go-live-runtime-'));
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'cd'.repeat(32),
    AUTH_SECRET: 'runtime-sms-go-live-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'auto', TENANCY: 'single',
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
  const checklist = async () => (await (await request('/api/settings/go-live', 'GET', undefined, cookie)).json() as { data: { revision: number;
    memberSmsEnabled: boolean; items: { id: string; status: string; message: string }[] } }).data;

  // Unused SMS is not applicable, and enabling still requires a saved provider.
  const before = await checklist();
  expect(before).toMatchObject({ memberSmsEnabled: false });
  expect(before.items.find((item) => item.id === 'sms_ready')?.status).toBe('not_applicable');
  const refused = await request('/api/settings/go-live', 'PATCH', { revision: before.revision, memberSmsEnabled: true }, cookie);
  expect(refused.status, await refused.clone().text()).toBe(409);

  await db.forGym(gymId, (tx) => tx.update(gyms).set({ smsConfig: 'unreadable' }).where(eq(gyms.id, gymId)));
  const unreadable = await checklist();
  expect(unreadable.memberSmsEnabled).toBe(false);
  expect(unreadable.items.find((item) => item.id === 'sms_ready')).toMatchObject({
    status: 'needs_attention', message: 'The saved SMS settings could not be read. Replace or remove them in Settings.',
  });

  // A saved, readable provider is found through the runtime's key.
  await db.forGym(gymId, (tx) => tx.update(gyms).set({ smsConfig: encryptSmsConfig(key, gymId, { accountSid: 'AC' + '1'.repeat(32),
    auth: { token: 'runtime-sms-token' }, sender: { from: '+15005550006' } }) }).where(eq(gyms.id, gymId)));
  const ready = await checklist();
  expect(ready.items.find((item) => item.id === 'sms_ready')?.status).toBe('ready');
  const enabled = await request('/api/settings/go-live', 'PATCH', { revision: ready.revision, memberSmsEnabled: true }, cookie);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  expect(await checklist()).toMatchObject({ memberSmsEnabled: true });
});
