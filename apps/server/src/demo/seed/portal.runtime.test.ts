// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attendances, auditEvents, emailOutbox, households, invoices, members, plans, uuidv7, waiverTemplates } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { clock } from '../../core/clock.js';
import { startRuntime, type Runtime } from '../../core/runtime.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { FakePayments, type CreateCharge } from '../../infra/payments/index.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { demoSignatureLimit, demoSignatureReservation, reserveDemoSignature } from '../waiver-signatures.js';
import * as seedPayments from './billing-payments.js';
import { demoPlans } from './billing.js';
import { demoStudent, studentClassesPerWeek } from './portal.js';
import { demoSignaturePng } from './waivers-image.js';

const db = useTestDatabase(), install = 'https://demo.example.test', secret = 'whsec_SYNTHETIC';
const gateways = new Map<string, FakePayments>();
const queues: PostgresJobs[] = [];
let runtime: Runtime, storage: Awaited<ReturnType<typeof s3Server>>, directory: string;
type Sandbox = { gymId: string; origin: string; kioskToken: string };
let sandbox: Sandbox, other: Sandbox;

/** One FakePayments per sandbox stands in for the shared Stripe test account; the real test-card path is checked by hand. */
class TestPayments extends FakePayments {
  override async createCharge(input: CreateCharge) {
    const charge = await super.createCharge(input);
    this.respondNextConfirmation('succeeded');
    return charge;
  }
}
beforeAll(async () => {
  // The test drains the runtime's own queue instead of polling it.
  vi.spyOn(PostgresJobs.prototype, 'start').mockImplementation(function (this: PostgresJobs) { queues.push(this); return { async stop() {} }; });
  // The seeds resolve the gym key from the process environment, as in production.
  vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.spyOn(seedPayments, 'billingSeedPayments').mockImplementation(({ gymId }) => {
    let payments = gateways.get(gymId);
    if (!payments) gateways.set(gymId, payments = new TestPayments(gymId, clock, secret));
    const owned = payments;
    return { gymId, mode: 'test', payments: owned, async seedCard(customerId) {
      const id = 'pm_' + uuidv7().replaceAll('-', '');
      owned.recordPaymentMethod({ id, customerId, last4: '4242', expiresMonth: 12, expiresYear: 2030 });
      return id;
    } };
  });
  storage = await s3Server();
  directory = await mkdtemp(join(tmpdir(), 'demo-portal-runtime-'));
  runtime = await startRuntime({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32), AUTH_SECRET: 'demo-portal-runtime-secret-with-32-characters',
    TENANCY: 'multi', DEMO_MODE: 'true', DEMO_DOMAIN: 'demo.example.test', PUBLIC_ORIGIN: install, NODE_ENV: 'production',
    DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: secret,
    UPLOADS_S3_BUCKET: 'demo-uploads', UPLOADS_S3_ENDPOINT: storage.endpoint, UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test',
    BACKUP_STAGING_DIR: join(directory, 'staging') });
  const create = async () => (await (await send(install, '/api/demo/sandboxes', { body: {} })).json()).data as Sandbox;
  sandbox = await create(); other = await create();
}, 180_000);
afterAll(async () => {
  await runtime?.stop(); await storage?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function drain() {
  const [queue] = queues;
  for (let count = 0; count < 200; count++) if (!await queue!.runNext()) return;
  throw new Error('Job drain exceeded its bound');
}

function send(base: string, path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  return runtime.app.request(base + path, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { host: new URL(base).host, origin: base, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
}
const cookiesOf = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
/** The kiosk picks the one booked current class, or offers a choice; the visitor then taps open mat. */
async function checkIn(target: Sandbox, code: string) {
  const scan = (body: unknown) => send(target.origin, '/api/kiosk/checkin/qr', { body, headers: { authorization: `Bearer ${target.kioskToken}` } });
  let result = (await (await scan({ code })).json()).data as { status: string; member?: { id: string } };
  if (result.status === 'select_session') result = (await (await scan({ code, sessionId: null })).json()).data;
  return result;
}

it('opens a fresh sandbox student portal with bookings, a waitlist place, progress, paid invoices and a QR code for the kiosk', async () => {
  const login = await send(sandbox.origin, '/api/demo/login', { body: { role: 'student' } });
  expect(login.status).toBe(200);
  expect(await login.json()).toEqual({ data: { redirect: '/portal' } });
  const cookie = cookiesOf(login);
  const [student] = await db.forGym(sandbox.gymId, tx => tx.select().from(members).where(and(eq(members.firstName, demoStudent.firstName), eq(members.lastName, demoStudent.lastName))));
  const read = async (path: string) => {
    const response = await send(sandbox.origin, path, { cookie });
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
    return (await response.json()).data;
  };
  const bookings = await read(`/api/portal/members/${student!.id}/bookings?limit=20&offset=0`) as { status: string; queueRank: number | null }[];
  expect(bookings.map(row => row.status).sort()).toEqual(['booked', 'booked', 'waitlisted']);
  expect(bookings.find(row => row.status === 'waitlisted')!.queueRank).toBe(1);
  // The latest stripe has met its time at rank; two classes a week since then leave its class target unmet.
  const progress = await read(`/api/portal/members/${student!.id}/progress`) as { criteria: { criterionId: string; current: number; required: number; eligible: boolean }[] };
  expect(progress.criteria).toEqual(expect.arrayContaining([
    expect.objectContaining({ criterionId: 'classes-since-promotion', current: 4 * studentClassesPerWeek, required: 12, eligible: false }),
    expect.objectContaining({ criterionId: 'time-at-rank', required: 45, eligible: true }),
  ]));
  expect((await read('/api/portal/invoices?limit=20&offset=0') as { status: string }[]).map(row => row.status)).toEqual(['paid', 'paid', 'paid']);
  const { code } = await read(`/api/portal/members/${student!.id}/checkin-code`) as { code: string };
  expect(code).toMatch(/^pgci1_/);

  // Sandboxes are separate gyms: neither the student's session nor its QR code works in another one.
  const foreign = await send(other.origin, `/api/portal/members/${student!.id}/bookings?limit=20&offset=0`, { cookie });
  expect([401, 403, 404]).toContain(foreign.status);
  expect(await foreign.text()).not.toContain(student!.id);
  expect(await checkIn(other, code)).toEqual({ status: 'see_front_desk' });
  const before = await db.forGym(sandbox.gymId, tx => tx.select().from(attendances).where(eq(attendances.memberId, student!.id)));
  expect(await checkIn(sandbox, code)).toMatchObject({ status: 'checked_in', member: { id: student!.id } });
  expect(await db.forGym(sandbox.gymId, tx => tx.select().from(attendances).where(eq(attendances.memberId, student!.id)))).toHaveLength(before.length + 1);
}, 60_000);

it('lets a visitor join with the test card, activates only from the shared webhook, signs in from the outbox and checks in with a new QR code', async () => {
  const page = await send(sandbox.origin, '/join');
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(demoPlans[0].name);
  const [plan] = await db.forGym(sandbox.gymId, tx => tx.select().from(plans).where(eq(plans.name, demoPlans[0].name)));
  const [template] = await db.forGym(sandbox.gymId, tx => tx.select().from(waiverTemplates));
  const admissions = () => db.forGym(sandbox.gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, demoSignatureReservation)));
  const admitted = await admissions();
  const person = { firstName: 'Riley', lastName: 'Visitor', dateOfBirth: '1994-05-06' }, contact = { name: 'Riley Visitor', email: 'riley.visitor@example.invalid' };
  const admission = await send(sandbox.origin, '/join/signatures', { body: { planId: plan!.id, contact, honeypot: '', members: [{ member: person,
    signatures: [{ templateId: template!.id, templateVersion: template!.version, pngBase64: demoSignaturePng().toString('base64') }] }] } });
  expect(admission.status, await admission.clone().text()).toBe(200);
  // The drawn signature takes one of the sandbox's bounded, audited signature-image admissions.
  expect(await admissions()).toBe(admitted + 1);
  const images = (await admission.json()).data as Record<string, unknown>[][];
  const submitted = await send(sandbox.origin, '/api/public/join', { body: { planId: plan!.id, contact, honeypot: '', members: [{ member: person,
    waivers: images[0]!.map(image => ({ ...image, consent: true, signer: { kind: 'self', name: contact.name } })) }] } });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  const joinCookie = cookiesOf(submitted);
  const checkout = await send(sandbox.origin, '/join/checkout', { cookie: joinCookie });
  expect(checkout.status).toBe(303);
  const sessionId = new URL(checkout.headers.get('location')!).pathname.slice(1);
  const joined = async () => {
    const [home] = await db.forGym(sandbox.gymId, tx => tx.select().from(households).where(eq(households.email, contact.email)));
    return db.forGym(sandbox.gymId, async tx => ({ people: await tx.select().from(members).where(eq(members.householdId, home!.id)),
      bills: await tx.select().from(invoices).where(eq(invoices.householdId, home!.id)) }));
  };
  expect((await joined()).people.map(row => row.status)).toEqual(['prospect']);

  // The install's one webhook endpoint routes the session's event to its sandbox by the gym metadata Checkout carries.
  const payments = gateways.get(sandbox.gymId)!, finished = payments.completeCheckout(sessionId), eventId = 'evt_' + uuidv7();
  const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', gymId: sandbox.gymId, objectId: finished.id, objectKind: 'checkout',
    data: { object: { metadata: { gym_id: sandbox.gymId } } } });
  const delivered = await runtime.app.request(install + '/webhooks/stripe', { method: 'POST', body,
    headers: { host: 'demo.example.test', 'stripe-signature': payments.signWebhook(new TextEncoder().encode(body)) } });
  expect(delivered.status, await delivered.clone().text()).toBe(200);
  await drain();
  const after = await joined();
  expect(after.people.map(row => row.status)).toEqual(['active']);
  expect(after.bills.map(row => row.status)).toEqual(['paid']);
  expect(await (await send(sandbox.origin, '/join/return', { cookie: joinCookie })).text()).toContain('Welcome');

  // The passwordless sign-in link goes to this sandbox's outbox and lands the visitor in the portal.
  const mail = await db.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox).where(eq(emailOutbox.recipient, contact.email)));
  expect(mail).toHaveLength(1);
  expect(await db.forGym(other.gymId, tx => tx.select().from(emailOutbox).where(eq(emailOutbox.recipient, contact.email)))).toEqual([]);
  const link = new URL(mail[0]!.text.match(/https:\/\/\S+/)![0]);
  expect(link.origin).toBe(sandbox.origin);
  const verified = await send(sandbox.origin, link.pathname + link.search);
  expect([302, 303]).toContain(verified.status);
  const callback = new URL(verified.headers.get('location')!, sandbox.origin);
  expect(callback.pathname).toBe('/portal/claim');
  const cookie = cookiesOf(verified);
  const claimed = await send(sandbox.origin, '/api/portal/claims/complete', { body: { claim: callback.searchParams.get('claim') }, cookie });
  expect(claimed.status, await claimed.clone().text()).toBe(200);
  const member = after.people[0]!, path = `/api/portal/members/${member.id}/checkin-code`;
  const current = await send(sandbox.origin, path, { cookie });
  expect(current.status, await current.clone().text()).toBe(200);
  const { revision } = (await current.json()).data as { revision: number };
  const issued = await send(sandbox.origin, path, { body: { revision }, cookie });
  expect(issued.status, await issued.clone().text()).toBe(200);
  const { code } = (await issued.json()).data as { code: string };
  expect(await checkIn(sandbox, code)).toMatchObject({ status: 'checked_in', member: { id: member.id } });
}, 60_000);

it('refuses a join once the sandbox has used its signature-image admissions', async () => {
  const [plan] = await db.forGym(other.gymId, tx => tx.select().from(plans).where(eq(plans.name, demoPlans[0].name)));
  const [template] = await db.forGym(other.gymId, tx => tx.select().from(waiverTemplates));
  const [anyone] = await db.forGym(other.gymId, tx => tx.select().from(members).limit(1));
  for (let used = 0; used < demoSignatureLimit; used++)
    await reserveDemoSignature(db.forGym, { gymId: other.gymId, actor: { kind: 'system' } }, anyone!.id, clock.now());
  const person = { firstName: 'Limit', lastName: 'Visitor', dateOfBirth: '1994-05-06' };
  const admission = await send(other.origin, '/join/signatures', { body: { planId: plan!.id, contact: { name: 'Limit Visitor', email: 'limit@example.invalid' },
    honeypot: '', members: [{ member: person, signatures: [{ templateId: template!.id, templateVersion: template!.version, pngBase64: demoSignaturePng().toString('base64') }] }] } });
  expect(admission.status).toBe(429);
  expect(await admission.json()).toMatchObject({ error: { code: 'rate_limited' } });
}, 60_000);
