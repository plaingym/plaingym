// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { intakeRateLimits, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { intakeRateLimitSweepJob } from './rate-limit-store.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
let runtime: Runtime | undefined, directory: string | undefined;
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('counts the public forms\' budgets in the database and schedules the daily counter sweep', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const enqueued = vi.spyOn(PostgresJobs.prototype, 'enqueueSystem');
  directory = await mkdtemp(join(tmpdir(), 'plaingym-intake-runtime-'));
  const gymId = uuidv7(); await factory('gyms', gymId);
  runtime = await startRuntime({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ef'.repeat(32),
    AUTH_SECRET: 'intake-runtime-secret-at-least-32-characters', TENANCY: 'single', PUBLIC_ORIGIN: origin, NODE_ENV: 'production',
    UPLOADS_DIR: join(directory, 'uploads') });
  // The refused body still spends the budget: the limit runs before validation.
  const response = await runtime.app.request(origin + '/api/public/trial', { method: 'POST', body: '{}',
    headers: { host: 'gym.example.test', 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.7' } });
  expect(response.status).toBeLessThan(500);
  const counters = await db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.gymId, gymId)));
  expect(counters).toMatchObject([{ routeKey: 'public.submissions', count: 1 }]);
  // The runtime's own sweep queues the daily job.
  expect(enqueued).toHaveBeenCalledWith(intakeRateLimitSweepJob, {}, expect.objectContaining({ timezone: 'UTC' }));
});
