// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { paymentMethods, uuidv7 } from '@plaingym/db';
import { startRuntime } from '../../core/runtime.js';
import { clock } from '../../core/clock.js';
import { FakePayments, type Payments } from '../../infra/payments/index.js';
import type { StripePayments } from '../../infra/payments/stripe.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import type { JobHandler } from '../../infra/jobs/index.js';
import * as stripeStep from '../setup/stripe-step.js';
import { customerCardImportJob } from './customer-card-import.js';

const db = useTestDatabase(), factory = createFactories(db);
it('registers the card import job with the runtime, on the batch lane, and imports a household cards through it', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId, { billingEnabled: true });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
  const fake = new FakePayments(gymId, clock, 'synthetic-runtime-secret');
  fake.seedCustomer({ id: 'cus_fixture', email: 'payer@example.test' });
  fake.recordPaymentMethod({ id: 'pm_outside', customerId: 'cus_fixture', createdAt: clock.now(), brand: 'visa', last4: '4242',
    expiresMonth: 12, expiresYear: 2035 });
  const provider: Payments = fake;
  const handlers = new Map<string, { handler: JobHandler; options: unknown }>();
  vi.spyOn(stripeStep, 'createPaymentsResolver').mockReturnValue(async () => provider as StripePayments);
  const register = PostgresJobs.prototype.handle;
  vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler, options) {
    handlers.set(name, { handler, options }); register.call(this, name, handler, options);
  });
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const directory = await mkdtemp(join(tmpdir(), 'plaingym-card-import-runtime-'));
  try {
    await startRuntime({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
      AUTH_SECRET: 'runtime-secret-with-at-least-32-characters', TENANCY: 'single', PUBLIC_ORIGIN: 'https://gym.example.test',
      NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on', UPLOADS_DIR: directory });
    const registered = handlers.get(customerCardImportJob);
    expect(registered).toBeDefined();
    expect(registered!.options).toMatchObject({ lane: 'batch' });
    await registered!.handler({ householdId: household.id, customerId: 'cus_fixture', requestId: uuidv7(), switched: null },
      { gymId, timezone: 'UTC', jobId: uuidv7(), attempt: 1, clock });
    const cards = await db.forGym(gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.householdId, household.id)));
    expect(cards.map(card => [card.processorId, card.isDefault])).toEqual([['pm_outside', true]]);
  } finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); }
});
