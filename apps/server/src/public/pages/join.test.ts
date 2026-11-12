// SPDX-License-Identifier: AGPL-3.0-only
import { requestWithLength } from '../../../test/request.js';
import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The test turns a gym's billing switch off in real PostgreSQL.
import { auditEvents, gyms, households, householdUsers, invoiceLineItems, invoices, leads, members, memberships, paymentMethods, plans, signedLinks,
  waiverSignatures, waiverTemplates, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { joinAdmissionResponseSchema, publicContracts, publicSubmissionResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { createWaiverDocumentDelivery } from '../../areas/waivers/document-delivery.js';
import { waiverDocumentFixture } from '../../areas/waivers/document.fixture.js';
import { createMembershipService } from '../../areas/billing/memberships.js';
import { createSignedLinkCheckout } from '../../areas/billing/signed-link-checkout.js';
import { createSignedLinksService } from '../../areas/links/service.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { createTransitionEffects } from '../../areas/billing/transitions/effects.js';
import { createTransitionNotifications } from '../../areas/billing/transitions/notifications.js';
import { createTransitionJobs } from '../../areas/billing/transitions/transitions.jobs.js';
import { registerBillingWebhookHandlers } from '../../areas/billing/webhooks/handlers/index.js';
import type { WebhookHandler } from '../../areas/billing/webhooks/inbox.js';
import { createChargeRunner } from '../../areas/billing/runner/index.js';
import { createPortalInvitationService, type PortalLoginLinkSender } from '../../areas/members/household-users.invitations.js';
import { createHouseholdUsersService } from '../../areas/members/household-users.js';
import { createPortalPrincipalLoader } from '../../areas/members/household-users.context.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { createPortalInvitationStore } from '../../infra/auth/portal-invitations.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { configureJoin } from './join.routes.js';
import { joinBodyBytes } from './join.service.js';
import { joinCookie } from './join.continuation.js';
import { createJoinCleanup } from './join.cleanup.js';
import { jobs as joinJobs } from './join.jobs.js';

const db = useTestDatabase(), factory = createFactories(db), png = demoSignaturePng(), pngBase64 = png.toString('base64');
const origin = 'https://gym.example.test', timezone = 'America/Vancouver', key = new Uint8Array(32).fill(9);
const password = { AUTH_SECRET: 'join-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' };
const passwordConfig = authConfig(password, false);
const emailConfig = { ...passwordConfig, tenancy: 'multi' as const, passwordEnabled: false, passwordMode: 'off' as const, smtpConfigured: true };
type Person = { firstName: string; lastName: string; dateOfBirth: string };
const adult = (firstName = 'Avery'): Person => ({ firstName, lastName: 'Joiner', dateOfBirth: '1990-01-02' });
const child = (firstName = 'Kai'): Person => ({ firstName, lastName: 'Joiner', dateOfBirth: '2016-05-06' });

async function fixture(mode: 'email' | 'password' = 'email', start = '2026-10-29T18:00:00Z', currency = 'CAD', gymTimezone = timezone) {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock(start);
  await factory('gyms', gymId, { name: 'North <Gym>', currency, timezone: gymTimezone, billingEnabled: true, memberEmailsEnabled: true, websiteEnabled: false });
  await factory('gyms', otherGym, { name: 'Other private gym', currency: 'CAD', timezone: gymTimezone, billingEnabled: true });
  const plan = await factory('plans', gymId, { name: 'Adult monthly', amountCents: 15000, currency, interval: 'monthly', signupFeeCents: 5000 });
  const gst = await factory('taxRates', gymId, { name: 'GST', rateMillionths: 50_000, inclusive: false });
  await factory('planTaxRates', gymId, { planId: plan.id, taxRateId: gst.id });
  const annual = await factory('plans', gymId, { name: 'Annual', amountCents: 150000, currency, interval: 'annual' });
  const trial = await factory('plans', gymId, { name: 'Trial plan', currency, trialDays: 7 });
  const free = await factory('plans', gymId, { name: 'Free plan', currency, amountCents: 0 });
  const retired = await factory('plans', gymId, { name: 'Retired plan', currency, active: false });
  const foreignPlan = await factory('plans', otherGym, { name: 'Private other plan', currency: 'CAD' });
  const templates = [await factory('waiverTemplates', gymId, { name: 'Conduct', body: 'Follow the rules. <script>bad()</script>', kind: 'agreement' }),
    await factory('waiverTemplates', gymId, { name: 'Participation', body: 'I understand the training risks.' })];
  const foreignTemplate = await factory('waiverTemplates', otherGym, { name: 'Private other terms' });
  const existingHome = await factory('households', gymId, { name: 'Existing household', email: 'existing@example.invalid' });
  const existing = await factory('members', gymId, { householdId: existingHome.id, status: 'active', email: 'existing@example.invalid', firstName: 'Private' });
  const provider = new FakePayments(gymId, clock), paymentsFor = async () => provider;
  const uploads = new FakeUploads(gymId, clock), uploadsFor = async () => uploads;
  const documentDelivery = createWaiverDocumentDelivery({ uploadsFor, clock, key: new Uint8Array(32).fill(8), originFor: async () => origin });
  const waivers = createWaiversService({ scope: db.forGym, clock, uploadsFor, documentDelivery });
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor, originFor: async () => origin });
  const config = mode === 'password' ? passwordConfig : emailConfig, mail = new FakeEmail(), sent: Parameters<PortalLoginLinkSender>[0][] = [];
  const invitations = createPortalInvitationService({ config, database: () => db.system.db, scope: db.forGym, householdScope: db.forHousehold,
    smtpConfigured: async () => mode === 'email', mailer: async () => mail, loginLink: async input => { sent.push(input); } });
  const accounts = createAccountService(config, () => db.system.db);
  const settings = createGymSettingsAccessor({ scope: db.forGym, clock }), lifecycle = createMembershipService({ scope: db.forGym, clock, settings });
  const paymentsConfigured = vi.fn(async (id: string) => id === gymId);
  const join = configureJoin({ scope: db.forGym, clock, key, waivers, checkout, paymentsConfigured, invitations, accounts, uploadsFor,
    memberships: lifecycle, invitationStore: createPortalInvitationStore(() => db.system.db) });
  const jobs = new FakeJobs(clock), transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  const notifications = createTransitionNotifications({ scope: db.forGym, clock, settings, async prepare() { return { email: mail, origin }; }, async staffRecipients() { return []; } });
  // As the runtime composes it: the paid-invoice effect completes a join however its invoice was paid.
  const afterInvoicePaid = vi.fn((gym: string, invoiceId: string) => join.afterInvoicePaid(gym, invoiceId));
  const effects = createTransitionEffects({ scope: db.forGym, clock, jobs, settings, transitions, memberships: lifecycle, async payments() { return provider; },
    notifications, async retry() {}, afterInvoicePaid });
  for (const job of createTransitionJobs(() => effects)) jobs.handle(job.id, job.handler);
  const handlers = new Map<string, WebhookHandler>();
  // As the runtime composes it: link completion first, then the join's own completion, for every recorded Checkout.
  const afterCheckout = vi.fn(async (gym: string, link: string, session: string) => {
    try { await checkout.complete(gym, link, session); }
    catch (error) { if (!(error instanceof AppError && error.code === 'not_found')) throw error; }
    await join.afterCheckout(gym, link);
  });
  registerBillingWebhookHandlers({ register(type, handler) { handlers.set(type, handler); } }, { scope: db.forGym, clock, transitions, afterCheckoutRecorded: afterCheckout });
  async function webhook(sessionId: string, type = 'checkout.session.completed') {
    const event = { id: 'evt_' + uuidv7(), type, gymId, objectKind: 'checkout' as const, objectId: sessionId };
    await handlers.get(type)!(event, { gymId, clock, timezone: gymTimezone, jobId: uuidv7(), attempt: 1, payments: provider });
    await drain();
  }
  async function drain() { await effects.publish(gymId); while (await jobs.runNext()) { /* every effect now due */ } }
  const app = (resolved = gymId) => createApp({ skipSetup: true, clock, authorize, contributions: areaContributions, origin, rateLimit: { limit: 10_000 },
    resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: resolved, timezone: gymTimezone, enabledModules: new Set() } }); await next(); },
    session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal: { kind: 'anonymous' } }); await next(); } });
  const server = app();
  const get = (path: string, cookie = '', target = server) => target.request(origin + path, { headers: cookie ? { cookie } : {} });
  const post = (path: string, body: unknown, cookie = '', target = server) => target.request(origin + path, { method: 'POST',
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(body))) }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const signer = (person: Person) => person.dateOfBirth > '2008-10-29' ? { kind: 'guardian' as const, name: 'Pat Payer', relationship: 'Parent' }
    : { kind: 'self' as const, name: person.firstName + ' ' + person.lastName };
  async function admit(people: Person[], email: string, planId: string) {
    const response = await post('/join/signatures', { planId, contact: { name: 'Pat Payer', email }, honeypot: '',
      members: people.map(member => ({ member, signatures: templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64, signer: signer(member) })) })) });
    expect(response.status, await response.clone().text()).toBe(200);
    return joinAdmissionResponseSchema.parse(await response.json()).data;
  }
  const body = (people: Person[], images: Awaited<ReturnType<typeof admit>>, email: string, planId: string) => ({ planId, contact: { name: 'Pat Payer', email }, honeypot: '',
    members: people.map((member, i) => ({ member, waivers: images[i]!.map(image => ({ ...image, consent: true as const, signer: signer(member) })) })) });
  async function submit(people: Person[] = [adult()], email = 'payer@example.invalid', planId = plan.id) {
    const images = await admit(people, email, planId), response = await post('/api/public/join', body(people, images, email, planId));
    return { response, images, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }
  async function pay(cookie: string) {
    const response = await get('/join/checkout', cookie);
    expect(response.status).toBe(303);
    const sessionId = new URL(response.headers.get('location')!).pathname.slice(1);
    provider.completeCheckout(sessionId);
    await webhook(sessionId);
    return sessionId;
  }
  const rows = () => db.forGym(gymId, async tx => ({ homes: await tx.select().from(households).orderBy(asc(households.createdAt)),
    members: await tx.select().from(members), memberships: await tx.select().from(memberships), invoices: await tx.select().from(invoices),
    lines: await tx.select().from(invoiceLineItems), signatures: await tx.select().from(waiverSignatures), links: await tx.select().from(signedLinks),
    logins: await tx.select().from(householdUsers), methods: await tx.select().from(paymentMethods), audits: await tx.select().from(auditEvents), leads: await tx.select().from(leads) }));
  const joined = async () => (await rows()).homes.filter(h => h.id !== existingHome.id);
  return { gymId, otherGym, clock, plan, annual, trial, free, retired, foreignPlan, templates, foreignTemplate, existingHome, existing, provider, paymentsFor,
    uploads, uploadsFor, paymentsConfigured, waivers, checkout, invitations, accounts, settings, lifecycle, join, jobs, transitions, sent, mail, afterCheckout, afterInvoicePaid, webhook, drain,
    app, server, get, post, admit, body, submit, pay, rows, joined };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe('join lead intake', () => {
  it('keeps one lead and audit per member when submission fails after marking and is retried', async () => {
    const f = await fixture(), people = [adult(), child()], email = 'retry-leads@example.invalid';
    const images = await f.admit(people, email, f.plan.id), body = f.body(people, images, email, f.plan.id);
    vi.spyOn(f.waivers, 'sign').mockRejectedValueOnce(new Error('signing interrupted'));
    await expect(f.join.join(f.gymId, body, timezone, '127.0.0.1')).rejects.toThrow('signing interrupted');
    const interrupted = await f.rows();
    expect(interrupted.leads).toHaveLength(2);
    expect(interrupted.audits.filter(a => a.action === 'lead.created')).toHaveLength(2);
    await f.join.join(f.gymId, body, timezone, '127.0.0.1');
    const retried = await f.rows();
    expect(retried.leads).toEqual(interrupted.leads);
    expect(retried.audits.filter(a => a.action === 'lead.created')).toEqual(interrupted.audits.filter(a => a.action === 'lead.created'));
  });
  it('records both members on submission, keeps admission lead-free, and replays without another row or audit', async () => {
    const f = await fixture(), people = [adult(), child()], email = 'leads@example.invalid';
    const images = await f.admit(people, email, f.plan.id);
    expect((await f.rows()).leads).toEqual([]);
    expect((await f.rows()).audits.filter(a => a.action === 'lead.created')).toEqual([]);
    const body = f.body(people, images, email, f.plan.id);
    expect((await f.post('/api/public/join', body)).status).toBe(200);
    const submitted = await f.rows(), home = submitted.homes.find(h => h.email === email)!;
    expect(submitted.leads).toHaveLength(2);
    expect(submitted.leads.map(l => l.memberId).sort()).toEqual(submitted.members.filter(m => m.householdId === home.id).map(m => m.id).sort());
    for (const lead of submitted.leads) expect(lead).toMatchObject({ source: 'join', stage: 'new', revision: 1, createdAt: f.clock.now() });
    expect(submitted.audits.filter(a => a.action === 'lead.created')).toHaveLength(2);
    const homeInvoices = new Set(submitted.invoices.filter(i => i.householdId === home.id).map(i => i.id));
    const homeLines = submitted.lines.filter(l => homeInvoices.has(l.invoiceId));
    expect(homeLines.filter(l => l.kind === 'membership')).toHaveLength(2);
    for (const line of homeLines) expect(line.planId).toBe(line.kind === 'membership' || line.kind === 'signup_fee' ? f.plan.id : null);
    expect((await f.post('/api/public/join', body)).status).toBe(200);
    const replay = await f.rows();
    expect(replay.leads).toEqual(submitted.leads);
    expect(replay.audits.filter(a => a.action === 'lead.created')).toEqual(submitted.audits.filter(a => a.action === 'lead.created'));
  });
});
describe('trial and zero-value joining', () => {
  it.each(['trial', 'free'] as const)('supports native multipart joining for a %s plan', async kind => {
    const f = await fixture(), form = nativeForm(f, f[kind].id, `${kind}-native@example.invalid`);
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    if (kind === 'trial') {
      expect(response.status).toBe(200); expect(await response.text()).toContain('Save card securely');
    } else {
      expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/join/return');
    }
  });
  it('starts a trial only after its recorded card setup and bills the first full period at trial end', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCheckout'), charge = vi.spyOn(f.provider, 'createCharge');
    const { cookie, images } = await f.submit([adult(), child()], 'trial@example.invalid', f.trial.id);
    const [home] = await f.joined();
    expect(home!.billingDay).toBe(5);
    const initial = await f.rows(), bill = initial.invoices.find(i => i.householdId === home!.id)!;
    expect(bill).toMatchObject({ amountCents: 0, status: 'open', paidAt: null });
    expect(initial.memberships.filter(m => m.householdId === home!.id).map(m => [m.status, m.nextDueOn, m.trialEndsOn]))
      .toEqual([['pending', '2026-11-05', '2026-11-05'], ['pending', '2026-11-05', '2026-11-05']]);
    expect(await (await f.get('/join/return', cookie)).text()).toContain('Confirming your card setup');
    const page = await f.get('/join/checkout', cookie), sessionId = new URL(page.headers.get('location')!).pathname.slice(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ mode: 'setup', saveForOffSession: true, successUrl: origin + '/join/return', cancelUrl: origin + '/join/cancelled' });
    expect(await (await f.get('/join/return', cookie)).text()).toContain('Confirming your card setup');
    await f.join.afterCheckout(f.gymId, initial.links.find(l => l.householdId === home!.id)!.id);
    expect((await f.rows()).invoices.find(i => i.id === bill.id)!.status).toBe('open');
    f.provider.completeCheckout(sessionId);
    await f.webhook(sessionId); await f.webhook(sessionId);
    const finished = await f.rows();
    expect(finished.invoices.find(i => i.id === bill.id)).toMatchObject({ status: 'paid', amountCents: 0 });
    expect(finished.methods.filter(m => m.householdId === home!.id)).toHaveLength(1);
    expect(finished.memberships.filter(m => m.householdId === home!.id).map(m => [m.status, m.nextDueOn]))
      .toEqual([['trial', '2026-11-05'], ['trial', '2026-11-05']]);
    expect(finished.members.filter(m => m.householdId === home!.id).map(m => m.status)).toEqual(['trial', 'trial']);
    expect(f.sent).toHaveLength(1); expect(charge).not.toHaveBeenCalled();
    expect(await (await f.get('/join/return', cookie)).text()).toContain('We sent a sign-in link');
    // Submission and effect replay must not reactivate trials before their end date.
    expect((await f.post('/api/public/join', f.body([adult(), child()], images, 'trial@example.invalid', f.trial.id))).status).toBe(200);
    const runner = createChargeRunner({ scope: db.forGym, clock: f.clock, transitions: f.transitions, settings: f.settings, jobs: f.jobs, payments: f.paymentsFor });
    f.clock.set('2026-11-04T18:00:00Z');
    expect(await f.lifecycle.processDates(f.gymId, timezone)).toBe(0);
    expect((await runner.daily(f.gymId)).errors).toEqual([]);
    expect((await f.rows()).invoices.filter(i => i.householdId === home!.id)).toHaveLength(1);
    f.clock.set('2026-11-05T18:00:00Z');
    expect(await f.lifecycle.processDates(f.gymId, timezone)).toBe(2);
    expect((await f.rows()).memberships.filter(m => m.householdId === home!.id).map(m => m.status)).toEqual(['active', 'active']);
    const promoted = await f.rows();
    expect(promoted.members.filter(m => m.householdId === home!.id).map(m => [m.status, m.revision])).toEqual([['active', 3], ['active', 3]]);
    expect(promoted.audits.filter(a => a.action === 'billing.member.activated')).toHaveLength(2);
    expect((await runner.daily(f.gymId)).errors).toEqual([]);
    const cycle = (await f.rows()).invoices.filter(i => i.householdId === home!.id && i.id !== bill.id);
    expect(cycle).toMatchObject([{ status: 'paid', amountCents: 2 * f.trial.amountCents, periodStartsOn: '2026-11-05', periodEndsOn: '2026-12-05' }]);
  });
  it('settles a free plan without Checkout or a payment and keeps submission replay idempotent', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCheckout'), charge = vi.spyOn(f.provider, 'createCharge');
    const people = [adult()], email = 'free@example.invalid';
    const { cookie, images } = await f.submit(people, email, f.free.id);
    const [home] = await f.joined();
    const state = await f.rows();
    expect(state.invoices.find(i => i.householdId === home!.id)).toMatchObject({ status: 'paid', amountCents: 0 });
    expect(state.memberships.find(m => m.householdId === home!.id)).toMatchObject({ status: 'active', nextDueOn: '2026-11-29' });
    expect(await (await f.get('/join/return', cookie)).text()).toContain('We sent a sign-in link');
    expect((await f.get('/join/checkout', cookie)).headers.get('location')).toBe('/join/return');
    expect((await f.post('/api/public/join', f.body(people, images, email, f.free.id))).status).toBe(200);
    expect(f.sent).toHaveLength(1); expect(create).not.toHaveBeenCalled(); expect(charge).not.toHaveBeenCalled();
    await f.drain(); expect(f.sent).toHaveLength(1);
  });
  it('collects the sign-up fee on a trial now and preserves the first period until trial end', async () => {
    const f = await fixture(), plan = await factory('plans', f.gymId, { trialDays: 7, amountCents: 12000, signupFeeCents: 2000 });
    const { cookie } = await f.submit([adult()], 'trial-fee@example.invalid', plan.id);
    const [home] = await f.joined();
    expect((await f.rows()).invoices.find(i => i.householdId === home!.id)).toMatchObject({ amountCents: 2000, status: 'open' });
    await f.pay(cookie);
    await f.drain();
    const state = await f.rows();
    expect(state.memberships.find(m => m.householdId === home!.id)).toMatchObject({ status: 'trial', nextDueOn: '2026-11-05' });
    expect(state.members.find(m => m.householdId === home!.id)).toMatchObject({ status: 'trial' });
    expect(state.lines.filter(l => l.invoiceId === state.invoices.find(i => i.householdId === home!.id)!.id).map(l => [l.kind, l.planId]))
      .toEqual([['signup_fee', plan.id]]);
    f.clock.set('2026-11-05T18:00:00Z');
    expect(await f.lifecycle.processDates(f.gymId, timezone)).toBe(1);
    const runner = createChargeRunner({ scope: db.forGym, clock: f.clock, transitions: f.transitions, settings: f.settings, jobs: f.jobs, payments: f.paymentsFor });
    expect((await runner.daily(f.gymId)).errors).toEqual([]);
    expect((await f.rows()).invoices.filter(i => i.householdId === home!.id)).toMatchObject([
      { status: 'paid', amountCents: 2000 },
      { status: 'paid', amountCents: 12000, periodStartsOn: '2026-11-05', periodEndsOn: '2026-12-05' },
    ]);
  });
  it('starts a zero-price trial without Checkout and keeps its trial status after settlement effects', async () => {
    const f = await fixture(), trial = await factory('plans', f.gymId, { trialDays: 7, amountCents: 0 });
    const create = vi.spyOn(f.provider, 'createCheckout'), { cookie } = await f.submit([adult()], 'free-trial@example.invalid', trial.id);
    await f.drain();
    const [home] = await f.joined(), state = await f.rows();
    expect(state.invoices.find(i => i.householdId === home!.id)).toMatchObject({ amountCents: 0, status: 'paid' });
    expect(state.memberships.find(m => m.householdId === home!.id)).toMatchObject({ status: 'trial', nextDueOn: '2026-11-05' });
    expect(state.members.find(m => m.householdId === home!.id)).toMatchObject({ status: 'trial' });
    expect(await (await f.get('/join/return', cookie)).text()).toContain('We sent a sign-in link');
    expect(create).not.toHaveBeenCalled();
  });
});
describe('plan edits while joining', () => {
  it.each([[0, 7], [7, 0], [7, 14]])('uses assigned trial dates when the plan changes from %i to %i days after admission', async (before, after) => {
    const f = await fixture(), plan = await factory('plans', f.gymId, { trialDays: before, amountCents: 10000 });
    const people = [adult()], email = 'changed-trial@example.invalid', images = await f.admit(people, email, plan.id);
    await db.forGym(f.gymId, tx => tx.update(plans).set({ trialDays: after }).where(eq(plans.id, plan.id)));
    const body = f.body(people, images, email, plan.id), response = await f.post('/api/public/join', body);
    expect(response.status, await response.clone().text()).toBe(200);
    const [home] = await f.joined(), state = await f.rows();
    const trialEndsOn = after === 0 ? null : after === 7 ? '2026-11-05' : '2026-11-12';
    expect(state.homes.find(h => h.id === home!.id)?.billingDay).toBe(after === 0 ? 29 : after === 7 ? 5 : 12);
    expect(state.memberships.find(m => m.householdId === home!.id)).toMatchObject({ trialEndsOn, nextDueOn: trialEndsOn ?? '2026-11-29' });
    expect(state.invoices.find(i => i.householdId === home!.id)).toMatchObject({ amountCents: after === 0 ? 10000 : 0,
      periodEndsOn: trialEndsOn ?? '2026-11-29' });
    expect((await f.post('/api/public/join', body)).status).toBe(200);
    expect((await f.rows()).invoices.filter(i => i.householdId === home!.id)).toHaveLength(1);
  });
  it.each([['another household field', 200], ['the billing day', 409]] as const)(
    'aligns a trial join after staff change %s since admission only when the billing day is unchanged', async (edit, status) => {
      const f = await fixture(), plan = await factory('plans', f.gymId, { trialDays: 7, amountCents: 10000 });
      const people = [adult()], email = 'household-edit@example.invalid', images = await f.admit(people, email, plan.id);
      const [home] = await f.joined();
      await db.forGym(f.gymId, tx => tx.update(households).set({ revision: 2, ...(status === 409 ? { billingDay: 15 } : {}) })
        .where(eq(households.id, home!.id)));
      const response = await f.post('/api/public/join', f.body(people, images, email, plan.id));
      expect(response.status, `${edit}: ${await response.clone().text()}`).toBe(status);
      const state = await f.rows();
      expect(state.homes.find(h => h.id === home!.id)?.billingDay).toBe(status === 200 ? 5 : 15);
      expect(state.invoices.filter(i => i.householdId === home!.id)).toHaveLength(status === 200 ? 1 : 0);
    });
  it.each([[0, 7], [7, 0]])('keeps the assigned trial when its plan changes from %i to %i days before invoicing', async (before, after) => {
    const f = await fixture(), plan = await factory('plans', f.gymId, { trialDays: before, amountCents: 10000 });
    const assign = f.lifecycle.assign.bind(f.lifecycle);
    vi.spyOn(f.lifecycle, 'assign').mockImplementation(async (...args) => {
      const membership = await assign(...args);
      await db.forGym(f.gymId, tx => tx.update(plans).set({ trialDays: after }).where(eq(plans.id, plan.id)));
      return membership;
    });
    const { response } = await f.submit([adult()], 'assigned-trial@example.invalid', plan.id);
    expect(response.status, await response.clone().text()).toBe(200);
    const [home] = await f.joined(), state = await f.rows();
    expect(state.invoices.find(i => i.householdId === home!.id)).toMatchObject({ amountCents: before === 0 ? 10000 : 0,
      periodEndsOn: before === 0 ? '2026-11-29' : '2026-11-05' });
    expect(state.memberships.find(m => m.householdId === home!.id)?.trialEndsOn).toBe(before === 0 ? null : '2026-11-05');
  });
  it.each([[0, 10000], [10000, 0]])('takes the assigned price after a change from %i to %i between admission and submission', async (before, after) => {
    const f = await fixture(), plan = await factory('plans', f.gymId, { trialDays: 7, amountCents: before });
    const people = [adult()], email = 'changed-price@example.invalid', images = await f.admit(people, email, plan.id);
    await db.forGym(f.gymId, tx => tx.update(plans).set({ amountCents: after }).where(eq(plans.id, plan.id)));
    const response = await f.post('/api/public/join', f.body(people, images, email, plan.id));
    expect(response.status, await response.clone().text()).toBe(200);
    const [home] = await f.joined(), state = await f.rows();
    expect(state.memberships.find(m => m.householdId === home!.id)?.amountCents).toBe(after);
    expect(state.links.find(l => l.householdId === home!.id)?.purpose).toBe(after > 0 ? 'update_card' : 'pay_invoice');
    expect(state.invoices.find(i => i.householdId === home!.id)?.status).toBe(after > 0 ? 'open' : 'paid');
  });
  it.each([[0, 10000], [10000, 0]])('keeps card setup based on assigned price %i when the plan becomes %i before linking', async (before, after) => {
    const f = await fixture(), plan = await factory('plans', f.gymId, { trialDays: 7, amountCents: before });
    const assign = f.lifecycle.assign.bind(f.lifecycle);
    vi.spyOn(f.lifecycle, 'assign').mockImplementation(async (...args) => {
      const membership = await assign(...args);
      await db.forGym(f.gymId, tx => tx.update(plans).set({ amountCents: after }).where(eq(plans.id, plan.id)));
      return membership;
    });
    const { response, cookie } = await f.submit([adult()], 'assigned-price@example.invalid', plan.id);
    expect(response.status, await response.clone().text()).toBe(200);
    const [home] = await f.joined(), state = await f.rows();
    expect(state.memberships.find(m => m.householdId === home!.id)?.amountCents).toBe(before);
    expect(state.links.find(l => l.householdId === home!.id)?.purpose).toBe(before > 0 ? 'update_card' : 'pay_invoice');
    expect(state.invoices.find(i => i.householdId === home!.id)?.status).toBe(before > 0 ? 'open' : 'paid');
    if (before > 0) await f.pay(cookie);
    expect((await f.rows()).members.find(m => m.householdId === home!.id)?.status).toBe('trial');
  });
});

