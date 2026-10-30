// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import type { JobHandler } from '../infra/jobs/index.js';
import { ERASED_CUSTOMER_NAME, FakePayments } from '../infra/payments/index.js';
import type { StripePayments } from '../infra/payments/stripe.js';
import * as stripeStep from '../areas/setup/stripe-step.js';
import { redactCustomerJob } from '../areas/members/members.routes.js';
import { clock } from './clock.js';
import { setLogSink } from './log.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
let runtime: Runtime | undefined, directory: string | undefined;
const env = (uploads: string) => ({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ef'.repeat(32),
  AUTH_SECRET: 'hardening-runtime-secret-at-least-32-characters', TENANCY: 'single', PUBLIC_ORIGIN: origin, NODE_ENV: 'production',
  UPLOADS_DIR: join(uploads, 'uploads') });
afterEach(async () => { await runtime?.stop(); runtime = undefined; });
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('redacts an erased household\'s Stripe customer through the runtime\'s payments wiring', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const handlers = new Map<string, JobHandler>(), register = PostgresJobs.prototype.handle;
  vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler) {
    handlers.set(name, handler); register.call(this, name, handler);
  });
  directory ??= await mkdtemp(join(tmpdir(), 'plaingym-hardening-runtime-'));
  const gymId = uuidv7(); await factory('gyms', gymId);
  const fake = new FakePayments(gymId, clock, 'synthetic-runtime-secret');
  fake.seedCustomer({ id: 'cus_erased', email: 'payer@example.invalid' });
  vi.spyOn(stripeStep, 'createPaymentsResolver').mockReturnValue(async () => fake as unknown as StripePayments);
  runtime = await startRuntime(env(directory));
  // The retry job the erasure route queues after commit reaches the gym's own provider.
  await handlers.get(redactCustomerJob)!({ customerId: 'cus_erased' }, { gymId, clock, timezone: 'UTC', jobId: uuidv7(), attempt: 1 });
  expect(fake.customer('cus_erased')).toEqual({ name: ERASED_CUSTOMER_NAME, email: null });
});

it('reports images from the uploads bucket\'s origin under the report-only policy', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory ??= await mkdtemp(join(tmpdir(), 'plaingym-hardening-runtime-'));
  const gymId = uuidv7(); await factory('gyms', gymId);
  runtime = await startRuntime({ ...env(directory), UPLOADS_S3_BUCKET: 'gym-uploads', UPLOADS_S3_REGION: 'auto',
    UPLOADS_S3_ENDPOINT: 'https://account.storage.example.test/ignored-path' });
  const response = await runtime.app.request(origin + '/healthz', { headers: { host: 'gym.example.test' } });
  expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  expect(response.headers.get('content-security-policy-report-only')).toContain("img-src 'self' data: https://account.storage.example.test;");
});

it('starts with a bucket host the policy cannot name, leaving it out of the report-only policy', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory ??= await mkdtemp(join(tmpdir(), 'plaingym-hardening-runtime-'));
  const gymId = uuidv7(); await factory('gyms', gymId);
  const logs: string[] = [], previous = setLogSink(line => logs.push(line));
  try {
    runtime = await startRuntime({ ...env(directory), UPLOADS_S3_BUCKET: 'gym-uploads', UPLOADS_S3_REGION: 'auto',
      UPLOADS_S3_ENDPOINT: 'http://plaingym_minio:9000' });
  } finally { setLogSink(previous); }
  const response = await runtime.app.request(origin + '/healthz', { headers: { host: 'gym.example.test' } });
  expect(response.headers.get('content-security-policy-report-only')).toContain("img-src 'self' data:;");
  expect(logs.map(line => JSON.parse(line).event)).toContain('runtime.csp.image_origin_skipped');
});
