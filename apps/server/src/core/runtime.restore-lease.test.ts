// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import type { JobHandler } from '../infra/jobs/index.js';
import { createRestoreCheckLease } from '../areas/health/restore.billing-lease.js';
import { clock } from './clock.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), ambient = useTestDatabase(), factory = createFactories(db);
let runtime: Runtime | undefined, directory: string | undefined;
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

it('uses the runtime database for both the queued restore check and the go-live rerun lease', async () => {
  vi.stubEnv('DATABASE_URL', ambient.appUrl);
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  let restoreHandler: JobHandler | undefined;
  const handle = PostgresJobs.prototype.handle;
  vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler, options) {
    if (name === 'billing.runner.restore') { expect(restoreHandler).toBeUndefined(); restoreHandler = handler; }
    handle.call(this, name, handler, options);
  });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-restore-lease-runtime-'));
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'cd'.repeat(32),
    AUTH_SECRET: 'runtime-restore-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'auto', TENANCY: 'single',
    PUBLIC_ORIGIN: 'https://gym.example.test', NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') };
  const gymId = uuidv7();
  await factory('gyms', gymId, { billingEnabled: false });
  const owner = await createAccountService(authConfig(env), () => db.system.db)
    .createPasswordUser(gymId, 'owner@example.test', 'Owner', 'original-owner-password', clock);
  await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
  const snapshotAt = '2026-10-20T12:00:00.000Z';
  const restore = await db.forGym(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'restore.completed',
    targetType: 'gym', targetId: gymId, occurredAt: clock.now() }));
  await db.forGym(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.runner.restore_requested',
    targetType: 'restore', targetId: restore.id, after: { snapshotAt }, occurredAt: clock.now() }));
  runtime = await startRuntime(env);
  const request = (path: string, method = 'GET', body?: unknown, cookie = '') => runtime!.app.request(env.PUBLIC_ORIGIN + path, {
    method, headers: { host: 'gym.example.test', origin: env.PUBLIC_ORIGIN, cookie,
      ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const login = await request('/api/auth/sign-in/email', 'POST', { email: 'owner@example.test', password: 'original-owner-password' });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const checklist = async () => {
    const response = await request('/api/settings/go-live', 'GET', undefined, cookie);
    expect(response.status).toBe(200);
    return (await response.json() as { data: { revision: number; restoreReconciliation: { checkedAt: string | null } } }).data;
  };
  const rerun = async () => request('/api/settings/go-live/reconciliation', 'POST', {
    revision: (await checklist()).revision, restoreId: restore.id }, cookie);
  const checked = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.runner.restore_checked')));
  const runJob = () => restoreHandler!({ snapshotAt, restoreId: restore.id }, { jobId: uuidv7(), gymId, timezone: 'UTC', clock, attempt: 1 });
  expect(restoreHandler).toBeDefined();
  await createRestoreCheckLease(() => db.appUrl)(gymId, async () => {
    await runJob();
    expect(await checked()).toHaveLength(0);
    const busy = await rerun();
    expect(busy.status, await busy.clone().text()).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { details: { restoreId: ['check_running'] } } });
  });
  // A lock in process.env's different database must not block either runtime consumer.
  await createRestoreCheckLease(() => ambient.appUrl)(gymId, async () => {
    await runJob();
    expect(await checked()).toHaveLength(1);
    const result = await rerun();
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await checked()).toHaveLength(2);
  });
  expect((await checklist()).restoreReconciliation.checkedAt).toEqual(expect.any(String));
});