describe('join admission cleanup', () => {
  it.each([
    ['ordinary day', '2026-10-29T04:05:00Z', '2026-10-31T03:59:59.999Z', '2026-10-31T04:00:00Z'],
    ['fall clock change', '2026-11-01T04:05:00Z', '2026-11-03T04:59:59.999Z', '2026-11-03T05:00:00Z'],
    ['spring clock change', '2026-03-08T05:05:00Z', '2026-03-10T03:59:59.999Z', '2026-03-10T04:00:00Z'],
  ])('preserves the full local submission window across %s', async (_label, admittedAt, graceEnd, expiredAt) => {
    const zone = 'America/New_York', f = await fixture('email', admittedAt, 'CAD', zone), people = [adult()], email = 'grace@example.invalid';
    const accepted = await f.admit(people, email, f.plan.id), abandoned = await f.admit(people, 'expired@example.invalid', f.plan.id);
    f.clock.set(graceEnd!);
    const job = joinJobs.find(j => j.id === 'public.join.cleanup')!;
    await job.handler({}, { gymId: f.gymId, timezone: zone, clock: f.clock, jobId: uuidv7(), attempt: 1 });
    expect((await f.uploads.head(accepted[0]![0]!.signatureImageKey))!.deletedAt).toBeUndefined();
    expect((await f.uploads.head(abandoned[0]![0]!.signatureImageKey))!.deletedAt).toBeUndefined();
    expect((await f.post('/api/public/join', f.body(people, accepted, email, f.plan.id))).status).toBe(200);
    f.clock.set(expiredAt!);
    expect((await f.post('/api/public/join', f.body(people, abandoned, 'expired@example.invalid', f.plan.id))).status).toBe(409);
    expect(await f.join.cleanup.run(f.gymId, zone)).toBe(1);
    expect((await f.uploads.head(abandoned[0]![0]!.signatureImageKey))!.deletedAt).toEqual(f.clock.now());
    expect((await f.rows()).homes.some(h => h.email === email)).toBe(true);
    expect((await f.rows()).homes.some(h => h.email === 'expired@example.invalid')).toBe(false);
  });
  it('rejects invalid signer and guardian details before creating a household, person or image', async () => {
    const f = await fixture(), before = await f.rows(), upload = vi.spyOn(f.waivers, 'uploadSignature');
    for (const [member, signer] of [[child(), { kind: 'self', name: 'Minor' }], [adult(), { kind: 'self', name: 'x'.repeat(201) }],
      [child(), { kind: 'guardian', name: 'Parent', relationship: 'x'.repeat(101) }]] as const) {
      const response = await f.post('/join/signatures', { planId: f.plan.id, contact: { name: 'Payer', email: 'bad@example.invalid' }, honeypot: '',
        members: [{ member, signatures: f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64, signer })) }] });
      expect(response.status).toBe(400);
    }
    const after = await f.rows(); expect(after.homes).toEqual(before.homes); expect(after.members).toEqual(before.members);
    expect(upload).not.toHaveBeenCalled(); expect(await f.uploads.list()).toEqual([]);
  });
  it('compensates a failed image upload, including earlier successful uploads', async () => {
    const f = await fixture(), before = await f.rows(), upload = f.waivers.uploadSignature.bind(f.waivers);
    let calls = 0;
    vi.spyOn(f.waivers, 'uploadSignature').mockImplementation(async (...args) => { if (++calls === 2) throw new Error('storage unavailable'); return upload(...args); });
    await expect(f.join.admit(f.gymId, { planId: f.plan.id, contact: { name: 'Payer', email: 'failed@example.invalid' }, honeypot: '',
      members: [{ member: adult(), signatures: f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64, signer: { kind: 'self', name: 'Avery' } })) }] }, timezone))
      .rejects.toThrow('storage unavailable');
    const after = await f.rows(); expect(after.homes).toEqual(before.homes); expect(after.members).toEqual(before.members);
    expect((await f.uploads.list()).every(image => image.deletedAt !== null)).toBe(true);
  });
  it('daily job deletes only old unsubmitted admissions, scopes the gym, and retries safely', async () => {
    const f = await fixture(), old = await f.admit([adult()], 'old@example.invalid', f.plan.id);
    const oldKey = old[0]![0]!.signatureImageKey;
    const submitted = await f.submit([adult()], 'submitted@example.invalid');
    const paid = await f.submit([adult()], 'paid@example.invalid'); await f.pay(paid.cookie);
    f.clock.set('2026-10-31T06:59:59.999Z');
    expect(await f.join.cleanup.run(f.gymId, timezone)).toBe(0); // The next local calendar day is still valid.
    f.clock.advance(1);
    const fresh = await f.admit([adult()], 'fresh@example.invalid', f.plan.id);
    expect(await f.join.cleanup.run(f.otherGym, timezone)).toBe(0);
    expect(await f.uploads.head(oldKey)).not.toBeNull();
    const job = joinJobs.find(j => j.id === 'public.join.cleanup')!;
    expect(job.cron).toBe('29 3 * * *');
    await job.handler({}, { gymId: f.gymId, timezone, clock: f.clock, jobId: uuidv7(), attempt: 1 });
    const rows = await f.rows();
    expect(rows.homes.some(h => h.email === 'old@example.invalid')).toBe(false);
    expect(rows.homes.some(h => h.email === 'fresh@example.invalid')).toBe(true);
    expect(rows.homes.some(h => h.email === 'submitted@example.invalid')).toBe(true);
    expect(rows.homes.some(h => h.email === 'paid@example.invalid')).toBe(true);
    expect(rows.members.some(m => oldKey.includes('/' + m.id + '/'))).toBe(false);
    expect((await f.uploads.head(oldKey))!.deletedAt).toEqual(f.clock.now());
    expect(await f.uploads.head(fresh[0]![0]!.signatureImageKey)).not.toBeNull();
    expect(await f.join.cleanup.run(f.gymId, timezone)).toBe(0);
    expect((await f.get('/join/return', submitted.cookie)).status).toBe(200);
  });
  it('keeps an abandoned admission whose prospect has a lead row, and still removes one without', async () => {
    const f = await fixture(), kept = await f.admit([adult()], 'lead@example.invalid', f.plan.id);
    const removed = await f.admit([adult()], 'gone@example.invalid', f.plan.id);
    const home = (await f.rows()).homes.find(h => h.email === 'lead@example.invalid')!;
    const prospect = (await f.rows()).members.find(m => m.householdId === home.id)!;
    // Staff logged a contact on the Leads screen: the lead row exists, and the member's revision is unchanged.
    await factory('leads', f.gymId, { memberId: prospect.id });
    f.clock.set('2026-10-31T07:00:00Z');
    const job = joinJobs.find(j => j.id === 'public.join.cleanup')!;
    await job.handler({}, { gymId: f.gymId, timezone, clock: f.clock, jobId: uuidv7(), attempt: 1 });
    const rows = await f.rows();
    expect(rows.homes.some(h => h.email === 'lead@example.invalid')).toBe(true);
    expect(rows.members.some(m => m.id === prospect.id)).toBe(true);
    expect(rows.leads.map(lead => lead.memberId)).toContain(prospect.id);
    expect((await f.uploads.head(kept[0]![0]!.signatureImageKey))!.deletedAt).toBeUndefined();
    expect(rows.homes.some(h => h.email === 'gone@example.invalid')).toBe(false);
    expect((await f.uploads.head(removed[0]![0]!.signatureImageKey))!.deletedAt).toEqual(f.clock.now());
    expect(await f.join.cleanup.run(f.gymId, timezone)).toBe(0);
  });
  it.each(['household edit', 'member edit', 'signed waiver', 'saved card', 'linked login', 'lead', 'active membership'])(
    'retains an admission protected by %s once and excludes it from later cleanup selection', async protection => {
      const f = await fixture(), people = [adult()], email = 'retained@example.invalid', images = await f.admit(people, email, f.plan.id);
      const [home] = await f.joined(), person = (await f.rows()).members.find(m => m.householdId === home!.id)!;
      if (protection === 'household edit')
        await db.forGym(f.gymId, tx => tx.update(households).set({ revision: 2 }).where(eq(households.id, home!.id)));
      else if (protection === 'member edit')
        await db.forGym(f.gymId, tx => tx.update(members).set({ revision: 2 }).where(eq(members.id, person.id)));
      else if (protection === 'signed waiver')
        await f.waivers.sign({ gymId: f.gymId, actor: { kind: 'system' } }, { ...images[0]![0]!, memberId: person.id, consent: true,
          signer: { kind: 'self', name: 'Avery Joiner' } }, { timezone, ipAddress: '127.0.0.1' });
      else if (protection === 'saved card') await factory('paymentMethods', f.gymId, { householdId: home!.id });
      else if (protection === 'linked login') {
        const user = await factory('authUser', f.gymId);
        await factory('householdUsers', f.gymId, { householdId: home!.id, userId: user.id, memberId: person.id, scope: 'payer' });
      }
      else if (protection === 'lead') await factory('leads', f.gymId, { memberId: person.id });
      else await factory('memberships', f.gymId, { householdId: home!.id, memberId: person.id, planId: f.plan.id, status: 'active' });
      f.clock.set('2026-10-31T07:00:00Z');
      const uploadsFor = vi.fn(f.uploadsFor), cleanup = createJoinCleanup({ scope: db.forGym, clock: f.clock, uploadsFor });
      expect(await cleanup.run(f.gymId, timezone)).toBe(0);
      expect(uploadsFor).toHaveBeenCalledTimes(1);
      const kept = await f.rows();
      expect(kept.audits.filter(a => a.action === 'public.join.retained')).toMatchObject([
        { targetType: 'household', targetId: home!.id, actorKind: 'system', occurredAt: f.clock.now() },
      ]);
      uploadsFor.mockClear();
      f.clock.advance(86_400_000);
      expect(await cleanup.run(f.gymId, timezone)).toBe(0);
      expect(uploadsFor).not.toHaveBeenCalled();
      // Direct compensation checks the same durable marker, so it cannot later delete an adopted admission either.
      expect(await cleanup.remove(f.gymId, home!.id)).toBe(false);
      const retried = await f.rows();
      expect(retried.homes).toEqual(kept.homes); expect(retried.members).toEqual(kept.members);
      expect(retried.audits.filter(a => a.action === 'public.join.retained')).toEqual(kept.audits.filter(a => a.action === 'public.join.retained'));
      expect((await f.uploads.head(images[0]![0]!.signatureImageKey))!.deletedAt).toBeUndefined();
    });
  it('keeps the durable cleanup claim after a storage failure and rejects a racing submission', async () => {
    const f = await fixture(), people = [adult()], email = 'retry@example.invalid', images = await f.admit(people, email, f.plan.id);
    f.clock.set('2026-10-31T07:00:00Z');
    vi.spyOn(f.uploads, 'markDeleted').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.join.cleanup.run(f.gymId, timezone)).rejects.toThrow('storage unavailable');
    const response = await f.post('/api/public/join', f.body(people, images, email, f.plan.id));
    expect(response.status).toBe(404);
    expect(await f.join.cleanup.run(f.gymId, timezone)).toBe(1);
    expect((await f.uploads.list()).every(image => image.deletedAt !== null)).toBe(true);
  });
  it('cleans the remaining admissions when one household fails, then fails the run so it retries', async () => {
    const f = await fixture(), first = await f.admit([adult()], 'first@example.invalid', f.plan.id);
    const second = await f.admit([adult()], 'second@example.invalid', f.plan.id);
    f.clock.set('2026-10-31T07:00:00Z');
    vi.spyOn(f.uploads, 'markDeleted').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.join.cleanup.run(f.gymId, timezone)).rejects.toThrow('storage unavailable');
    expect((await f.uploads.head(first[0]![0]!.signatureImageKey))!.deletedAt).toBeUndefined();
    expect((await f.uploads.head(second[0]![0]!.signatureImageKey))!.deletedAt).toEqual(f.clock.now());
    expect(await f.join.cleanup.run(f.gymId, timezone)).toBe(1);
    expect((await f.uploads.list()).every(image => image.deletedAt !== null)).toBe(true);
  });
});
it('shows manual payment for a newly issued first invoice below the card minimum', async () => {
  const f = await fixture(), smallPlan = await factory('plans', f.gymId, { amountCents: 32, signupFeeCents: 0, trialDays: 0 });
  const create = vi.spyOn(f.provider, 'createCheckout'), { cookie } = await f.submit([adult()], 'small@example.invalid', smallPlan.id);
  const [home] = await f.joined(), bill = (await f.rows()).invoices.find(row => row.householdId === home!.id)!;
  expect(bill.amountCents).toBe(32);
  const page = await f.get('/join/checkout', cookie);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('Contact the gym to arrange a manual payment');
  expect(create).not.toHaveBeenCalled();
});
it.each([[32, 'CAD'], [1255, 'KWD']] as const)('keeps a join of %s %s pending for manual payment without Checkout', async (amountCents, currency) => {
  const f = await fixture('email', undefined, currency), { cookie } = await f.submit(), create = vi.spyOn(f.provider, 'createCheckout');
  const [home] = await f.joined(), bill = (await f.rows()).invoices.find(row => row.householdId === home!.id)!;
  await db.forGym(f.gymId, tx => tx.update(invoices).set({ amountCents }).where(eq(invoices.id, bill.id)));
  for (const path of ['/join/checkout', '/join/return', '/join/cancelled']) {
    const response = await f.get(path, cookie), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('Contact the gym to arrange a manual payment');
    expect(html).not.toContain('href="/join/checkout"');
    expect(html).not.toContain('data-join-confirming');
  }
  expect(create).not.toHaveBeenCalled();
  expect((await f.rows()).memberships.filter(row => row.householdId === home!.id).every(row => row.status === 'pending')).toBe(true);
  // A payment already being processed must keep confirming, rather than invite another payment.
  await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'processing' }).where(eq(invoices.id, bill.id)));
  expect(await (await f.get('/join/return', cookie)).text()).toContain('Confirming your payment');
  await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'open' }).where(eq(invoices.id, bill.id)));
  // The ordinary paid-invoice effect activates the same saved join after staff collect it.
  await f.transitions.manualPayment({ gymId: f.gymId, actor: { kind: 'system' } }, { invoiceId: bill.id, paymentId: uuidv7(), method: 'cash',
    amountCents, currency, paidAt: f.clock.now().toISOString() });
  await f.drain();
  expect((await f.rows()).memberships.filter(row => row.householdId === home!.id).every(row => row.status === 'active')).toBe(true);
});
const cookieValue = (cookie: string) => decodeURIComponent(cookie.slice(joinCookie.length + 1));
/** A valid signature PNG of incompressible pixels, close to the 256 KB cap, like a chosen photo of a signature. */
function noisePng(width = 290, height = 290) {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const raw = randomBytes((1 + width * 3) * height);
  for (let row = 0; row < raw.length; row += 1 + width * 3) raw[row] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** The native multipart form, as posted without JavaScript: one adult and a PNG file for each current document. */
function nativeForm(f: Fixture, planId: string, email: string) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ planId, members: '1', contactName: 'Pat Payer', email, honeypot: '',
    'member-0-firstName': 'Avery', 'member-0-lastName': 'Native', 'member-0-dateOfBirth': '1990-01-02' })) form.set(name, value);
  f.templates.forEach((t, j) => {
    const prefix = 'waiver-0-' + j;
    for (const [name, value] of Object.entries({ template: t.id, version: String(t.version), kind: 'self', name: 'Avery Native', consent: 'on' })) form.set(prefix + '-' + name, value);
    form.set(prefix + '-image', new File([png], 'signature.png', { type: 'image/png' }));
  });
  return form;
}

