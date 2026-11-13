// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { uuidv7 } from '@plaingym/db';
import { startRuntime } from '../../core/runtime.js';
import { clock } from '../../core/clock.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import type { JobHandler } from '../../infra/jobs/index.js';
import { priceNoticeJob } from './memberships.price-notice.js';

const db = useTestDatabase(), factory = createFactories(db);
it('configures the price notice in the runtime, so its job runs instead of failing as unconfigured', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId, {});
  const handlers = new Map<string, JobHandler>();
  const register = PostgresJobs.prototype.handle;
  const handle = vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler, options) {
    handlers.set(name, handler); register.call(this, name, handler, options);
  });
  const worker = vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const directory = await mkdtemp(join(tmpdir(), 'plaingym-price-notice-runtime-'));
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
      AUTH_SECRET: 'runtime-secret-with-at-least-32-characters', TENANCY: 'single', PUBLIC_ORIGIN: 'https://gym.example.test',
      NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on', UPLOADS_DIR: directory });
    const handler = handlers.get(priceNoticeJob);
    expect(handler).toBeDefined();
    // A household that doesn't exist has no payer: a configured notice ends without sending; an unconfigured one throws.
    await expect(handler!({ requestKey: uuidv7(), planId: uuidv7(), householdId: uuidv7(), membershipIds: [uuidv7()],
      amountCents: 12000, currency: 'USD', effectiveOn: '2027-01-01' },
    { gymId, clock, timezone: 'UTC', jobId: uuidv7(), attempt: 1 })).resolves.toBeUndefined();
  } finally {
    await runtime?.stop(); handle.mockRestore(); worker.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
