// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createAccountService } from '../infra/auth/accounts.js';
import { authConfig } from '../infra/auth/config.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { FakePayments } from '../infra/payments/index.js';
import type { StripePayments } from '../infra/payments/stripe.js';
import * as stripeStep from '../areas/setup/stripe-step.js';
import { clock } from './clock.js';
import { encryptSecret, parseEncryptionKey } from './secrets.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db);
let runtime: Runtime | undefined, directory: string | undefined;
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('serves the portal check-in, progress, waiver and billing routes from the runtime services', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-portal-runtime-'));
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ef'.repeat(32),
    AUTH_SECRET: 'runtime-portal-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on', TENANCY: 'single',
    PUBLIC_ORIGIN: 'https://gym.example.test', NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') };
  const gymId = uuidv7(), qrKey = encryptSecret(parseEncryptionKey(env.APP_ENCRYPTION_KEY), 'qr_key', randomBytes(32).toString('base64url'));
  await factory('gyms', gymId, { billingEnabled: true, qrKey });
  const fake = new FakePayments(gymId, clock, 'synthetic-runtime-secret');
  fake.seedCustomer({ id: 'cus_portal', email: 'payer@example.test' });
  vi.spyOn(stripeStep, 'createPaymentsResolver').mockReturnValue(async () => fake as unknown as StripePayments);
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_portal' });
  const member = await factory('members', gymId, { householdId: household.id, dateOfBirth: '1990-01-02' });
  await factory('waiverTemplates', gymId);
  const open = await factory('invoices', gymId, { householdId: household.id, number: 1, status: 'open', amountCents: 2500 });
  const paid = await factory('invoices', gymId, { householdId: household.id, number: 2, status: 'paid', amountCents: 1000,
    paidAt: new Date('2026-09-21T10:00:00Z') });
  const accounts = createAccountService(authConfig(env), () => db.system.db);
  const user = await accounts.createPasswordUser(gymId, 'payer@example.test', 'Payer', 'portal-payer-password', clock);
  await factory('householdUsers', gymId, { householdId: household.id, userId: user.userId, scope: 'payer', memberId: member.id });
  runtime = await startRuntime(env);
  const app = runtime.app;
  const headers = (cookie = '') => ({ host: 'gym.example.test', origin: env.PUBLIC_ORIGIN, 'content-type': 'application/json', cookie });
  const signIn = await app.request(env.PUBLIC_ORIGIN + '/api/auth/sign-in/email', { method: 'POST', headers: headers(),
    body: JSON.stringify({ email: 'payer@example.test', password: 'portal-payer-password' }) });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const request = (method: string, path: string, body?: unknown) => app.request(env.PUBLIC_ORIGIN + path,
    { method, headers: headers(cookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ok = async (method: string, path: string, body?: unknown) => {
    const response = await request(method, path, body);
    expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(200);
    return response;
  };

  // Check-in codes use the runtime's encrypted gym key; progress uses the ranks criteria registry.
  const state = (await (await ok('GET', `/api/portal/members/${member.id}/checkin-code`)).json()).data;
  expect(state).toMatchObject({ memberId: member.id, code: null });
  const issued = await (await ok('POST', `/api/portal/members/${member.id}/checkin-code`, { revision: state.revision })).json();
  expect(issued.data.code).toEqual(expect.any(String));
  await ok('GET', `/api/portal/members/${member.id}/progress`);
  await ok('GET', `/api/portal/members/${member.id}/attendance`);
  // Waivers use the service configureWaivers returns.
  expect((await (await ok('GET', '/api/portal/waivers/pending')).json()).data).toHaveLength(1);
  // Receipts use the gym's file storage.
  expect((await (await ok('GET', `/api/portal/invoices/${paid.id}/receipt`)).json()).data.url).toEqual(expect.any(String));
  // Pay uses the runtime's signed-link Checkout, and Stripe's return to /l/return opens the portal's
  // receipt cookie with the key the signed-link pages share.
  const started = await ok('POST', `/api/portal/invoices/${open.id}/checkout`);
  expect((await started.json()).data.url).toEqual(expect.any(String));
  const receipt = started.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const returned = await app.request(env.PUBLIC_ORIGIN + '/l/return', { headers: { host: 'gym.example.test', cookie: receipt } });
  expect(returned.status).toBe(302);
  expect(returned.headers.get('location')).toMatch(/^\/l\/[^/?]+\?returned=1$/);
});
