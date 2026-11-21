// SPDX-License-Identifier: AGPL-3.0-only
import { jsonInit, requestWithLength } from '../../../test/request.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { paymentMethods, uuidv7 } from '@plaingym/db';
import { importJobSchema, importPreviewStateSchema, importUploadSchema } from '@plaingym/shared/contracts';
import { startRuntime, type Runtime } from '../../core/runtime.js';
import { clock } from '../../core/clock.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { FakePayments, type Payments } from '../../infra/payments/index.js';
import type { StripePayments } from '../../infra/payments/stripe.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import type { JobHandler } from '../../infra/jobs/index.js';
import { IMPORT_JOB } from '../imports/pipeline.js';
import * as stripeStep from '../setup/stripe-step.js';
import { customerCardImportJob } from './customer-card-import.js';

const db = useTestDatabase(), factory = createFactories(db);
it('imports household cards and bank accounts on the batch lane and checks CSV bank accounts in the dry run', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
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
  let runtime: Runtime | undefined;
  try {
    const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
      AUTH_SECRET: 'runtime-secret-with-at-least-32-characters', TENANCY: 'single', PUBLIC_ORIGIN: 'https://gym.example.test',
      NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on', UPLOADS_DIR: directory };
    const password = 'original-owner-password';
    const owner = await createAccountService(authConfig(env), () => db.system.db)
      .createPasswordUser(gymId, 'owner@example.test', 'Owner', password, clock);
    await factory('staffRoles', gymId, { userId: owner.userId, role: 'owner' });
    runtime = await startRuntime(env);
    const registered = handlers.get(customerCardImportJob);
    expect(registered).toBeDefined();
    expect(registered!.options).toMatchObject({ lane: 'batch' });
    const importOnce = () => registered!.handler({ householdId: household.id, customerId: 'cus_fixture', requestId: uuidv7(), switched: null },
      { gymId, timezone: 'UTC', jobId: uuidv7(), attempt: 1, clock });
    const methods = () => db.forGym(gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.householdId, household.id)));
    const card = expect.objectContaining({ processorId: 'pm_outside', type: 'card', isDefault: true });
    await importOnce();
    expect(await methods()).toEqual([card]);
    fake.recordPaymentMethod({ id: 'pm_bank', customerId: 'cus_fixture', type: 'us_bank_account', bankName: 'Test bank', last4: '1234' });
    await importOnce();
    const imported = await methods();
    expect(imported).toHaveLength(2);
    expect(imported).toEqual(expect.arrayContaining([
      card, expect.objectContaining({ processorId: 'pm_bank', type: 'us_bank_account', bankName: 'Test bank', last4: '1234', isDefault: false }),
    ]));

    fake.seedCustomer({ id: 'cus_csv', email: 'csv@example.test', gymId: null });
    fake.recordPaymentMethod({ id: 'pm_canadian', customerId: 'cus_csv', type: 'acss_debit', last4: '4321' });
    const { app } = runtime;
    const origin = env.PUBLIC_ORIGIN;
    const headers = { host: 'gym.example.test', origin };
    const login = jsonInit({ email: 'owner@example.test', password });
    const session = await app.request(origin + '/api/auth/sign-in/email', {
      ...login, method: 'POST', headers: { ...headers, ...login.headers },
    });
    expect(session.status, await session.clone().text()).toBe(200);
    const cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const form = new FormData();
    form.set('file', new File([
      'First Name,Last Name,Stripe Customer ID,Stripe Payment Method ID\nTest,Imported,cus_csv,pm_canadian\n',
    ], 'people.csv'));
    const uploaded = await app.request(await requestWithLength(origin + '/api/imports/uploads', {
      method: 'POST', headers: { ...headers, cookie }, body: form,
    }));
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const upload = importUploadSchema.parse((await uploaded.json()).data);
    const input = { uploadId: upload.id, mapper: 'people', duplicatePolicy: 'error', mapping: [
      { sourceColumn: 'First Name', targetField: 'firstName' },
      { sourceColumn: 'Last Name', targetField: 'lastName' },
      { sourceColumn: 'Stripe Customer ID', targetField: 'stripeCustomerId' },
      { sourceColumn: 'Stripe Payment Method ID', targetField: 'stripePaymentMethodId' },
    ] };
    const plan = jsonInit(input), lookup = vi.spyOn(fake, 'readBankAccountForImport');
    const requested = await app.request(origin + '/api/imports/preview', {
      ...plan, method: 'POST', headers: { ...headers, cookie, ...plan.headers },
    });
    expect(requested.status, await requested.clone().text()).toBe(200);
    const preview = importPreviewStateSchema.parse(await requested.json());
    if (!('id' in preview)) throw new Error('A new upload should start a new preview');
    const path = '/api/imports/uploads/' + upload.id + '/previews/' + preview.id;
    await expect.poll(async () => (await (await app.request(origin + path, { headers: { ...headers, cookie } })).json()))
      .toMatchObject({ status: 'ready', preview: { summary: { errors: 0 }, data: [{ rowNumber: 2, action: 'create' }] } });
    expect(lookup).not.toHaveBeenCalled();

    const dryRun = jsonInit({ ...input, dryRun: true });
    const started = await app.request(origin + '/api/imports', {
      ...dryRun, method: 'POST', headers: { ...headers, cookie, ...dryRun.headers },
    });
    expect(started.status, await started.clone().text()).toBe(200);
    const job = importJobSchema.parse((await started.json()).data);
    const handler = handlers.get(IMPORT_JOB);
    expect(handler).toBeDefined();
    await handler!.handler({ id: job.id }, { gymId, timezone: 'UTC', jobId: uuidv7(), attempt: 1, clock });
    const errors = await app.request(origin + '/api/imports/' + job.id + '/errors', { headers: { ...headers, cookie } });
    expect(errors.status, await errors.clone().text()).toBe(200);
    expect(await errors.json()).toMatchObject({ data: [{ rowNumber: 2, column: 'Stripe Payment Method ID',
      code: 'invalid_value', message: "This bank account can't be charged in USD." }] });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('pm_canadian', false);
  } finally {
    await runtime?.stop();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});
