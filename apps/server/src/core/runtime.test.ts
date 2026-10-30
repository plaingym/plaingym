// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Assembly test inspects install cleanup jobs, stored webhooks and gym settings in real PostgreSQL.
import { attendances, auditEvents, classBookings, classSessions, emailOutbox, gyms, households, householdUsers, invoices, jobs, kioskDevices, members, memberships, paymentAttempts, paymentMethods, payments, programs, stripeEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { floodLimit, poolSize, startRuntime, runCommandLine, type Runtime } from './runtime.js';
import { SmtpEmail } from '../infra/email/index.js';
import { createSignedLinksService } from '../areas/links/service.js';
import { atomicJson } from '../areas/health/backups.files.js';
import { s3Server } from '../infra/storage/s3-server.test-helper.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import type { JobHandler } from '../infra/jobs/index.js';
import * as stripeAdapter from '../infra/payments/stripe.js';
import { StripeFixtures } from '../infra/payments/stripe-fixtures.js';
import { clock, TestClock } from './clock.js';
import { setLogSink } from './log.js';

const database = useTestDatabase();
const factory = createFactories(database), handlers = new Map<string, JobHandler>();
const origin = 'https://demo.example.test';
const demoStripeEnv = { DEMO_STRIPE_TEST_KEY: 'rk_test_runtime', DEMO_STRIPE_WEBHOOK_SECRET: 'whsec_runtime' };
let runtime: Runtime, directory: string, ownerCookie: string;
let storage: Awaited<ReturnType<typeof s3Server>>;
let sandbox: { gymId: string; origin: string; kioskToken: string };
const env = () => ({ DATABASE_URL: database.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32), AUTH_SECRET: 'runtime-secret-with-at-least-32-characters',
  TENANCY: 'multi', DEMO_MODE: 'true', DEMO_DOMAIN: 'demo.example.test', PUBLIC_ORIGIN: origin, NODE_ENV: 'production',
  UPLOADS_S3_BUCKET: 'demo-uploads', UPLOADS_S3_ENDPOINT: storage.endpoint,
  UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test',
  // Invalid SMTP would fail immediately if demo startup constructed a resolver.
  SMTP_HOST: 'never-connect.invalid', SMTP_SECURITY: 'invalid',
  BACKUP_STAGING_DIR: join(directory, 'staging') });
