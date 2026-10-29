// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { households, invoices, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { SmtpEmail } from '../infra/email/index.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import type { JobHandler } from '../infra/jobs/index.js';
import { FakePayments } from '../infra/payments/index.js';
import type { StripePayments } from '../infra/payments/stripe.js';
import * as stripeStep from '../areas/setup/stripe-step.js';
import { encryptSmtpConfig } from '../areas/settings/smtp.js';
import { demoSignaturePng } from '../demo/seed/waivers-image.js';
import { clock } from './clock.js';
import { parseEncryptionKey } from './secrets.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db);
let runtime: Runtime | undefined, directory: string | undefined;
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('joins, pays through Checkout and activates only from the webhook, then sends the portal sign-in link', async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const handlers = new Map<string, JobHandler>(), register = PostgresJobs.prototype.handle;
  vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler) {
    handlers.set(name, handler); register.call(this, name, handler);
  });
  const send = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockResolvedValue({ status: 'sent', messageId: 'join-sign-in' });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-join-runtime-'));
  const origin = 'https://gym.example.test', key = 'ab'.repeat(32), secret = 'synthetic-runtime-secret';
  const env = { DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: key, AUTH_SECRET: 'join-runtime-secret-at-least-32-characters',
    TENANCY: 'single', PUBLIC_ORIGIN: origin, NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') };
  const gymId = uuidv7();
  // With SMTP configured, logins are passwordless, so the join proves the address with a sign-in link.
  await factory('gyms', gymId, { currency: 'CAD', billingEnabled: true, memberEmailsEnabled: true, websiteEnabled: false,
    smtpConfig: encryptSmtpConfig(parseEncryptionKey(key), { host: 'smtp.example.invalid', port: 587, security: 'starttls',
      from: 'desk@example.invalid', username: 'gym', password: 'private-smtp-secret' }) });
  const plan = await factory('plans', gymId, { name: 'Adult monthly', amountCents: 15000, currency: 'CAD', interval: 'monthly', signupFeeCents: 5000 });
  const template = await factory('waiverTemplates', gymId);
  const fake = new FakePayments(gymId, clock, secret);
  vi.spyOn(stripeStep, 'createPaymentsResolver').mockReturnValue(async () => fake as unknown as StripePayments);
  runtime = await startRuntime(env);
  const app = runtime.app;
  const post = (path: string, body: unknown, cookie = '') => app.request(origin + path, { method: 'POST', body: JSON.stringify(body),
    headers: { host: 'gym.example.test', origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });

  const person = { firstName: 'Avery', lastName: 'Joiner', dateOfBirth: '1990-01-02' }, contact = { name: 'Avery Joiner', email: 'avery@example.invalid' };
  const admission = await post('/join/signatures', { planId: plan.id, contact, honeypot: '', members: [{ member: person,
    signatures: [{ templateId: template.id, templateVersion: template.version, pngBase64: demoSignaturePng().toString('base64') }] }] });
  expect(admission.status, await admission.clone().text()).toBe(200);
  const images = (await admission.json()).data as Record<string, unknown>[][];
  const submitted = await post('/api/public/join', { planId: plan.id, contact, honeypot: '', members: [{ member: person,
    waivers: images[0]!.map(image => ({ ...image, consent: true, signer: { kind: 'self', name: 'Avery Joiner' } })) }] });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  const cookie = submitted.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

  // The continuation starts Checkout through the runtime's signed-link Checkout.
  const checkout = await app.request(origin + '/join/checkout', { headers: { host: 'gym.example.test', cookie } });
  expect(checkout.status).toBe(303);
  const sessionId = new URL(checkout.headers.get('location')!).pathname.slice(1);
  const joined = () => db.forGym(gymId, async tx => {
    // The gym's only household is the one the join created.
    const [home] = await tx.select().from(households);
    return { people: await tx.select().from(members).where(eq(members.householdId, home!.id)),
      bills: await tx.select().from(invoices).where(eq(invoices.householdId, home!.id)) };
  });
  expect((await joined()).people.map(p => p.status)).toEqual(['prospect']);
  const loginLinks = () => send.mock.calls.filter(([message]) => message.to === contact.email);
  expect(loginLinks()).toHaveLength(0);

  // Only the signed webhook, dispatched by the runtime's handlers, pays the invoice and activates the people.
  const finished = fake.completeCheckout(sessionId);
  const body = JSON.stringify({ id: 'evt_' + uuidv7(), type: 'checkout.session.completed', gymId, objectId: finished.id, objectKind: 'checkout' });
  expect((await app.request(origin + '/webhooks/stripe', { method: 'POST', body,
    headers: { 'stripe-signature': fake.signWebhook(new TextEncoder().encode(body)) } })).status).toBe(200);
  await handlers.get('billing.webhooks.dispatch')!({ eventId: JSON.parse(body).id }, { gymId, clock, timezone: 'UTC', jobId: uuidv7(), attempt: 1 });
  const after = await joined();
  expect(after.people.map(p => p.status)).toEqual(['active']);
  // One invoice: join keeps its own membership service, so no separate sign-up fee invoice is issued.
  expect(after.bills.map(bill => bill.status)).toEqual(['paid']);
  expect(loginLinks()).toHaveLength(1);
});
