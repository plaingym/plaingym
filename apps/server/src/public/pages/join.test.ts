// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The test turns a gym's billing switch off in real PostgreSQL.
import { auditEvents, gyms, households, householdUsers, invoiceLineItems, invoices, members, memberships, paymentMethods, signedLinks,
  waiverSignatures, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { publicContracts, publicSubmissionResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import { createSettingsService, createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
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
import { joinAdmissionResponseSchema } from './join.service.js';
import { joinCookie } from './join.continuation.js';

const db = useTestDatabase(), factory = createFactories(db), png = demoSignaturePng(), pngBase64 = png.toString('base64');
const origin = 'https://gym.example.test', timezone = 'America/Vancouver', key = new Uint8Array(32).fill(9);
const password = { AUTH_SECRET: 'join-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' };
const passwordConfig = authConfig(password, false);
const emailConfig = { ...passwordConfig, tenancy: 'multi' as const, passwordEnabled: false, passwordMode: 'off' as const, smtpConfigured: true };
type Person = { firstName: string; lastName: string; dateOfBirth: string };
const adult = (firstName = 'Avery'): Person => ({ firstName, lastName: 'Joiner', dateOfBirth: '1990-01-02' });
const child = (firstName = 'Kai'): Person => ({ firstName, lastName: 'Joiner', dateOfBirth: '2016-05-06' });

async function fixture(mode: 'email' | 'password' = 'email', start = '2026-10-29T18:00:00Z') {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock(start);
  await factory('gyms', gymId, { name: 'North <Gym>', currency: 'CAD', timezone, billingEnabled: true, memberEmailsEnabled: true, websiteEnabled: false });
  await factory('gyms', otherGym, { name: 'Other private gym', currency: 'CAD', timezone, billingEnabled: true });
  const plan = await factory('plans', gymId, { name: 'Adult monthly', amountCents: 15000, currency: 'CAD', interval: 'monthly', signupFeeCents: 5000 });
  const gst = await factory('taxRates', gymId, { name: 'GST', rateMillionths: 50_000, inclusive: false });
  await factory('planTaxRates', gymId, { planId: plan.id, taxRateId: gst.id });
  const annual = await factory('plans', gymId, { name: 'Annual', amountCents: 150000, currency: 'CAD', interval: 'annual' });
  const trial = await factory('plans', gymId, { name: 'Trial plan', currency: 'CAD', trialDays: 7 });
  const free = await factory('plans', gymId, { name: 'Free plan', currency: 'CAD', amountCents: 0 });
  const retired = await factory('plans', gymId, { name: 'Retired plan', currency: 'CAD', active: false });
  const foreignPlan = await factory('plans', otherGym, { name: 'Private other plan', currency: 'CAD' });
  const templates = [await factory('waiverTemplates', gymId, { name: 'Conduct', body: 'Follow the rules. <script>bad()</script>', kind: 'agreement' }),
    await factory('waiverTemplates', gymId, { name: 'Participation', body: 'I understand the training risks.' })];
  const foreignTemplate = await factory('waiverTemplates', otherGym, { name: 'Private other terms' });
  const existingHome = await factory('households', gymId, { name: 'Existing household', email: 'existing@example.invalid' });
  const existing = await factory('members', gymId, { householdId: existingHome.id, status: 'active', email: 'existing@example.invalid', firstName: 'Private' });
  const provider = new FakePayments(gymId, clock), paymentsFor = async () => provider;
  const uploads = new FakeUploads(gymId, clock), waivers = createWaiversService({ scope: db.forGym, clock, uploadsFor: async () => uploads });
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor, originFor: async () => origin });
  const config = mode === 'password' ? passwordConfig : emailConfig, mail = new FakeEmail(), sent: Parameters<PortalLoginLinkSender>[0][] = [];
  const invitations = createPortalInvitationService({ config, database: () => db.system.db, scope: db.forGym, householdScope: db.forHousehold,
    smtpConfigured: async () => mode === 'email', mailer: async () => mail, loginLink: async input => { sent.push(input); } });
  const accounts = createAccountService(config, () => db.system.db);
  const settings = createGymSettingsAccessor({ scope: db.forGym, clock }), lifecycle = createMembershipService({ scope: db.forGym, clock, settings });
  const paymentsConfigured = vi.fn(async (id: string) => id === gymId);
  const join = configureJoin({ scope: db.forGym, clock, key, waivers, checkout, paymentsConfigured, invitations, accounts,
    settings: createSettingsService({ scope: db.forGym, clock }), memberships: lifecycle, invitationStore: createPortalInvitationStore(() => db.system.db) });
  const jobs = new FakeJobs(clock), transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  const notifications = createTransitionNotifications({ scope: db.forGym, clock, settings, async prepare() { return { email: mail, origin }; }, async staffRecipients() { return []; } });
  const effects = createTransitionEffects({ scope: db.forGym, clock, jobs, settings, transitions, memberships: lifecycle, async payments() { return provider; }, notifications, async retry() {} });
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
    await handlers.get(type)!(event, { gymId, clock, timezone, jobId: uuidv7(), attempt: 1, payments: provider });
    await effects.publish(gymId); while (await jobs.runNext()) { /* every effect now due */ }
  }
  const app = (resolved = gymId) => createApp({ skipSetup: true, clock, authorize, contributions: areaContributions, origin, rateLimit: { limit: 10_000 },
    resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: resolved, timezone, enabledModules: new Set() } }); await next(); },
    session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal: { kind: 'anonymous' } }); await next(); } });
  const server = app();
  const get = (path: string, cookie = '', target = server) => target.request(origin + path, { headers: cookie ? { cookie } : {} });
  const post = (path: string, body: unknown, cookie = '', target = server) => target.request(origin + path, { method: 'POST',
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const signer = (person: Person) => person.dateOfBirth > '2008-10-29' ? { kind: 'guardian' as const, name: 'Pat Payer', relationship: 'Parent' }
    : { kind: 'self' as const, name: person.firstName + ' ' + person.lastName };
  async function admit(people: Person[], email: string, planId: string) {
    const response = await post('/join/signatures', { planId, contact: { name: 'Pat Payer', email }, honeypot: '',
      members: people.map(member => ({ member, signatures: templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64 })) })) });
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
    logins: await tx.select().from(householdUsers), methods: await tx.select().from(paymentMethods), audits: await tx.select().from(auditEvents) }));
  const joined = async () => (await rows()).homes.filter(h => h.id !== existingHome.id);
  return { gymId, otherGym, clock, plan, annual, trial, free, retired, foreignPlan, templates, foreignTemplate, existingHome, existing, provider, paymentsFor,
    paymentsConfigured, waivers, checkout, invitations, accounts, settings, lifecycle, join, jobs, transitions, sent, mail, afterCheckout, webhook,
    app, server, get, post, admit, body, submit, pay, rows, joined };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const cookieValue = (cookie: string) => decodeURIComponent(cookie.slice(joinCookie.length + 1));
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
  it('lists only plans payable online, renders the join form with the website off, and projects nothing from another gym', async () => {
    const f = await fixture(), list = await f.get('/join'), html = await list.text();
    expect(list.status).toBe(200); expect(html).toContain('North &lt;Gym&gt;'); expect(html).toContain('href="/source"');
    expect(html).toContain('Adult monthly'); expect(html).toContain('Annual'); expect(html).toContain('$150.00 per month'); expect(html).toMatch(/Sign-up fee: [A-Z]*\$50\.00/);
    for (const hidden of ['Trial plan', 'Free plan', 'Retired plan', 'Private other plan', 'Private']) expect(html).not.toContain(hidden);
    expect(list.headers.get('content-security-policy')).toContain("form-action 'self'"); expect(list.headers.get('cache-control')).toBe('no-store');
    const form = await (await f.get(`/join?plan=${f.plan.id}&members=2`)).text();
    expect(form.match(/data-member=/g)).toHaveLength(2); expect(form.match(/data-waiver/g)).toHaveLength(4);
    expect(form).toContain('&lt;script&gt;bad()&lt;/script&gt;'); expect(form).not.toContain('<script>bad()'); expect(form).toContain('src="/join/client.js"');
    expect(form).toContain('enctype="multipart/form-data"');
    for (const path of [`/join?plan=${f.trial.id}`, `/join?plan=${f.foreignPlan.id}`, '/join?plan=not-an-id&members=99']) expect(await (await f.get(path)).text()).not.toContain('data-join-form');
    expect(await (await f.get(`/join?plan=${f.plan.id}&members=99`)).text()).toMatch(/data-member="5"/);
    const api = publicContracts.plans.response.parse(await (await f.get('/api/public/plans?limit=1&offset=0')).json());
    expect(api).toMatchObject({ data: [{ id: f.plan.id, signupFeeCents: 5000, trialDays: 0 }], pagination: { limit: 1, offset: 0, total: 2 } });
    const other = f.app(f.otherGym);
    for (const path of ['/join', `/join?plan=${f.plan.id}`, '/api/public/plans']) {
      const text = await (await f.get(path, '', other)).text();
      expect(text).not.toContain('North'); expect(text).not.toContain('Adult monthly'); expect(text).not.toContain(f.plan.id);
    }
    expect((await f.get('/join/client.js')).headers.get('content-type')).toContain('text/javascript');
    f.paymentsConfigured.mockResolvedValue(false);
    expect(await (await f.get('/join')).text()).toContain('Online joining is not available right now');
  });

  it('activates a family only through the paid Checkout webhook, bills on the join-date anniversary and creates the portal login by email proof', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCheckout');
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
    expect(confirming.headers.get('refresh')).toBe('5'); expect(await confirming.text()).toContain('Confirming your payment');
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
    const signatures = f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64 }));
    const admission = (changes: Record<string, unknown> = {}) => ({ planId: f.plan.id, contact: { name: 'Bot', email: 'bot@example.invalid' }, honeypot: '',
      members: [{ member: adult(), signatures }], ...changes });
    expect((await f.post('/join/signatures', admission({ honeypot: 'spam' }))).status).toBe(400);
    expect((await f.post('/api/public/join', { ...admission({ honeypot: 'spam' }), members: [] })).status).toBe(400);
    expect((await f.post('/join/signatures', admission({ planId: f.trial.id }))).status).toBe(404);
    expect((await f.post('/join/signatures', admission({ planId: f.foreignPlan.id }))).status).toBe(404);
    expect((await f.post('/join/signatures', admission({ members: [{ member: adult(), signatures: [signatures[0]] }] }))).status).toBe(409);
    expect((await f.post('/join/signatures', admission({ members: [{ member: adult(), signatures: [signatures[0],
      { templateId: f.foreignTemplate.id, templateVersion: 1, pngBase64 }] }] }))).status).toBe(409);
    expect((await f.post('/join/signatures', admission({ members: Array.from({ length: 7 }, () => ({ member: adult(), signatures })) }))).status).toBe(400);
    f.paymentsConfigured.mockResolvedValueOnce(false);
    expect((await f.post('/join/signatures', admission())).status).toBe(503);
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ billingEnabled: false }).where(eq(gyms.id, f.gymId)));
    expect((await f.post('/join/signatures', admission())).status).toBe(503);
    expect((await f.server.request(origin + '/join', { method: 'POST', headers: { origin }, body: nativeForm(f, f.plan.id, 'bot@example.invalid') })).status).toBe(503);
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
    const response = await f.server.request(origin + '/join', { method: 'POST', headers: { origin }, body: form });
    expect(response.status).toBe(200); expect(await response.text()).toContain('href="/join/checkout"');
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    await f.pay(cookie);
    const home = (await f.joined()).find(h => h.email === 'native@example.invalid')!, state = await f.rows();
    expect(state.memberships.filter(m => m.householdId === home.id).map(m => [m.status, m.nextDueOn, m.anniversaryOn])).toEqual([['active', '2027-10-29', '2026-10-29']]);
    form.set('honeypot', 'spam');
    expect((await f.server.request(origin + '/join', { method: 'POST', headers: { origin }, body: form })).status).toBe(400);
    const huge = new FormData(); huge.set('members', '1'); huge.set('padding', 'x'.repeat(1024 * 1024 + 1));
    expect((await f.server.request(origin + '/join', { method: 'POST', headers: { origin }, body: huge })).status).toBe(400);
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
    expect(await (await f.get('/join/return', cookie)).text()).toContain('We sent a sign-in link');
    expect(f.sent).toHaveLength(1);
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
    it('password mode: an existing password must be proven, and an existing passwordless account is never given one', async () => {
      const f = await fixture('password');
      await f.accounts.createPasswordUser(f.gymId, 'has-password@example.invalid', 'Owner', 'owner-password-123', f.clock);
      const passwordless = await factory('authUser', f.gymId, { email: 'no-password@example.invalid' });
      const existing = await paid(f, 'has-password@example.invalid');
      expect(await (await f.get('/join/return', existing.cookie)).text()).toContain('enter its current password');
      const login = await f.post('/join/portal-login', undefined, existing.cookie);
      expect(login.status).toBe(303);
      const token = login.headers.get('location')!.replace('/portal/claim#', '');
      await expect(f.invitations.accept(f.gymId, { token, password: 'attacker-password-123' }, f.clock)).rejects.toMatchObject({ code: 'forbidden' });
      expect((await f.rows()).logins).toEqual([]);
      expect(await f.invitations.accept(f.gymId, { token, password: 'owner-password-123' }, f.clock)).toEqual({ data: { status: 'claimed' } });
      const unclaimable = await paid(f, 'no-password@example.invalid');
      expect(await (await f.post('/join/portal-login', undefined, unclaimable.cookie)).text()).toContain('please contact the gym');
      expect(await f.accounts.hasPassword(passwordless.id)).toBe(false);
      expect((await f.rows()).logins.filter(l => l.householdId === unclaimable.home.id)).toEqual([]);
      const fresh = await paid(f, 'brand-new@example.invalid');
      const first = (await f.post('/join/portal-login', undefined, fresh.cookie)).headers.get('location')!;
      const retry = (await f.post('/join/portal-login', undefined, fresh.cookie)).headers.get('location')!;
      expect(retry).toMatch(/^\/portal\/claim#[a-f0-9]{64}$/); expect(retry).not.toBe(first);
      expect(await f.invitations.accept(f.gymId, { token: retry.split('#')[1]!, password: 'new-member-password-1' }, f.clock)).toEqual({ data: { status: 'claimed' } });
      expect((await f.rows()).logins.filter(l => l.householdId === fresh.home.id)).toHaveLength(1);
      expect(await (await f.post('/join/portal-login', undefined, fresh.cookie)).text()).toContain('your portal login is ready');
      expect(f.sent).toEqual([]);
    });
  });
});