const post = (path: string, body: unknown, base = origin, extra: Record<string, string> = {}) => runtime.app.request(base + path, {
  method: 'POST', headers: { host: new URL(base).host, origin: base, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
});
async function restartRuntime(overrides: NodeJS.ProcessEnv = {}) {
  await runtime.stop();
  runtime = await startRuntime({ ...env(), ...overrides });
}
beforeAll(async () => {
  // Keep production registrations and database jobs; drive their handlers explicitly without polling races.
  const handle = PostgresJobs.prototype.handle;
  vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler) {
    handlers.set(name, handler); handle.call(this, name, handler);
  });
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'runtime-demo-'));
  storage = await s3Server();
  runtime = await startRuntime(env());
});
afterAll(async () => { await runtime?.stop(); await storage?.close(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

it('sizes the app pool from DATABASE_POOL_MAX within the connection budget', () => {
  expect(poolSize({})).toBe(8);
  expect(poolSize({ DATABASE_POOL_MAX: '4' })).toBe(4);
  for (const value of ['0', '-1', '1.5', 'many', '101']) expect(() => poolSize({ DATABASE_POOL_MAX: value })).toThrow('DATABASE_POOL_MAX');
});
it('reads the flood limit from RATE_LIMIT_PER_MINUTE, leaving the default when unset', () => {
  expect(floodLimit({})).toBeUndefined();
  expect(floodLimit({ RATE_LIMIT_PER_MINUTE: '20000' })).toBe(20_000);
  for (const value of ['', '0', '-1', '1.5', 'many', '100001']) expect(() => floodLimit({ RATE_LIMIT_PER_MINUTE: value })).toThrow('RATE_LIMIT_PER_MINUTE');
});
it('migrates through the maintenance role from the command line, without the app settings', async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  try {
    vi.stubEnv('MAINTENANCE_DATABASE_URL', '');
    expect(await runCommandLine(['migrate'], io, {})).toBe(1);
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining('MAINTENANCE_DATABASE_URL'));
    // The test database is already migrated, so this proves the command is safe to repeat.
    vi.stubEnv('MAINTENANCE_DATABASE_URL', database.maintenanceUrl);
    expect(await runCommandLine(['migrate'], io, {})).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith('Database migrated');
  } finally { vi.unstubAllEnvs(); }
});
it('refuses live keys before trying to open a database', async () => {
  await expect(startRuntime({ ...env(), DATABASE_URL: 'invalid', STRIPE_KEY: 'sk_live_forbidden' })).rejects.toThrow(/live/);
});
it('reprints the setup link without requiring a database connection', async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() }, token = 'private-installer-token-at-least-32-characters';
  expect(await runCommandLine(['setup-link'], io, { PUBLIC_ORIGIN: origin, SETUP_TOKEN: token })).toBe(0);
  expect(io.stdout).toHaveBeenCalledWith(origin + '/setup#token=' + token);
  expect(await runCommandLine(['setup-link'], io, { PUBLIC_ORIGIN: origin })).toBe(1);
});
it('serves the demo entry and creates sandboxes before tenant resolution, with setup disabled', async () => {
  const discovery = await runtime.app.request(origin + '/api/demo');
  expect(discovery.status).toBe(200);
  expect(await discovery.json()).toEqual({ data: { mode: 'entry' } });
  const response = await post('/api/demo/sandboxes', {});
  expect(response.status).toBe(201);
  sandbox = (await response.json()).data;
  const status = await runtime.app.request(sandbox.origin + '/api/demo', { headers: { host: new URL(sandbox.origin).host } });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ data: { mode: 'sandbox', expiresAt: expect.any(String) } });
  expect((await runtime.app.request('https://unknown.example.test/api/demo')).status).toBe(404);
  expect((await post('/api/setup/owner', {}, sandbox.origin)).status).toBe(404);
  expect((await runtime.app.request(sandbox.origin + '/api/setup', { headers: { host: new URL(sandbox.origin).host } })).status).toBe(404);
  expect((await database.forGym(sandbox.gymId, (tx) => tx.select().from(programs))).length).toBeGreaterThan(0);
  expect((await database.forSystem((tx) => tx.select().from(jobs).where(eq(jobs.name, 'demo.expire'))))).toHaveLength(1);
});
it('routes real login and signed-link email into the outbox without SMTP', async () => {
  const send = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockRejectedValue(new Error('SMTP must not run'));
  const login = await post('/api/demo/login', { role: 'owner' }, sandbox.origin);
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  ownerCookie = cookie;
  expect((await runtime.app.request(sandbox.origin + '/api/auth/bootstrap', { headers: { host: new URL(sandbox.origin).host, cookie } })).status).toBe(200);
  expect((await post('/api/auth/sign-in/magic-link', { email: `owner.${sandbox.gymId}@example.invalid`, callbackURL: '/admin' }, sandbox.origin)).status).toBe(200);
  const [household] = await database.forGym(sandbox.gymId, (tx) => tx.select().from(householdUsers));
  await database.forGym(sandbox.gymId, (tx) => tx.update(gyms).set({ memberEmailsEnabled: true }).where(eq(gyms.id, sandbox.gymId)));
  await createSignedLinksService().send({ gymId: sandbox.gymId, actor: { kind: 'system' } }, {
    purpose: 'update_card', householdId: household!.householdId, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const messages = await database.forGym(sandbox.gymId, (tx) => tx.select().from(emailOutbox));
  expect(messages).toHaveLength(2);
  expect(messages.some((message) => message.text.includes(sandbox.origin + '/l/'))).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
it('publishes, sends and scans campaigns through the runtime composition', async () => {
  const household = await factory('households', sandbox.gymId, { email: 'campaign@example.test', stripeCustomerId: 'cus_campaign_runtime' });
  const response = await post('/api/link-campaigns', { name: 'Collect cards', purpose: 'update_card',
    recipients: [{ householdId: household.id }], reminderSchedule: [], expiresAt: new Date(clock.now().getTime() + 86400000).toISOString(),
  }, sandbox.origin, { cookie: ownerCookie });
  expect(response.status).toBe(200);
  const run = async (name: string, payload: unknown) => {
    const handler = handlers.get(name); expect(handler, name).toBeDefined();
    await handler!(payload, { gymId: sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
  };
  for (const name of ['links.campaigns.publish', 'links.campaigns.send']) {
    const queued = await database.forGym(sandbox.gymId, tx => tx.select().from(jobs).where(eq(jobs.name, name)));
    expect(queued).toHaveLength(1);
    await run(name, (queued[0]!.payload as { value: unknown }).value);
  }
  await run('links.campaigns.scan', {});
  const messages = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox));
  expect(messages.filter(message => message.recipient === household.email)).toEqual([
    expect.objectContaining({ text: expect.stringContaining(sandbox.origin + '/l/') }),
  ]);
});
it('separates real member and staff sessions through the runtime composition', async () => {
  const login = await post('/api/demo/login', { role: 'student' }, sandbox.origin);
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { host: new URL(sandbox.origin).host, cookie };
  const context = await runtime.app.request(sandbox.origin + '/api/portal/context', { headers });
  expect(context.status).toBe(200);
  expect(await context.json()).toMatchObject({ data: { role: 'payer', householdId: expect.any(String) } });
  for (const path of ['/api/staff/profiles', '/api/settings/go-live', '/api/dashboard']) {
    expect((await runtime.app.request(sandbox.origin + path, { headers })).status, path).toBe(403);
  }
  expect((await runtime.app.request(sandbox.origin + '/api/portal/context', {
    headers: { ...headers, cookie: ownerCookie },
  })).status).toBe(404);
});
it('delivers portal invitations to the demo outbox on the canonical gym origin', async () => {
  const send = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockRejectedValue(new Error('SMTP must not run'));
  const home = await factory('households', sandbox.gymId), email = 'portal.invite@example.invalid';
  const response = await post(`/api/households/${home.id}/portal-invitations`, {
    email, scope: 'payer', delivery: 'email',
  }, sandbox.origin, { cookie: ownerCookie });
  expect(response.status).toBe(200);
  const messages = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox).where(eq(emailOutbox.recipient, email)));
  expect(messages).toHaveLength(1);
  expect(messages[0]!.text).toContain(sandbox.origin + '/portal/claim#');
  expect(send).not.toHaveBeenCalled();
});
it('serves rank and import routes through the runtime composition', async () => {
  const login = await post('/api/demo/login', { role: 'owner' }, sandbox.origin);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const headers = { host: new URL(sandbox.origin).host, cookie };
  // Ranks answer 503 until configured with attendance queries.
  expect((await runtime.app.request(sandbox.origin + '/api/programs', { headers })).status).toBe(200);
  // Import and export routes exist only when composed with storage and the job queue.
  const document = await (await runtime.app.request(sandbox.origin + '/api/openapi.json', { headers })).json() as { paths: Record<string, unknown> };
  expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/api/imports/uploads', '/api/exports', '/api/uploads/download']));
  // Household PINs hash with the gym's own key once the runtime composes members.
  const homeId = uuidv7();
  await database.forGym(sandbox.gymId, (tx) => tx.insert(households).values({ id: homeId, gymId: sandbox.gymId, name: 'PIN family' }));
  const pin = await runtime.app.request(sandbox.origin + '/api/households/' + homeId + '/pin', { method: 'PUT',
    headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, pin: '2468' }) });
  expect(pin.status).toBe(200);
  const [stored] = await database.forGym(sandbox.gymId, (tx) => tx.select({ pinHash: households.pinHash }).from(households).where(eq(households.id, homeId)));
  expect(stored!.pinHash).toMatch(/^[a-f0-9]{64}$/);
});
it('serves staff, dashboard, go-live, and waiver routes through the runtime composition', async () => {
  const login = await post('/api/demo/login', { role: 'owner' }, sandbox.origin);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const headers = { host: new URL(sandbox.origin).host, cookie };
  // Each fails until the runtime configures it.
  for (const path of ['/api/staff/profiles', '/api/dashboard', '/api/settings/go-live', '/api/waivers/templates', '/api/waivers/signatures'])
    expect((await runtime.app.request(sandbox.origin + path, { headers })).status, path).toBe(200);
  // Demo invitations go to the in-app outbox; printed ones return a link on the gym's own origin.
  const invite = await runtime.app.request(sandbox.origin + '/api/staff/invitations', { method: 'POST',
    headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new.coach@example.invalid', role: 'coach', delivery: 'print' }) });
  expect(invite.status).toBe(200);
  const { data } = await invite.json() as { data: { invitationUrl: string } };
  expect(new URL(data.invitationUrl).origin).toBe(sandbox.origin);
});
it('uses kiosk authentication ahead of sessions and blocks uploads in the running demo', async () => {
  const headers = { authorization: `Bearer ${sandbox.kioskToken}` };
  await post('/api/kiosk/lookup', { name: 'Alex', pin: '1234' }, sandbox.origin, headers);
  const [device] = await database.forGym(sandbox.gymId, (tx) => tx.select().from(kioskDevices));
  expect(device!.lastSeenAt).not.toBeNull();
  expect((await runtime.app.request(sandbox.origin + '/api/settings', { headers: { host: new URL(sandbox.origin).host, ...headers } })).status).toBe(404);
  await expect((await runtime.uploadsFor(sandbox.gymId)).put(sandbox.gymId + '/photo', new Uint8Array([1]), 'image/png')).rejects.toMatchObject({ code: 'forbidden' });
});
it('keeps install sandbox creation behind the restore gate', async () => {
  await atomicJson(join(directory, 'restore-state.json'), { phase: 'database' });
  try { expect((await post('/api/demo/sandboxes', {})).status).toBe(503); }
  finally { await atomicJson(join(directory, 'restore-state.json'), { phase: 'complete' }); }
});
it('collects assigned invoices, retries a declined cycle, serves staff billing, and detaches cards through the runtime', async () => {
  const login = await post('/api/demo/login', { role: 'owner' }, sandbox.origin);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { host: new URL(sandbox.origin).host, cookie };
  // Create the isolation fixture without billing seed data, as in the initial sandbox.
  const created = await post('/api/demo/sandboxes', {});
  expect(created.status).toBe(201);
  const otherOrigin = (await created.json()).data.origin as string;
  const [gym] = await database.forGym(sandbox.gymId, tx => tx.select().from(gyms).where(eq(gyms.id, sandbox.gymId)));
  const testClock = new TestClock('2028-03-01T12:00:00Z');
  const now = vi.spyOn(clock, 'now').mockImplementation(() => testClock.now());
  const transport = new StripeFixtures(sandbox.gymId, Math.floor(testClock.now().getTime() / 1000));
  const provider = vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(transport);
  const logs: unknown[] = [], previousLog = setLogSink(entry => { logs.push(JSON.parse(entry)); });
  const run = (name: string, payload: unknown = {}) => {
    const handler = handlers.get(name);
    expect(handler, name).toBeDefined();
    return handler!(payload, { gymId: sandbox.gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
  };
  try {
    await restartRuntime(demoStripeEnv);
    await database.forGym(sandbox.gymId, tx => tx.update(gyms).set({ timezone: 'UTC', billingEnabled: true, memberEmailsEnabled: true,
      // Keep this sandbox active while the fixed billing clock advances through day three.
      settings: { ...gym!.settings as Record<string, unknown>, demo: { sandbox: true, ready: true, expiresAt: '2028-03-05T12:00:00Z' } },
    }).where(eq(gyms.id, sandbox.gymId)));
    const home = await factory('households', sandbox.gymId, { email: 'runtime.payer@example.invalid', stripeCustomerId: 'cus_fixture' });
    const member = await factory('members', sandbox.gymId, { householdId: home.id });
    const plan = await factory('plans', sandbox.gymId, { amountCents: 10000, signupFeeCents: 2500 });
    const existingMember = await factory('members', sandbox.gymId, { householdId: home.id });
    await factory('memberships', sandbox.gymId, { householdId: home.id, memberId: existingMember.id, planId: plan.id,
      status: 'active', amountCents: 0, startsOn: '2028-02-01', nextDueOn: '2028-04-01' });
    const card = await factory('paymentMethods', sandbox.gymId, { householdId: home.id, processorId: 'pm_4242', isDefault: true });
    const assigned = await post('/api/billing/memberships', { householdId: home.id, memberId: member.id, planId: plan.id,
      startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' }, sandbox.origin, { cookie });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const assignedId = (await assigned.json()).data.id as string;
    const read = () => database.forGym(sandbox.gymId, tx => tx.select().from(invoices).where(eq(invoices.householdId, home.id)));
    const initial = await read();
    expect(initial).toHaveLength(2);
    expect(initial.every(invoice => invoice.status === 'paid')).toBe(true);
    // These effects were durably published by the same transitions used by the API and runner.
    const effectJobs = await database.forSystem(tx => tx.select().from(jobs).where(and(eq(jobs.gymId, sandbox.gymId), eq(jobs.name, 'billing.transitions.effect'))));
    for (const job of effectJobs) await run(job.name, (job.payload as { value: unknown }).value);
    expect((await database.forGym(sandbox.gymId, tx => tx.select().from(memberships).where(eq(memberships.id, assignedId))))[0]!.status).toBe('active');
    const listed = await runtime.app.request(sandbox.origin + '/api/billing/invoices?householdId=' + home.id, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.map((invoice: { id: string }) => invoice.id).sort()).toEqual(initial.map(invoice => invoice.id).sort());
    const beforeReceipt = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox));
    await run('billing.payments.receipt', { invoiceId: initial[0]!.id });
    const afterReceipt = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox));
    expect(afterReceipt).toHaveLength(beforeReceipt.length + 1);
    expect(afterReceipt.at(-1)!.text).toContain(String(initial[0]!.number));
    // The day-three transition effect must reach the real attached retry handler.
    await database.forGym(sandbox.gymId, tx => tx.update(memberships).set({ nextDueOn: '2028-03-01' }).where(eq(memberships.id, assignedId)));
    await database.forGym(sandbox.gymId, tx => tx.update(paymentMethods).set({ processorId: 'pm_0341' }).where(eq(paymentMethods.id, card.id)));
    await run('billing.runner.daily');
    const cycle = (await read()).find(invoice => invoice.kind === 'cycle')!;
    expect(cycle.status).toBe('past_due');
    const billingDashboard = await runtime.app.request(sandbox.origin + '/api/dashboard/billing', { headers });
    expect(billingDashboard.status).toBe(200);
    expect((await billingDashboard.json()).data.widgets.map((widget: { id: string }) => widget.id).sort())
      .toEqual(['disputes', 'mrr', 'past_due', 'upcoming_charges']);
    const health = await runtime.app.request(sandbox.origin + '/api/health', { headers });
    expect(health.status).toBe(200);
    expect((await health.json()).data.tiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stripe_webhooks', status: 'warning', details: expect.objectContaining({ failed: 0, pending: 0 }) }),
      expect.objectContaining({ id: 'last_charge_run', status: 'healthy', details: expect.objectContaining({ result: 'succeeded', lastCompletedAt: testClock.now().toISOString() }) }),
    ]));
    const retry = (await database.forGym(sandbox.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.transition.effect.created'))))
      .find(event => (event.after as { kind?: string; invoiceId?: string; retryDay?: number })?.kind === 'retry'
        && (event.after as { invoiceId: string }).invoiceId === cycle.id && (event.after as { retryDay: number }).retryDay === 3);
    expect(retry).toBeDefined();
    testClock.set('2028-03-04T12:00:00Z');
    await database.forGym(sandbox.gymId, tx => tx.update(paymentMethods).set({ processorId: 'pm_4242' }).where(eq(paymentMethods.id, card.id)));
    await run('billing.transitions.effect', { effectId: retry!.targetId });
    expect((await read()).find(invoice => invoice.id === cycle.id)!.status).toBe('paid');
    expect(await database.forGym(sandbox.gymId, tx => tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, cycle.id)))).toHaveLength(2);
    // A failed provider call cannot turn the already-committed assignment into an API error.
    const another = await factory('members', sandbox.gymId, { householdId: home.id });
    const request = transport.request.bind(transport);
    const fail = vi.spyOn(transport, 'request').mockRejectedValue(new Error('synthetic provider outage'));
    const committed = await post('/api/billing/memberships', { householdId: home.id, memberId: another.id, planId: plan.id,
      startsOn: '2028-03-04', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' }, sandbox.origin, { cookie });
    expect(committed.status).toBe(201);
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'billing.collect_assigned' })]));
    fail.mockImplementation(request);
    const remove = () => post(`/api/billing/households/${home.id}/payment-methods/${card.id}/revoke`, {}, sandbox.origin, { cookie });
    expect((await remove()).status).toBe(200);
    expect(transport.requests.filter(input => input.path.endsWith('/detach'))).toHaveLength(1);
    const revoked = (await database.forGym(sandbox.gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, card.id))))[0]!;
    expect(revoked.revokedAt).not.toBeNull(); expect(revoked.isDefault).toBe(false);
    expect((await remove()).status).toBe(200);
    await run('billing.payments.detach', { paymentMethodId: card.id });
    expect(transport.requests.filter(input => input.path.endsWith('/detach'))).toHaveLength(1);
    expect(await database.forGym(sandbox.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, card.id), eq(auditEvents.action, 'billing.card.revoked'))))).toHaveLength(1);
    // Erasing a household's last member revokes its card and detaches it through the runtime's queue and provider.
    const erased = await factory('households', sandbox.gymId, { email: 'erased.payer@example.invalid' });
    const leaving = await factory('members', sandbox.gymId, { householdId: erased.id });
    const erasedCard = await factory('paymentMethods', sandbox.gymId, { householdId: erased.id, processorId: 'pm_3155', isDefault: true });
    const erasure = await post(`/api/members/${leaving.id}/anonymize`, { revision: leaving.revision }, sandbox.origin, { cookie });
    expect(erasure.status, await erasure.clone().text()).toBe(200);
    const detachJobs = await database.forGym(sandbox.gymId, tx => tx.select().from(jobs).where(eq(jobs.name, 'billing.payments.detach')));
    expect(detachJobs.map(job => (job.payload as { value: { paymentMethodId: string } }).value.paymentMethodId)).toContain(erasedCard.id);
    expect(transport.requests.filter(input => input.path.endsWith('/payment_methods/pm_3155/detach'))).toHaveLength(1);
    expect((await database.forGym(sandbox.gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, erasedCard.id))))[0]!.revokedAt).not.toBeNull();
    // A dispute webhook records the dispute and queues the owner's alert at once, under the hourly scan's key.
    const [paid] = await database.forGym(sandbox.gymId, tx => tx.select().from(payments).where(eq(payments.invoiceId, cycle.id)));
    transport.objects.set('dp_runtime', { id: 'dp_runtime', object: 'dispute', payment_intent: paid!.paymentIntentId, amount: cycle.amountCents,
      currency: cycle.currency.toLowerCase(), status: 'needs_response', metadata: { gym_id: sandbox.gymId }, created: transport.now, livemode: false });
    const disputeEvent = JSON.stringify({ id: 'evt_runtime_dispute', object: 'event', type: 'charge.dispute.created', livemode: false,
      data: { object: { id: 'dp_runtime', object: 'dispute', metadata: { gym_id: sandbox.gymId } } } });
    const signedAt = Math.floor(testClock.now().getTime() / 1000);
    const disputed = await runtime.app.request(sandbox.origin + '/webhooks/stripe', { method: 'POST', body: disputeEvent,
      headers: { host: new URL(sandbox.origin).host, 'content-type': 'application/json', 'stripe-signature':
        `t=${signedAt},v1=${createHmac('sha256', demoStripeEnv.DEMO_STRIPE_WEBHOOK_SECRET).update(`${signedAt}.${disputeEvent}`).digest('hex')}` } });
    expect(disputed.status, await disputed.clone().text()).toBe(200);
    await run('billing.webhooks.dispatch', { eventId: 'evt_runtime_dispute' });
    expect((await read()).find(invoice => invoice.id === cycle.id)).toMatchObject({ disputeId: 'dp_runtime', disputeStatus: 'open' });
    const disputeAlerts = async () => (await database.forSystem(tx => tx.select().from(jobs).where(and(eq(jobs.gymId, sandbox.gymId),
      eq(jobs.name, 'billing.alerts.send'))))).filter(job => (job.payload as { value: { disputeId?: string } }).value.disputeId === 'dp_runtime');
    expect(await disputeAlerts()).toHaveLength(1);
    // Alerts use the real configured mail resolver and dashboard provider; the scan reuses the webhook's key.
    await run('billing.alerts.card_expiry'); await run('billing.alerts.disputes');
    expect(await disputeAlerts()).toHaveLength(1);
    // Later tests count this gym's stored events and dispatch jobs.
    await database.forSystem(async tx => {
      await tx.delete(stripeEvents).where(eq(stripeEvents.eventId, 'evt_runtime_dispute'));
      await tx.delete(jobs).where(and(eq(jobs.gymId, sandbox.gymId), eq(jobs.name, 'billing.webhooks.dispatch')));
    });
    const dashboard = await runtime.app.request(sandbox.origin + '/api/dashboard', { headers });
    expect(dashboard.status).toBe(200);
    expect((await dashboard.json()).data.widgets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'billing.disputes', count: 1 })]));
    // Another gym's authenticated staff can neither list nor read these invoices.
    // Return to the real clock so the other sandbox's 24-hour login remains valid.
    now.mockRestore();
    const otherLogin = await post('/api/demo/login', { role: 'owner' }, otherOrigin);
    expect(otherLogin.status).toBe(200);
    const otherCookie = otherLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const otherHeaders = { host: new URL(otherOrigin).host, cookie: otherCookie };
    const otherInvoices = await runtime.app.request(otherOrigin + '/api/billing/invoices', { headers: otherHeaders });
    expect(otherInvoices.status).toBe(200);
    expect((await otherInvoices.json()).data).toEqual([]);
    expect((await runtime.app.request(otherOrigin + '/api/billing/invoices/' + cycle.id, { headers: otherHeaders })).status).toBe(404);
  } finally {
    await database.forGym(sandbox.gymId, tx => tx.update(gyms).set({ settings: gym!.settings, billingEnabled: false }).where(eq(gyms.id, sandbox.gymId)));
    setLogSink(previousLog); now.mockRestore(); provider.mockRestore();
    await restartRuntime();
  }
});
it('serves friendly missing links and a present browser asset through the runtime', async () => {
  const headers = { host: new URL(sandbox.origin).host };
  const missing = await runtime.app.request(sandbox.origin + '/l/' + 'x'.repeat(43), { headers });
  expect(missing.status).toBe(404); expect(missing.headers.get('content-type')).toContain('text/html');
  expect(await missing.text()).not.toContain('not configured');
  await mkdir(join(directory, 'public'), { recursive: true });
  await writeFile(join(directory, 'public', 'links.js'), 'document.documentElement.dataset.runtimeAsset = "loaded";');
  const previous = process.cwd();
  try {
    process.chdir(directory);
    const script = await runtime.app.request(sandbox.origin + '/l/client.js', { headers });
    expect(script.status).toBe(200); expect(script.headers.get('content-type')).toContain('javascript');
    expect(await script.text()).toContain('runtimeAsset');
  } finally { process.chdir(previous); }
});
it('stores a signed Stripe event for its gym and queues its dispatch through the runtime composition', async () => {
  const delivery = (id: string) => {
    const body = JSON.stringify({ id, object: 'event', type: 'payment_intent.succeeded', livemode: false,
      data: { object: { id: 'pi_runtime', object: 'payment_intent', metadata: { gym_id: sandbox.gymId } } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', demoStripeEnv.DEMO_STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
    // A browser cookie on the request must not trip the origin check that guards cookie-authenticated writes.
    return runtime.app.request(sandbox.origin + '/webhooks/stripe', { method: 'POST', body,
      headers: { host: new URL(sandbox.origin).host, 'stripe-signature': signature, 'content-type': 'application/json', cookie: 'unrelated=1' } });
  };
  // This runtime has no install-level shared key.
  const unconfigured = await delivery('evt_runtime');
  expect(unconfigured.status).toBe(503);
  expect(await unconfigured.text()).toContain('Payments are not set up for this gym');
  const provider = vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(new StripeFixtures(sandbox.gymId));
  try {
    await restartRuntime(demoStripeEnv);
    expect((await delivery('evt_runtime')).status).toBe(200);
    expect((await delivery('evt_runtime')).status).toBe(200);
    const stored = await database.forGym(sandbox.gymId, (tx) => tx.select().from(stripeEvents));
    expect(stored).toMatchObject([{ eventId: 'evt_runtime', gymId: sandbox.gymId, type: 'payment_intent.succeeded' }]);
    expect(await database.forSystem((tx) => tx.select().from(jobs).where(eq(jobs.name, 'billing.webhooks.dispatch')))).toHaveLength(1);
  } finally { provider.mockRestore(); await restartRuntime(); }
});
it('issues, scans, replaces and revokes QR codes through the production runtime with real bookings', async () => {
  // Marcus is active with the seeded waiver signed, so the real standing providers pass.
  const [row] = await database.forGym(sandbox.gymId, tx => tx.select().from(members).where(eq(members.firstName, 'Marcus')));
  expect(row).toBeDefined();
  const member = row!;
  const session = await factory('classSessions', sandbox.gymId, {
    startsAt: new Date(clock.now().getTime() - 300_000), endsAt: new Date(clock.now().getTime() + 3_600_000),
  });
  await factory('classBookings', sandbox.gymId, { memberId: member.id, sessionId: session.id, status: 'booked' });
  try {
    const path = `/api/members/${member.id}/checkin-code`;
    const issued = await post(path, { revision: member.revision }, sandbox.origin, { cookie: ownerCookie });
    expect(issued.status, await issued.clone().text()).toBe(200);
    const { data: first } = await issued.json();
    expect(first.code).toMatch(/^pgci1_/);
    const headers = { host: new URL(sandbox.origin).host, cookie: ownerCookie };
    const read = await runtime.app.request(sandbox.origin + path, { headers });
    expect(await read.json()).toEqual({ data: first });
    const scan = (code: string) => post('/api/kiosk/checkin/qr', { code }, sandbox.origin,
      { authorization: `Bearer ${sandbox.kioskToken}` });
    const checked = await scan(first.code);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ data: { status: 'checked_in', member: { id: member.id } } });
    expect(await database.forGym(sandbox.gymId, tx => tx.select().from(attendances).where(and(eq(attendances.memberId, member.id), eq(attendances.sessionId, session.id)))))
      .toMatchObject([{ sessionId: session.id, source: 'kiosk' }]);
    const replacement = await post(path, { revision: first.revision }, sandbox.origin, { cookie: ownerCookie });
    const { data: second } = await replacement.json();
    expect(second.code).not.toBe(first.code);
    expect(await (await scan(first.code)).json()).toEqual({ data: { status: 'see_front_desk' } });
    const revoked = await runtime.app.request(sandbox.origin + path, { method: 'DELETE',
      headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: second.revision }) });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ data: { code: null } });
    expect(await (await scan(second.code)).json()).toEqual({ data: { status: 'see_front_desk' } });
  } finally {
    await database.forGym(sandbox.gymId, async tx => {
      await tx.delete(attendances).where(eq(attendances.sessionId, session.id));
      await tx.delete(classBookings).where(eq(classBookings.sessionId, session.id));
      await tx.delete(classSessions).where(eq(classSessions.id, session.id));
    });
  }
});

