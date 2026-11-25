// SPDX-License-Identifier: AGPL-3.0-only
import { jsonInit, requestWithLength } from '../../../test/request.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { auditEvents, paymentMethods, uuidv7 } from '@plaingym/db';
import { importJobSchema, importPreviewStateSchema, importUploadSchema } from '@plaingym/shared/contracts';
import { startRuntime, type Runtime } from '../../core/runtime.js';
import { clock, TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { FakePayments, type Payments } from '../../infra/payments/index.js';
import type { StripePayments } from '../../infra/payments/stripe.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { FakeJobs, type JobHandler } from '../../infra/jobs/index.js';
import { IMPORT_JOB } from '../imports/pipeline.js';
import * as stripeStep from '../setup/stripe-step.js';
import { createCustomerCardImportJobs, customerCardImportJob } from './customer-card-import.js';

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

it('ignores unknown keys on a stored card import payload and counts filled card details across pages', async () => {
  const gymId = uuidv7(), testClock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
  const provider = new FakePayments(gymId, testClock), jobs = new FakeJobs(testClock);
  createServerRegistry({ jobs: createCustomerCardImportJobs({ scope: db.forGym, clock: testClock, jobs, paymentsFor: async () => provider }) })
    .registerJobs(jobs, new Set());
  const finishedAudits = (householdId: string, requestId: string) => db.forGym(gymId, async tx => (await tx.select().from(auditEvents)
    .where(and(eq(auditEvents.action, 'billing.card.import_finished'), eq(auditEvents.targetId, householdId))))
    .filter(row => (row.after as { requestId?: string }).requestId === requestId));

  // Extra keys added by a newer release are stripped so a queued job still finishes after a rollback.
  const rollbackHome = await factory('households', gymId, { stripeCustomerId: 'cus_rollback' });
  provider.seedCustomer({ id: 'cus_rollback', email: 'rollback@example.invalid' });
  provider.recordPaymentMethod({ id: 'pm_rollback', customerId: 'cus_rollback', brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2035 });
  const rollbackRequest = uuidv7();
  await jobs.enqueue(customerCardImportJob, { householdId: rollbackHome.id, customerId: 'cus_rollback', requestId: rollbackRequest,
    switched: null, futureField: 1 }, { gymId, timezone: 'UTC' });
  await jobs.runNext();
  const [rollbackAudit] = await finishedAudits(rollbackHome.id, rollbackRequest);
  expect(rollbackAudit?.after).toMatchObject({ requestId: rollbackRequest, outcome: 'finished' });
  expect(rollbackAudit?.after).not.toHaveProperty('filledCards');

  // A household whose only card was saved by ID alone gets filledCards: 1 (and importedCards: 0 when bank counts are present).
  const cardOnlyHome = await factory('households', gymId, { stripeCustomerId: 'cus_card_only' });
  provider.seedCustomer({ id: 'cus_card_only', email: 'cardonly@example.invalid' });
  await factory('paymentMethods', gymId, { householdId: cardOnlyHome.id, processorId: 'pm_card_only_id', type: 'card',
    brand: null, last4: null, expiryMonth: null, expiryYear: null, isDefault: true });
  provider.recordPaymentMethod({ id: 'pm_card_only_id', customerId: 'cus_card_only', brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2035 });
  const cardOnlyRequest = uuidv7();
  await jobs.enqueue(customerCardImportJob, { householdId: cardOnlyHome.id, customerId: 'cus_card_only', requestId: cardOnlyRequest,
    switched: null }, { gymId, timezone: 'UTC' });
  await jobs.runNext();
  const [cardOnlyAudit] = await finishedAudits(cardOnlyHome.id, cardOnlyRequest);
  expect(cardOnlyAudit?.after).toMatchObject({ requestId: cardOnlyRequest, outcome: 'finished', filledCards: 1 });
  expect(await db.forGym(gymId, tx => tx.select().from(auditEvents).where(and(
    eq(auditEvents.action, 'billing.card.imported'), eq(auditEvents.targetId, cardOnlyHome.id))))).toHaveLength(0);

  const singleHome = await factory('households', gymId, { stripeCustomerId: 'cus_single' });
  provider.seedCustomer({ id: 'cus_single', email: 'single@example.invalid' });
  await factory('paymentMethods', gymId, { householdId: singleHome.id, processorId: 'pm_saved_id_only', type: 'card',
    brand: null, last4: null, expiryMonth: null, expiryYear: null, isDefault: true });
  provider.recordPaymentMethod({ id: 'pm_saved_id_only', customerId: 'cus_single', brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2035 });
  provider.recordPaymentMethod({ id: 'pm_single_bank', customerId: 'cus_single', type: 'us_bank_account', bankName: 'Test bank', last4: '6789' });
  const singleRequest = uuidv7();
  await jobs.enqueue(customerCardImportJob, { householdId: singleHome.id, customerId: 'cus_single', requestId: singleRequest,
    switched: null }, { gymId, timezone: 'UTC' });
  await jobs.runNext();
  const [singleAudit] = await finishedAudits(singleHome.id, singleRequest);
  expect(singleAudit?.after).toMatchObject({ requestId: singleRequest, outcome: 'finished', filledCards: 1, importedCards: 0, importedBankAccounts: 1 });

  // Running again with nothing left to fill omits filledCards.
  const repeatRequest = uuidv7();
  await jobs.enqueue(customerCardImportJob, { householdId: singleHome.id, customerId: 'cus_single', requestId: repeatRequest,
    switched: null }, { gymId, timezone: 'UTC' });
  await jobs.runNext();
  const [repeatAudit] = await finishedAudits(singleHome.id, repeatRequest);
  expect(repeatAudit?.after).toMatchObject({ requestId: repeatRequest, outcome: 'finished' });
  expect(repeatAudit?.after).not.toHaveProperty('filledCards');

  // Card-only household with two pages (101 methods) and one fill on each page carries filledCards across pages to 2.
  const pagedHome = await factory('households', gymId, { stripeCustomerId: 'cus_paged' });
  provider.seedCustomer({ id: 'cus_paged', email: 'paged@example.invalid' });
  await factory('paymentMethods', gymId, { householdId: pagedHome.id, processorId: 'pm_fill_page_1', type: 'card',
    brand: null, last4: null, expiryMonth: null, expiryYear: null, isDefault: false });
  await factory('paymentMethods', gymId, { householdId: pagedHome.id, processorId: 'pm_fill_page_2', type: 'card',
    brand: null, last4: null, expiryMonth: null, expiryYear: null, isDefault: false });
  provider.recordPaymentMethod({ id: 'pm_fill_page_1', customerId: 'cus_paged', createdAt: new Date('2026-10-20T00:00:00Z'),
    brand: 'visa', last4: '1111', expiresMonth: 12, expiresYear: 2035 });
  for (let i = 0; i < 99; i++) provider.recordPaymentMethod({ id: 'pm_mid_' + String(i).padStart(3, '0'), customerId: 'cus_paged',
    createdAt: new Date('2026-10-10T00:00:00Z'), brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2035 });
  provider.recordPaymentMethod({ id: 'pm_fill_page_2', customerId: 'cus_paged', createdAt: new Date('2026-10-01T00:00:00Z'),
    brand: 'mastercard', last4: '2222', expiresMonth: 6, expiresYear: 2034 });
  const pagedRequest = uuidv7();
  await jobs.enqueue(customerCardImportJob, { householdId: pagedHome.id, customerId: 'cus_paged', requestId: pagedRequest,
    switched: null }, { gymId, timezone: 'UTC' });
  await jobs.runNext();
  expect(jobs.jobs.at(-1)?.payload).toMatchObject({ requestId: pagedRequest, filledCards: 1 });
  await jobs.runNext();
  const [pagedAudit] = await finishedAudits(pagedHome.id, pagedRequest);
  expect(pagedAudit?.after).toMatchObject({ requestId: pagedRequest, outcome: 'finished', filledCards: 2 });

  // A two-page run with no fills omits filledCards from the continuation payload and the finished audit.
  const cleanRequest = uuidv7();
  await jobs.enqueue(customerCardImportJob, { householdId: pagedHome.id, customerId: 'cus_paged', requestId: cleanRequest,
    switched: null }, { gymId, timezone: 'UTC' });
  await jobs.runNext();
  expect(jobs.jobs.at(-1)?.payload).not.toHaveProperty('filledCards');
  await jobs.runNext();
  const [cleanAudit] = await finishedAudits(pagedHome.id, cleanRequest);
  expect(cleanAudit?.after).toMatchObject({ requestId: cleanRequest, outcome: 'finished' });
  expect(cleanAudit?.after).not.toHaveProperty('filledCards');

  // A cursor restart preserves filledCards committed on an earlier page.
  const restartHome = await factory('households', gymId, { stripeCustomerId: 'cus_restart' });
  provider.seedCustomer({ id: 'cus_restart', email: 'restart@example.invalid' });
  await factory('paymentMethods', gymId, { householdId: restartHome.id, processorId: 'pm_restart_fill', type: 'card',
    brand: null, last4: null, expiryMonth: null, expiryYear: null, isDefault: false });
  provider.recordPaymentMethod({ id: 'pm_restart_fill', customerId: 'cus_restart', createdAt: new Date('2026-10-20T00:00:00Z'),
    brand: 'visa', last4: '3333', expiresMonth: 12, expiresYear: 2035 });
  for (let i = 0; i < 100; i++) provider.recordPaymentMethod({ id: 'pm_rst_' + String(i).padStart(3, '0'), customerId: 'cus_restart',
    createdAt: new Date('2026-10-10T00:00:00Z'), brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2035 });
  const restartRequest = uuidv7();
  await jobs.enqueue(customerCardImportJob, { householdId: restartHome.id, customerId: 'cus_restart', requestId: restartRequest,
    switched: null }, { gymId, timezone: 'UTC' });
  await jobs.runNext();
  const nextCursor = (jobs.jobs.at(-1)?.payload as { cursor: string }).cursor;
  await provider.detachPaymentMethod(nextCursor);
  await jobs.runNext();
  expect(jobs.jobs.at(-1)?.payload).toMatchObject({ requestId: restartRequest, restarts: 1, filledCards: 1 });
  await jobs.runNext();
  const [restartAudit] = await finishedAudits(restartHome.id, restartRequest);
  expect(restartAudit?.after).toMatchObject({ requestId: restartRequest, outcome: 'finished', restarts: 1, filledCards: 1 });
});