describe('public join pages through the production registrations', () => {
  it('shows a zero-decimal gym\'s plan prices in whole yen, in the page and the API', async () => {
    const f = await fixture(), yenGym = uuidv7();
    await factory('gyms', yenGym, { name: 'Tokyo Gym', currency: 'JPY', timezone, billingEnabled: true });
    await factory('plans', yenGym, { name: 'Monthly yen', amountCents: 12000, currency: 'JPY', interval: 'monthly', signupFeeCents: 5500 });
    await factory('plans', yenGym, { name: 'Annual yen', amountCents: 120000, currency: 'JPY', interval: 'annual' });
    for (const name of ['Conduct', 'Participation']) await factory('waiverTemplates', yenGym, { name, body: 'Terms.' });
    f.paymentsConfigured.mockResolvedValue(true);
    const html = await (await f.get('/join', '', f.app(yenGym))).text();
    expect(html).toContain('¥12,000 per month'); expect(html).toMatch(/Sign-up fee: [A-Z]*¥5,500/); expect(html).toContain('¥120,000 per year');
    expect(html).not.toMatch(/¥120(?![,\d])|¥55(?![,\d])|¥1,200(?![,\d])/);
    const api = publicContracts.plans.response.parse(await (await f.get('/api/public/plans?limit=100&offset=0', '', f.app(yenGym))).json());
    expect(api.data.map(p => [p.name, p.amountCents, p.currency])).toEqual([['Annual yen', 120000, 'JPY'], ['Monthly yen', 12000, 'JPY']]);
  });
  it('lists eligible paid, trial and free plans, renders with the website off, and projects nothing from another gym', async () => {
    const f = await fixture(), list = await f.get('/join'), html = await list.text();
    expect(list.status).toBe(200); expect(html).toContain('North &lt;Gym&gt;'); expect(html).toContain('href="/source"');
    expect(html).toContain('Adult monthly'); expect(html).toContain('Annual'); expect(html).toContain('$150.00\u00a0+\u00a0tax per month'); expect(html).toMatch(/Sign-up fee: [A-Z]*\$50\.00\u00a0\+\u00a0tax/);
    expect(html).toContain('Trial plan'); expect(html).toContain('Free plan'); expect(html).toContain('href="/join"');
    for (const hidden of ['Retired plan', 'Private other plan', 'Private']) expect(html).not.toContain(hidden);
    expect(list.headers.get('content-security-policy')).toContain("form-action 'self'"); expect(list.headers.get('cache-control')).toBe('no-store');
    expect(list.headers.get('content-security-policy')).toMatch(/; report-uri \/csp-report; report-to csp$/);
    expect(list.headers.get('reporting-endpoints')).toBe('csp="/csp-report"');
    const form = await (await f.get(`/join?plan=${f.plan.id}&members=2`)).text();
    expect(form.match(/data-member=/g)).toHaveLength(2); expect(form.match(/data-waiver/g)).toHaveLength(4);
    expect(form).toContain('&lt;script&gt;bad()&lt;/script&gt;'); expect(form).not.toContain('<script>bad()'); expect(form).toContain('src="/join/client.js"');
    expect(form).toContain('enctype="multipart/form-data"');
    for (const path of [`/join?plan=${f.foreignPlan.id}`, '/join?plan=not-an-id&members=99']) expect(await (await f.get(path)).text()).not.toContain('data-join-form');
    expect(await (await f.get(`/join?plan=${f.trial.id}`)).text()).toContain('First 7 days free');
    expect(await (await f.get(`/join?plan=${f.plan.id}&members=99`)).text()).toMatch(/data-member="5"/);
    const api = publicContracts.plans.response.parse(await (await f.get('/api/public/plans?limit=1&offset=0')).json());
    expect(api).toMatchObject({ data: [{ id: f.plan.id, signupFeeCents: 5000, trialDays: 0 }], pagination: { limit: 1, offset: 0, total: 4 } });
    const other = f.app(f.otherGym);
    for (const path of ['/join', `/join?plan=${f.plan.id}`, '/api/public/plans']) {
      const text = await (await f.get(path, '', other)).text();
      expect(text).not.toContain('North'); expect(text).not.toContain('Adult monthly'); expect(text).not.toContain(f.plan.id);
    }
    expect((await f.get('/join/client.js')).headers.get('content-type')).toContain('text/javascript');
    f.paymentsConfigured.mockResolvedValue(false);
    expect(await (await f.get('/join')).text()).toContain('Online joining is not available right now');
  });

  it('says "+ tax" beside a plan price and sign-up fee only when invoicing adds tax on top, with this gym\'s rates alone', async () => {
    const f = await fixture(), noteFor = (html: string, name: string) => {
      const item = html.split('<li').find(part => part.includes(`>${name}</h2>`)) ?? '';
      return { month: item.match(/\$[\d,.]+(\u00a0\+\u00a0tax)? per month/)?.[0], fee: item.match(/Sign-up fee: [A-Z]*\$[\d,.]+(\u00a0\+\u00a0tax)?/)?.[0] };
    };
    const tax = (name: string, rateMillionths: number, inclusive: boolean, active = true) => factory('taxRates', f.gymId, { name, rateMillionths, inclusive, active });
    const planWith = async (name: string, rates: { id: string }[]) => {
      const row = await factory('plans', f.gymId, { name, amountCents: 8000, currency: 'CAD', interval: 'monthly', signupFeeCents: 2000 });
      for (const rate of rates) await factory('planTaxRates', f.gymId, { planId: row.id, taxRateId: rate.id });
      return row;
    };
    const inclusive = await tax('QST included', 99_750, true), exclusive = await tax('PST', 70_000, false);
    await planWith('Plain', []);
    await planWith('Inclusive only', [inclusive]);
    const both = await planWith('Both rates', [inclusive, exclusive]);
    // Invoicing reads every attached rate, archived or not, so an archived exclusive rate still adds tax.
    await planWith('Archived exclusive', [await tax('Old PST', 70_000, false, false)]);
    // A zero rate adds nothing to the invoice, so the page has nothing to announce.
    await planWith('Zero rate', [await tax('Zero', 0, false)]);
    await factory('plans', f.otherGym, { name: 'Plain', amountCents: 8000, currency: 'CAD', signupFeeCents: 2000 });
    const html = await (await f.get('/join')).text();
    const plus = '\u00a0+\u00a0tax';
    expect(noteFor(html, 'Plain')).toEqual({ month: '$80.00 per month', fee: expect.stringMatching(/^Sign-up fee: [A-Z]*\$20\.00$/) });
    expect(noteFor(html, 'Inclusive only').month).toBe('$80.00 per month');
    expect(noteFor(html, 'Inclusive only').fee).not.toContain('tax');
    expect(noteFor(html, 'Both rates').month).toBe(`$80.00${plus} per month`);
    expect(noteFor(html, 'Both rates').fee).toMatch(/\$20\.00\u00a0\+\u00a0tax$/);
    expect(noteFor(html, 'Archived exclusive').month).toBe(`$80.00${plus} per month`);
    expect(noteFor(html, 'Zero rate').month).toBe('$80.00 per month');
    expect(noteFor(html, 'Annual').month).toBeUndefined();
    expect(html).toContain('$1,500.00 per year'); expect(html).not.toContain('$1,500.00' + plus);
    // An annual plan with an exclusive rate reads "per year", with the note beside the price, and renders no raw key.
    const annualTaxed = await factory('plans', f.gymId, { name: 'Annual taxed', amountCents: 120000, currency: 'CAD', interval: 'annual', signupFeeCents: 3000 });
    await factory('planTaxRates', f.gymId, { planId: annualTaxed.id, taxRateId: exclusive.id });
    for (const page of [await (await f.get('/join')).text(), await (await f.get(`/join?plan=${annualTaxed.id}`)).text()]) {
      expect(page).toContain(`$1,200.00${plus} per year`); expect(page).toMatch(/Sign-up fee: [A-Z]*\$30\.00/); expect(page).toContain('$30.00' + plus);
      expect(page).not.toMatch(/annualPlusTax|signupFeePlusTax|public\/join:/);
    }
    // The form's summary and the API carry the same flag.
    const form = await (await f.get(`/join?plan=${both.id}`)).text();
    expect(form).toContain(`$80.00${plus} per month`); expect(form).toMatch(/Sign-up fee: [A-Z]*\$20\.00\u00a0\+\u00a0tax/);
    const api = publicContracts.plans.response.parse(await (await f.get('/api/public/plans?limit=100&offset=0')).json());
    expect(Object.fromEntries(api.data.map(p => [p.name, p.plusTax]))).toEqual({ 'Adult monthly': true, Annual: false, 'Annual taxed': true, Plain: false,
      'Inclusive only': false, 'Both rates': true, 'Archived exclusive': true, 'Zero rate': false, 'Free plan': false, 'Trial plan': false });
    // The other gym's exclusive rate on its own plan leaves this gym's plain plan alone, and shows only on its page.
    const foreignRate = await factory('taxRates', f.otherGym, { name: 'Other GST', rateMillionths: 50_000, inclusive: false });
    const [foreign] = await db.forGym(f.otherGym, tx => tx.select().from(plans).where(eq(plans.name, 'Plain')));
    await factory('planTaxRates', f.otherGym, { planId: foreign!.id, taxRateId: foreignRate.id });
    expect(noteFor(await (await f.get('/join')).text(), 'Plain').month).toBe('$80.00 per month');
    const otherApi = publicContracts.plans.response.parse(await (await f.get('/api/public/plans', '', f.app(f.otherGym))).json());
    expect(Object.fromEntries(otherApi.data.map(p => [p.name, p.plusTax]))).toEqual({ Plain: true, 'Private other plan': false });
  });

  it.each([false, true])('activates a family only through paid Checkout with immutable waivers (PDF: %s)', async pdfTemplate => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCheckout');
    if (pdfTemplate) {
      const document = await f.waivers.uploadDocument({ gymId: f.gymId, actor: { kind: 'system' } }, await waiverDocumentFixture());
      await db.forGym(f.gymId, tx => tx.update(waiverTemplates).set({ body: '', documentKey: document.key, documentHash: document.hash, documentPages: document.pages, documentBytes: document.bytes }).where(eq(waiverTemplates.id, f.templates[0]!.id)));
      expect(await (await f.get('/join?plan=' + f.plan.id)).text()).toContain('Open the document');
    }
    const { response, cookie } = await f.submit([adult(), child()]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(publicSubmissionResponseSchema.parse(await response.json())).toEqual({ data: { status: 'received' } });
    const header = response.headers.get('set-cookie')!;
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/join', 'Max-Age=7200']) expect(header).toContain(part);
    const [, payload] = cookieValue(cookie).split('.');
    expect(Object.keys(JSON.parse(Buffer.from(payload!, 'base64url').toString()))).toEqual(['g', 'l', 'x']);
    expect(header).not.toContain('payer'); expect(header).not.toContain('@');
    let state = await f.rows();
    const [home] = await f.joined();
    expect(home).toMatchObject({ email: 'payer@example.invalid', billingDay: 29, stripeCustomerId: null });
    const people = state.members.filter(m => m.householdId === home!.id);
    expect(people.map(m => m.status)).toEqual(['prospect', 'prospect']);
    expect(state.signatures.filter(s => people.some(m => m.id === s.memberId))).toHaveLength(4);
    expect(state.memberships.filter(m => m.householdId === home!.id).map(m => [m.status, m.startsOn, m.nextDueOn])).toEqual([
      ['pending', '2026-10-29', '2026-11-29'], ['pending', '2026-10-29', '2026-11-29']]);
    const bill = state.invoices.find(i => i.householdId === home!.id)!;
    // Two first periods (2 x $150) and sign-up fees (2 x $50), each with 5% GST, as one invoice.
    expect(bill).toMatchObject({ kind: 'cycle', status: 'open', amountCents: 42000, dueOn: '2026-10-29', periodStartsOn: '2026-10-29', periodEndsOn: '2026-11-29' });
    expect(state.lines.filter(l => l.invoiceId === bill.id).map(l => l.kind).sort()).toEqual(['membership', 'membership', 'signup_fee', 'signup_fee', 'tax', 'tax', 'tax', 'tax']);
    expect(JSON.stringify(state.audits.filter(a => a.action.startsWith('public.join')))).not.toMatch(/payer@|Avery|Pat Payer/);

    for (const path of ['/join/return', '/join/cancelled']) expect(await (await f.get(path, cookie)).text()).not.toContain('Welcome');
    const confirming = await f.get('/join/return', cookie);
    expect(confirming.headers.get('refresh')).toBeNull();
    const progress = await confirming.text();
    expect(progress).toMatch(/<head>[\s\S]*<noscript><meta http-equiv="refresh" content="5"\/?><\/noscript>[\s\S]*<\/head>/);
    expect(progress).toContain('Confirming your payment'); expect(progress).toContain('If this page does not change, select Check again'); expect(progress).not.toContain('updates automatically');
    expect(progress).toContain('Waiting for your payment to be confirmed'); expect(progress).toContain('aria-live="polite"');
    // The poll is one external script that /join/return itself serves state to: no inline script, no new route, and the no-JS link stays.
    expect(progress).toContain('data-join-confirming'); expect(progress).toContain('src="/join/client.js"'); expect(progress).toContain('href="/join/return"');
    expect(progress).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(confirming.headers.get('content-security-policy')).toContain("script-src 'self'");
    // The stalled message and its hidden state are in the page for the script to reveal after its limit.
    expect(progress).toContain('This is taking longer than usual');
    // The poll is anonymous-safe: with no join cookie it reads nothing, and the answer carries no confirming marker.
    const noCookie = await f.get('/join/return');
    expect(await noCookie.text()).not.toContain('data-join-confirming'); expect(noCookie.headers.get('refresh')).toBeNull();
    expect(await (await f.get('/join/cancelled', cookie)).text()).toContain('Nothing was charged');
    const redirect = await f.get('/join/checkout', cookie);
    expect(redirect.status).toBe(303);
    expect(create.mock.calls[0]![0]).toMatchObject({ mode: 'payment', amount: 42000, currency: 'cad', saveForOffSession: true,
      successUrl: origin + '/join/return', cancelUrl: origin + '/join/cancelled', expiresAt: new Date('2026-10-29T19:00:00Z') });
    const sessionId = new URL(redirect.headers.get('location')!).pathname.slice(1);
    expect((await f.get('/join/checkout', cookie)).headers.get('location')).toContain(sessionId);
    f.provider.completeCheckout(sessionId);
    // A completed Checkout alone, and any browser return, grants nothing until the webhook records it.
    expect(await (await f.get('/join/return', cookie)).text()).toContain('Confirming your payment');
    state = await f.rows();
    expect(state.members.filter(m => m.householdId === home!.id).every(m => m.status === 'prospect')).toBe(true);
    expect(state.memberships.filter(m => m.householdId === home!.id).every(m => m.status === 'pending')).toBe(true);
    await f.webhook(sessionId);
    await f.webhook(sessionId);
    state = await f.rows();
    expect(state.invoices.find(i => i.id === bill.id)!.status).toBe('paid');
    expect(state.members.filter(m => m.householdId === home!.id).map(m => [m.status, m.revision])).toEqual([['active', 2], ['active', 2]]);
    expect(state.memberships.filter(m => m.householdId === home!.id).map(m => [m.status, m.nextDueOn])).toEqual([['active', '2026-11-29'], ['active', '2026-11-29']]);
    expect(state.links.find(l => l.invoiceId === bill.id)!.usedAt).not.toBeNull();
    expect(state.methods).toMatchObject([{ householdId: home!.id, isDefault: true }]);
    expect(state.audits.filter(a => a.action === 'public.join.completed')).toHaveLength(1);
    expect(f.sent).toHaveLength(1); expect(f.sent[0]).toMatchObject({ gymId: f.gymId, email: 'payer@example.invalid' });
    expect(state.logins).toEqual([]);
    const welcome = await (await f.get('/join/return', cookie)).text();
    expect(welcome).toContain('We sent a sign-in link'); expect(welcome).not.toContain('payer@example.invalid');
    // Once settled, the same URL no longer carries the marker, which is what ends the script's polling.
    expect(welcome).not.toContain('data-join-confirming');
    expect(await (await f.post('/join/sign-in', undefined, cookie)).text()).toContain('Use the newest email');
    expect(f.sent).toHaveLength(2);
    expect((await f.get('/join/checkout', cookie)).headers.get('location')).toBe('/join/return');

    // The address owner signs in through the link; the claim grants only that user, then the portal opens on this household.
    const user = (await f.accounts.findUserByEmail('payer@example.invalid'))!;
    const stranger = await factory('authUser', f.gymId);
    await expect(f.invitations.completeClaim(f.gymId, stranger.id, { claim: f.sent[1]!.claim }, f.clock)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.invitations.completeClaim(f.gymId, user.id, { claim: f.sent[0]!.claim }, f.clock)).rejects.toMatchObject({ code: 'not_found' });
    expect(await f.invitations.completeClaim(f.gymId, user.id, { claim: f.sent[1]!.claim }, f.clock)).toBe(home!.id);
    expect(await createPortalPrincipalLoader(db.forGym)(f.gymId, user.id)).toEqual({ kind: 'member', userId: user.id, scope: { gymId: f.gymId, householdId: home!.id, role: 'payer' } });
    const visible = await db.forHousehold({ kind: 'user', gymId: f.gymId, householdId: home!.id, userId: user.id }, q => q.members());
    expect(visible.map(m => m.firstName).sort()).toEqual(['Avery', 'Kai']);
    await expect(db.forHousehold({ kind: 'user', gymId: f.gymId, householdId: f.existingHome.id, userId: user.id }, q => q.members())).rejects.toThrow();

    // The next cycle is the join-date anniversary, charged off-session to the saved card without the sign-up fee.
    f.clock.set('2026-11-29T18:00:00Z');
    const runner = createChargeRunner({ scope: db.forGym, clock: f.clock, transitions: f.transitions, settings: f.settings, jobs: f.jobs, payments: f.paymentsFor });
    expect((await runner.daily(f.gymId)).errors).toEqual([]);
    const next = (await f.rows()).invoices.filter(i => i.householdId === home!.id && i.id !== bill.id);
    expect(next).toMatchObject([{ kind: 'cycle', status: 'paid', amountCents: 31500, periodStartsOn: '2026-11-29', periodEndsOn: '2026-12-29' }]);
  });

  it('leaves no active membership when Checkout is abandoned, cancelled or expires, and recovers with a new session', async () => {
    const f = await fixture(), { cookie } = await f.submit();
    const quiet = async () => {
      const state = await f.rows(), [home] = await f.joined();
      expect(state.members.filter(m => m.householdId === home!.id).map(m => m.status)).toEqual(['prospect']);
      expect(state.memberships.filter(m => m.householdId === home!.id).map(m => m.status)).toEqual(['pending']);
      expect(state.logins).toEqual([]); expect(f.sent).toEqual([]);
      return { state, home: home! };
    };
    const first = new URL((await f.get('/join/checkout', cookie)).headers.get('location')!).pathname.slice(1);
    expect(await (await f.get('/join/cancelled', cookie)).text()).toContain('Payment not completed');
    await quiet();
    f.clock.set('2026-10-29T19:00:00Z');
    expect(() => f.provider.completeCheckout(first)).toThrow('expired');
    expect((await f.provider.readPaymentObject({ kind: 'checkout', id: first })).status).toBe('found');
    await quiet();
    const second = new URL((await f.get('/join/checkout', cookie)).headers.get('location')!).pathname.slice(1);
    expect(second).not.toBe(first);
    // Never paid: the daily runner neither activates nor charges it, and holds the stale invoice for review.
    f.clock.set('2026-11-06T18:00:00Z');
    const runner = createChargeRunner({ scope: db.forGym, clock: f.clock, transitions: f.transitions, settings: f.settings, jobs: f.jobs, payments: f.paymentsFor });
    expect((await runner.daily(f.gymId)).attempted).toBe(0);
    const { state, home } = await quiet();
    expect(state.invoices.find(i => i.householdId === home.id)).toMatchObject({ status: 'open', needsReview: true });
    expect(f.afterCheckout).not.toHaveBeenCalled();
  });

  it('gives new, existing and staff addresses the same response and never edits an existing household', async () => {
    const f = await fixture(), staff = await factory('authUser', f.gymId, { email: 'coach@example.invalid' });
    await factory('staffRoles', f.gymId, { userId: staff.id, role: 'coach' });
    const responses = [];
    for (const email of ['fresh@example.invalid', 'existing@example.invalid', 'coach@example.invalid']) responses.push((await f.submit([adult()], email)).response);
    const bodies = await Promise.all(responses.map(r => r.json()));
    expect(new Set(responses.map(r => r.status))).toEqual(new Set([200]));
    expect(bodies.every(b => JSON.stringify(b) === JSON.stringify(bodies[0]))).toBe(true);
    for (const name of ['content-type', 'cache-control', 'content-security-policy']) expect(new Set(responses.map(r => r.headers.get(name))).size).toBe(1);
    const state = await f.rows();
    expect(state.homes.find(h => h.id === f.existingHome.id)).toMatchObject({ name: 'Existing household', revision: 1 });
    expect(state.members.find(m => m.id === f.existing.id)).toMatchObject({ status: 'active', revision: 1 });
    expect(await f.joined()).toHaveLength(3);
    expect(JSON.stringify(state.audits.filter(a => a.action.startsWith('public.join')))).not.toContain('@example.invalid');
  });

  it('rejects bots, unavailable billing and stale documents before creating any household or Checkout session', async () => {
    const f = await fixture(), before = (await f.rows()).homes.length, create = vi.spyOn(f.provider, 'createCheckout');
    const signatures = f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64, signer: { kind: 'self', name: 'Visitor' } }));
    const admission = (changes: Record<string, unknown> = {}) => ({ planId: f.plan.id, contact: { name: 'Bot', email: 'bot@example.invalid' }, honeypot: '',
      members: [{ member: adult(), signatures }], ...changes });
    expect((await f.post('/join/signatures', admission({ honeypot: 'spam' }))).status).toBe(400);
    expect((await f.post('/api/public/join', { ...admission({ honeypot: 'spam' }), members: [] })).status).toBe(400);
    expect((await f.post('/join/signatures', admission({ planId: f.retired.id }))).status).toBe(404);
    expect((await f.post('/join/signatures', admission({ planId: f.foreignPlan.id }))).status).toBe(404);
    expect((await f.post('/join/signatures', admission({ members: [{ member: adult(), signatures: [signatures[0]] }] }))).status).toBe(409);
    expect((await f.post('/join/signatures', admission({ members: [{ member: adult(), signatures: [signatures[0],
      { templateId: f.foreignTemplate.id, templateVersion: 1, pngBase64, signer: { kind: 'self', name: 'Visitor' } }] }] }))).status).toBe(409);
    expect((await f.post('/join/signatures', admission({ members: Array.from({ length: 7 }, () => ({ member: adult(), signatures })) }))).status).toBe(400);
    f.paymentsConfigured.mockResolvedValueOnce(false);
    expect((await f.post('/join/signatures', admission())).status).toBe(503);
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ billingEnabled: false }).where(eq(gyms.id, f.gymId)));
    expect((await f.post('/join/signatures', admission())).status).toBe(503);
    expect((await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: nativeForm(f, f.plan.id, 'bot@example.invalid') }))).status).toBe(503);
    expect((await f.rows()).homes).toHaveLength(before); expect(create).not.toHaveBeenCalled();
  });

  it('isolates the join to its own gym and newly admitted household', async () => {
    const f = await fixture(), { cookie, images } = await f.submit();
    const other = f.app(f.otherGym);
    const missing = 'This browser no longer has your sign-up';
    const elsewhere = await f.get('/join/checkout', cookie, other);
    expect(elsewhere.status).toBe(200); expect(elsewhere.headers.get('location')).toBeNull(); expect(await elsewhere.text()).toContain(missing);
    expect(await (await f.get('/join/return', cookie, other)).text()).toContain('This browser no longer has your sign-up');
    const [version, payload, signature] = cookieValue(cookie).split('.');
    const forged = joinCookie + '=' + [version, Buffer.from(JSON.stringify({ g: f.gymId, l: uuidv7(), x: Date.parse('2030-01-01') })).toString('base64url'), signature].join('.');
    expect(await (await f.get('/join/checkout', forged)).text()).toContain(missing);
    expect(await (await f.get('/join/return', joinCookie + '=' + [version, payload, 'A'.repeat(43)].join('.'))).text()).toContain(missing);
    // Another visitor's private image keys cannot sign or enroll under different contact details.
    const stolen = f.body([adult()], images, 'thief@example.invalid', f.plan.id);
    expect((await f.post('/api/public/join', stolen)).status).toBe(404);
    // A staff-uploaded image for an enrolled member cannot enroll that member.
    const staffImage = await f.waivers.uploadSignature({ gymId: f.gymId, actor: { kind: 'system' } }, f.existing.id, png);
    const enrolled = { planId: f.plan.id, contact: { name: 'Existing household', email: 'existing@example.invalid' }, honeypot: '',
      members: [{ member: { firstName: 'Private', lastName: f.existing.lastName, dateOfBirth: f.existing.dateOfBirth ?? '1990-01-02' },
        waivers: f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, ...staffImage, consent: true, signer: { kind: 'self', name: 'Private' } })) }] };
    expect((await f.post('/api/public/join', enrolled)).status).toBe(404);
    const state = await f.rows();
    expect(state.memberships.filter(m => m.householdId === f.existingHome.id)).toEqual([]);
    expect(state.signatures.filter(s => s.memberId === f.existing.id)).toEqual([]);
    // Replays and concurrent retries converge on one join, one invoice and one pay link.
    const original = f.body([adult()], images, 'payer@example.invalid', f.plan.id);
    const replays = await Promise.all([f.post('/api/public/join', original), f.post('/api/public/join', original)]);
    expect(replays.map(r => r.status)).toEqual([200, 200]);
    const [home] = await f.joined(), after = await f.rows();
    expect(after.invoices.filter(i => i.householdId === home!.id)).toHaveLength(1);
    expect(after.links.filter(l => l.householdId === home!.id && !l.revokedAt)).toHaveLength(1);
    expect(after.audits.filter(a => a.action === 'public.join.received')).toHaveLength(1);
    // An ordinary pay link for an enrolled household is not a join: the hook leaves it alone.
    const bill = await factory('invoices', f.gymId, { householdId: f.existingHome.id, number: 99, status: 'paid' });
    const link = await createSignedLinksService({ scope: db.forGym, clock: f.clock }).create({ gymId: f.gymId, actor: { kind: 'system' } },
      { purpose: 'pay_invoice', householdId: f.existingHome.id, invoiceId: bill.id, expiresAt: '2026-11-29T00:00:00Z' });
    await f.join.afterCheckout(f.gymId, link.link.id);
    expect((await f.rows()).audits.filter(a => a.action === 'public.join.completed')).toEqual([]);
  });

  it('requires a guardian for minors and accepts the native multipart form without JavaScript', async () => {
    const f = await fixture(), images = await f.admit([child()], 'family@example.invalid', f.plan.id);
    const minor = { planId: f.plan.id, contact: { name: 'Pat Payer', email: 'family@example.invalid' }, honeypot: '',
      members: [{ member: child(), waivers: images[0]!.map(image => ({ ...image, consent: true, signer: { kind: 'self', name: 'Kai Joiner' } })) }] };
    expect((await f.post('/api/public/join', minor)).status).toBe(400);
    const family = (await f.joined()).find(h => h.email === 'family@example.invalid')!, before = await f.rows();
    expect(before.signatures.filter(s => before.members.some(m => m.id === s.memberId && m.householdId === family.id))).toEqual([]);
    expect(before.memberships.filter(m => m.householdId === family.id)).toEqual([]);
    const form = nativeForm(f, f.annual.id, 'native@example.invalid');
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    expect(response.status).toBe(200); expect(await response.text()).toContain('href="/join/checkout"');
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    await f.pay(cookie);
    const home = (await f.joined()).find(h => h.email === 'native@example.invalid')!, state = await f.rows();
    expect(state.memberships.filter(m => m.householdId === home.id).map(m => [m.status, m.nextDueOn, m.anniversaryOn])).toEqual([['active', '2027-10-29', '2026-10-29']]);
    form.set('honeypot', 'spam');
    expect((await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }))).status).toBe(400);
    const huge = new FormData(); huge.set('members', '1'); huge.set('padding', 'x'.repeat(1024 * 1024 + 1));
    expect((await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: huge }))).status).toBe(400);
  });

  it('keeps the admission date across midnight and refuses an admission older than a day', async () => {
    // 23:59 on October 29 in Vancouver; the submission arrives two minutes later, on October 30.
    const f = await fixture('email', '2026-10-30T06:59:00Z'), images = await f.admit([adult()], 'late@example.invalid', f.plan.id);
    f.clock.set('2026-10-30T07:01:00Z');
    expect((await f.post('/api/public/join', f.body([adult()], images, 'late@example.invalid', f.plan.id))).status).toBe(200);
    const home = (await f.joined()).find(h => h.email === 'late@example.invalid')!, state = await f.rows();
    expect(home.billingDay).toBe(29);
    expect(state.memberships.filter(m => m.householdId === home.id).map(m => [m.startsOn, m.nextDueOn])).toEqual([['2026-10-29', '2026-11-29']]);
    expect(state.invoices.find(i => i.householdId === home.id)).toMatchObject({ dueOn: '2026-10-29', periodEndsOn: '2026-11-29' });
    const stale = await f.admit([adult('Stale')], 'stale@example.invalid', f.plan.id);
    f.clock.set('2026-11-01T18:00:00Z');
    expect((await f.post('/api/public/join', f.body([adult('Stale')], stale, 'stale@example.invalid', f.plan.id))).status).toBe(409);
    expect((await f.post('/api/public/join', f.body([adult()], images, 'late@example.invalid', f.plan.id))).status).toBe(200);
  });

  it('completes the join when its invoice is paid through another link of the household', async () => {
    const f = await fixture(), { cookie } = await f.submit();
    const [home] = await f.joined(), bill = (await f.rows()).invoices.find(i => i.householdId === home!.id)!;
    const staff = await createSignedLinksService({ scope: db.forGym, clock: f.clock }).create({ gymId: f.gymId, actor: { kind: 'system' } },
      { purpose: 'pay_invoice', householdId: home!.id, invoiceId: bill.id, expiresAt: '2026-11-05T00:00:00Z' });
    const opened = await f.checkout.start(f.gymId, staff.link.id);
    f.provider.completeCheckout(opened.session.id);
    await f.webhook(opened.session.id);
    expect((await f.rows()).members.filter(m => m.householdId === home!.id).map(m => m.status)).toEqual(['active']);
    expect(f.afterCheckout).toHaveBeenCalledWith(f.gymId, staff.link.id, opened.session.id);
    expect(f.afterInvoicePaid).toHaveBeenCalledWith(f.gymId, bill.id);
    expect(await (await f.get('/join/return', cookie)).text()).toContain('We sent a sign-in link');
    expect((await f.rows()).audits.filter(a => a.action === 'public.join.completed')).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
  });

  it('completes a join paid by cash or check through the paid-invoice effect, once alongside the Checkout hook', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult(), child()]);
    const [home] = await f.joined(), bill = (await f.rows()).invoices.find(i => i.householdId === home!.id)!;
    const staff = await factory('authUser', f.gymId), context = { gymId: f.gymId, actor: { kind: 'user' as const, userId: staff.id } };
    const cash = { invoiceId: bill.id, paymentId: uuidv7(), method: 'cash' as const, amountCents: bill.amountCents, currency: 'CAD' as const, paidAt: f.clock.now().toISOString() };
    await f.transitions.manualPayment(context, cash);
    // Recorded but not yet processed: nothing is active and the return page keeps confirming.
    expect(await (await f.get('/join/return', cookie)).text()).toContain('Confirming your payment');
    await f.drain();
    let state = await f.rows();
    expect(state.invoices.find(i => i.id === bill.id)!.status).toBe('paid');
    expect(state.members.filter(m => m.householdId === home!.id).map(m => m.status)).toEqual(['active', 'active']);
    expect(state.memberships.filter(m => m.householdId === home!.id).map(m => m.status)).toEqual(['active', 'active']);
    expect(f.afterCheckout).not.toHaveBeenCalled();
    expect(f.sent).toEqual([expect.objectContaining({ gymId: f.gymId, email: 'payer@example.invalid' })]);
    expect(await (await f.get('/join/return', cookie)).text()).toContain('We sent a sign-in link');
    expect((await f.get('/join/checkout', cookie)).headers.get('location')).toBe('/join/return');
    // A retried command, a replayed effect and the Checkout hook all find the join complete.
    await f.transitions.manualPayment(context, cash); await f.drain();
    await f.join.afterInvoicePaid(f.gymId, bill.id);
    await f.join.afterCheckout(f.gymId, state.links.find(l => l.invoiceId === bill.id)!.id);
    state = await f.rows();
    expect(state.audits.filter(a => a.action === 'public.join.completed')).toHaveLength(1);
    expect(state.audits.filter(a => a.action === 'public.join.member_activated')).toHaveLength(2);
    expect(f.sent).toHaveLength(1);
    // Another household's paid invoice is not a join.
    const other = await factory('invoices', f.gymId, { householdId: f.existingHome.id, number: 98, status: 'paid' });
    await f.join.afterInvoicePaid(f.gymId, other.id);
    expect((await f.rows()).members.find(m => m.id === f.existing.id)).toMatchObject({ status: 'active', revision: 1 });
    expect((await f.rows()).audits.filter(a => a.action === 'public.join.completed')).toHaveLength(1);
  });

  it('completes once when the Checkout hook and the paid-invoice effect race', async () => {
    const f = await fixture(), { cookie } = await f.submit();
    const [home] = await f.joined(), state = await f.rows(), bill = state.invoices.find(i => i.householdId === home!.id)!;
    const linkId = state.links.find(l => l.invoiceId === bill.id)!.id;
    await f.transitions.manualPayment({ gymId: f.gymId, actor: { kind: 'system' } },
      { invoiceId: bill.id, paymentId: uuidv7(), method: 'check', amountCents: bill.amountCents, currency: 'CAD', paidAt: f.clock.now().toISOString() });
    await Promise.all([f.join.afterInvoicePaid(f.gymId, bill.id), f.join.afterCheckout(f.gymId, linkId), f.join.afterInvoicePaid(f.gymId, bill.id), f.join.afterCheckout(f.gymId, linkId)]);
    await f.drain();
    expect((await f.rows()).audits.filter(a => a.action === 'public.join.completed')).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    expect(await (await f.get('/join/return', cookie)).text()).toContain('We sent a sign-in link');
  });

  it('shows a closed join page when staff void the invoice or revoke its link, and still continues a paid or recording join', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCheckout');
    const closed = async (cookie: string, target = f.server) => {
      for (const path of ['/join/checkout', '/join/return', '/join/cancelled']) {
        const response = await f.get(path, cookie, target);
        expect(response.status).toBe(200); expect(response.headers.get('location')).toBeNull(); expect(response.headers.get('refresh')).toBeNull();
        const html = await response.text();
        expect(html).toContain('The gym has closed this payment'); expect(html).toContain('Please contact the gym'); expect(html).not.toContain('Confirming');
      }
    };
    const home = async (email: string) => (await f.joined()).find(h => h.email === email)!;
    const voided = await f.submit([adult()], 'void@example.invalid'), voidHome = await home('void@example.invalid');
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'void' }).where(eq(invoices.householdId, voidHome.id)));
    await closed(voided.cookie);
    expect(create).not.toHaveBeenCalled();
    // Another gym never learns of it.
    expect(await (await f.get('/join/checkout', voided.cookie, f.app(f.otherGym))).text()).toContain('This browser no longer has your sign-up');
    const links = createSignedLinksService({ scope: db.forGym, clock: f.clock }), system = { gymId: f.gymId, actor: { kind: 'system' as const } };
    const revoked = await f.submit([adult()], 'revoked@example.invalid'), revokedHome = await home('revoked@example.invalid');
    expect((await f.get('/join/checkout', revoked.cookie)).status).toBe(303);
    await links.revoke(system, (await f.rows()).links.find(l => l.householdId === revokedHome.id)!.id);
    await closed(revoked.cookie);
    // A Checkout completed but not yet recorded still continues to the return page.
    const recording = await f.submit([adult()], 'recording@example.invalid');
    const session = new URL((await f.get('/join/checkout', recording.cookie)).headers.get('location')!).pathname.slice(1);
    f.provider.completeCheckout(session);
    expect((await f.get('/join/checkout', recording.cookie)).headers.get('location')).toBe('/join/return');
    await f.webhook(session);
    // A paid invoice wins over a link revoked afterwards.
    const paidHome = await home('recording@example.invalid');
    await links.revoke(system, (await f.rows()).links.find(l => l.householdId === paidHome.id)!.id);
    expect((await f.get('/join/checkout', recording.cookie)).headers.get('location')).toBe('/join/return');
    expect(await (await f.get('/join/return', recording.cookie)).text()).toContain('We sent a sign-in link');
    // Neither closed join activated anything.
    const state = await f.rows();
    expect(state.members.filter(m => [voidHome.id, revokedHome.id].includes(m.householdId)).map(m => m.status)).toEqual(['prospect', 'prospect']);
  });

  it('accepts join bodies up to its 4 MiB cap and renders its own page above it', async () => {
    const f = await fixture(), big = noisePng(), bigBase64 = big.toString('base64');
    expect(big.length).toBeGreaterThan(240_000); expect(big.length).toBeLessThan(256 * 1024);
    // Three adults with two chosen PNG files each: over the install's 1 MiB default, inside the join's cap.
    const people = [adult('Ana'), adult('Ben'), adult('Cy')];
    const admission = { planId: f.plan.id, contact: { name: 'Pat Payer', email: 'big@example.invalid' }, honeypot: '',
      members: people.map(member => ({ member, signatures: f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64: bigBase64,
        signer: { kind: 'self', name: member.firstName } })) })) };
    const body = JSON.stringify(admission);
    expect(body.length).toBeGreaterThan(1024 * 1024); expect(body.length).toBeLessThan(joinBodyBytes);
    const admitted = await f.post('/join/signatures', admission);
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    for (const size of [joinBodyBytes + 1, 2 * joinBodyBytes + 1]) {
      const refused = await f.server.request(origin + '/join/signatures', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'content-length': String(size) }, body: 'x'.repeat(size) });
      expect(refused.status).toBe(400); expect(await refused.text()).toContain('Request too large');
    }
    const native = async (padding: number) => {
      const form = nativeForm(f, f.plan.id, `native-${padding}@example.invalid`);
      f.templates.forEach((_, j) => form.set(`waiver-0-${j}-image`, new File([big], 'signature.png', { type: 'image/png' })));
      form.set('padding', 'x'.repeat(padding));
      return f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    };
    const under = await native(joinBodyBytes - 600 * 1024);
    expect(under.status, await under.clone().text()).toBe(200); expect(await under.text()).toContain('href="/join/checkout"');
    for (const padding of [joinBodyBytes + 1, joinBodyBytes + 2 * 1024 * 1024]) {
      const over = await native(padding);
      expect(over.status).toBe(413); expect(over.headers.get('content-type')).toContain('text/html');
      expect(await over.text()).toContain('too large to send together');
    }
    // Past twice the cap, the install-wide limiter answers first.
    expect((await native(2 * joinBodyBytes + 1)).status).toBe(400);
    expect((await f.rows()).homes.filter(h => h.email?.startsWith('native-'))).toHaveLength(1);
  });

  it('keeps a February 29 annual join on its leap-day anniversary', async () => {
    const f = await fixture('email', '2028-02-29T18:00:00Z'), { cookie } = await f.submit([adult()], 'leap@example.invalid', f.annual.id);
    await f.pay(cookie);
    const [home] = await f.joined();
    expect((await f.rows()).memberships.filter(m => m.householdId === home!.id).map(m => [m.status, m.nextDueOn, m.anniversaryOn]))
      .toEqual([['active', '2029-02-28', '2028-02-29']]);
  });

  describe('a joiner using an existing account email cannot take it over', () => {
    async function paid(f: Fixture, email: string) {
      const { cookie } = await f.submit([adult()], email);
      await f.pay(cookie);
      return { cookie, home: (await f.joined()).find(h => h.email === email)! };
    }
    it('passwordless: the sign-in link reaches the address owner and grants only the account it names', async () => {
      const f = await fixture(), owner = await factory('authUser', f.gymId, { email: 'owner-of@example.invalid' });
      const otherHome = await factory('households', f.gymId);
      await factory('householdUsers', f.gymId, { householdId: otherHome.id, userId: owner.id, scope: 'payer' });
      const staff = await factory('authUser', f.gymId, { email: 'staff@example.invalid' });
      await factory('staffRoles', f.gymId, { userId: staff.id, role: 'admin' });
      const { home } = await paid(f, 'owner-of@example.invalid');
      expect(f.sent).toEqual([expect.objectContaining({ email: 'owner-of@example.invalid' })]);
      const attacker = await factory('authUser', f.gymId);
      await expect(f.invitations.completeClaim(f.gymId, attacker.id, { claim: f.sent[0]!.claim }, f.clock)).rejects.toMatchObject({ code: 'not_found' });
      expect((await f.rows()).logins.filter(l => l.householdId === home.id)).toEqual([]);
      expect(await f.invitations.completeClaim(f.gymId, owner.id, { claim: f.sent[0]!.claim }, f.clock)).toBe(home.id);
      const staffJoin = await paid(f, 'staff@example.invalid');
      expect(f.sent).toHaveLength(1);
      expect(await (await f.get('/join/return', staffJoin.cookie)).text()).toContain('We sent a sign-in link');
      expect((await f.rows()).logins.filter(l => l.userId === staff.id)).toEqual([]);
    });
    it('passwordless: no address awaits staff confirmation', async () => {
      const f = await fixture(), { home } = await paid(f, 'mailable@example.invalid');
      expect(await createHouseholdUsersService({ scope: db.forGym, clock: f.clock }).awaitingConfirmation(f.gymId, home.id)).toBeNull();
      expect((await f.post('/join/portal-login', undefined, (await f.submit([adult()], 'other@example.invalid')).cookie)).headers.get('location')).toBe('/join/return');
    });
    it('password mode: a paid join creates no account or password; staff confirm the person with the printed invitation', async () => {
      const f = await fixture('password'), users = createHouseholdUsersService({ scope: db.forGym, clock: f.clock });
      await f.accounts.createPasswordUser(f.gymId, 'has-password@example.invalid', 'Owner', 'owner-password-123', f.clock);
      const staff = await factory('authUser', f.gymId, { email: 'desk@example.invalid' });
      await factory('staffRoles', f.gymId, { userId: staff.id, role: 'admin' });
      const before = await f.rows();
      const fresh = await paid(f, 'brand-new@example.invalid'), existing = await paid(f, 'has-password@example.invalid'), staffJoin = await paid(f, 'desk@example.invalid');
      expect(await f.accounts.findUserByEmail('brand-new@example.invalid')).toBeFalsy();
      for (const join of [fresh, existing, staffJoin]) {
        const welcome = await (await f.get('/join/return', join.cookie)).text();
        expect(welcome).toContain('The gym confirms your member portal login'); expect(welcome).not.toContain('/join/portal-login');
        const login = await f.post('/join/portal-login', undefined, join.cookie);
        expect(login.status).toBe(200); expect(login.headers.get('location')).toBeNull();
        expect(await login.text()).toContain('The gym confirms your member portal login');
      }
      let state = await f.rows();
      expect(state.logins).toEqual([]); expect(f.sent).toEqual([]);
      expect(state.audits.filter(a => a.action === 'household_user.invited')).toEqual([]);
      expect(state.audits.filter(a => a.action === 'public.join.completed')).toHaveLength(3);
      expect(await f.accounts.findUserByEmail('brand-new@example.invalid')).toBeFalsy();
      expect(before.homes.length + 3).toBe(state.homes.length);
      // Staff with portal_access.manage see each address awaiting confirmation on its own household only.
      expect(await users.awaitingConfirmation(f.gymId, fresh.home.id)).toEqual({ email: 'brand-new@example.invalid' });
      expect(await users.awaitingConfirmation(f.gymId, existing.home.id)).toEqual({ email: 'has-password@example.invalid' });
      expect(await users.awaitingConfirmation(f.gymId, f.existingHome.id)).toBeNull();
      await expect(users.awaitingConfirmation(f.otherGym, fresh.home.id)).rejects.toMatchObject({ code: 'not_found' });
      // After checking the person, staff issue the existing printed invitation; the person sets the password on the claim page.
      const owner = await factory('authUser', f.gymId);
      await factory('staffRoles', f.gymId, { userId: owner.id, role: 'owner' });
      const actor = { gymId: f.gymId, userId: owner.id, clock: f.clock, timezone };
      const print = async (home: { id: string; email: string | null }) => {
        const issued = await f.invitations.invite(actor, home.id, { email: home.email!, scope: 'payer', memberId: null, delivery: 'print' }, origin);
        if (issued.data.delivery !== 'print') throw new Error('Expected a printed invitation');
        return new URL(issued.data.invitationUrl).hash.slice(1);
      };
      // A printed invitation that is lost keeps the household awaiting; printing again replaces it.
      const lost = await print(fresh.home), token = await print(fresh.home);
      expect(await users.awaitingConfirmation(f.gymId, fresh.home.id)).toEqual({ email: 'brand-new@example.invalid' });
      await expect(f.invitations.accept(f.gymId, { token: lost, password: 'new-member-password-1' }, f.clock)).rejects.toMatchObject({ code: 'not_found' });
      expect(await f.invitations.accept(f.gymId, { token, password: 'new-member-password-1' }, f.clock)).toEqual({ data: { status: 'claimed' } });
      expect(await users.awaitingConfirmation(f.gymId, fresh.home.id)).toBeNull();
      expect(await users.awaitingConfirmation(f.gymId, existing.home.id)).not.toBeNull();
      // An existing account proves its current password; it is never replaced.
      const proof = await print(existing.home);
      await expect(f.invitations.accept(f.gymId, { token: proof, password: 'attacker-password-123' }, f.clock)).rejects.toMatchObject({ code: 'forbidden' });
      expect(await f.invitations.accept(f.gymId, { token: proof, password: 'owner-password-123' }, f.clock)).toEqual({ data: { status: 'claimed' } });
      // Staff accounts stay refused, and their join keeps awaiting confirmation.
      await expect(print(staffJoin.home)).rejects.toMatchObject({ code: 'forbidden' });
      expect(await users.awaitingConfirmation(f.gymId, staffJoin.home.id)).toEqual({ email: 'desk@example.invalid' });
      state = await f.rows();
      expect(state.logins.map(l => [l.householdId, l.scope]).sort()).toEqual([[fresh.home.id, 'payer'], [existing.home.id, 'payer']].sort());
      expect(state.logins.filter(l => l.userId === staff.id)).toEqual([]);
      expect(f.sent).toEqual([]);
    });
  });
});