it('registers seed and webhook replay in the real CLI', async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  const cliEnv = { ...env(), ...demoStripeEnv };
  // Earlier tests stored this sandbox's fixture payment intents; start past their IDs.
  const transport = new StripeFixtures(sandbox.gymId, undefined, 1000);
  const request = transport.request.bind(transport);
  // StripeFixtures covers billing; add only the named test-token operations used by demo seeding.
  vi.spyOn(transport, 'request').mockImplementation(async input => {
    if (input.method === 'POST' && input.path === '/v1/payment_methods') {
      const params = input.params!, card = params.card as { token: string };
      expect(['tok_visa', 'tok_chargeCustomerFail']).toContain(card.token);
      const last4 = card.token === 'tok_visa' ? '4242' : '0341';
      const method = { id: 'pm_' + String((params.metadata as { household_id: string }).household_id).replaceAll('-', '') + last4,
        object: 'payment_method', customer: null, metadata: params.metadata, livemode: false,
        created: transport.now, card: { last4, exp_month: 12, exp_year: 2030 } };
      transport.objects.set(method.id, method);
      return method;
    }
    if (input.method === 'POST' && /^\/v1\/payment_methods\/pm_[A-Za-z0-9]+\/attach$/.test(input.path)) {
      const method = transport.objects.get(input.path.split('/')[3]!)!;
      method.customer = input.params!.customer;
      return method;
    }
    return request(input);
  });
  const provider = vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(transport);
  await runtime.stop();
  // A real CLI process reads these settings from its environment as well as
  // passing them into runtime preparation. Seed storage now uses them too.
  for (const [name, value] of Object.entries(cliEnv)) vi.stubEnv(name, value);
  try {
    expect(await runCommandLine(['seed', sandbox.gymId], io, cliEnv)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith('Seed complete');
    expect(await runCommandLine(['replay', '--gym', sandbox.gymId, 'evt_runtime'], io, cliEnv)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(expect.stringMatching(/^Webhook replay queued: /));
    expect(await database.forSystem((tx) => tx.select().from(jobs).where(eq(jobs.name, 'billing.webhooks.dispatch')))).toHaveLength(2);
    expect((await database.forGym(sandbox.gymId, tx => tx.select().from(gyms)))[0]!.stripeConfig).toBeNull();
  } finally { vi.unstubAllEnvs(); provider.mockRestore(); }
});

