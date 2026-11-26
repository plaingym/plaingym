// SPDX-License-Identifier: AGPL-3.0-only
import { jsonInit, requestWithLength } from '../../../test/request.js';
import { describe, expect, it, vi } from 'vitest';
import { configureSharedRateLimits } from '../../core/rate-limit.js';
import { appCookieName, configureCookies } from '../../core/cookies.js';
import { createIntakeRateLimitStore } from '../../core/rate-limit-store.js';
import { publicIntakeLimits } from '../../core/rate-limit-intake.js';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The test turns a gym's billing switch off in real PostgreSQL.
import { auditEvents, gyms, households, householdUsers, invoiceLineItems, invoices, leads, members, memberships, paymentMethods, plans, signedLinks,
  smsOptedOutNumbers, waiverSignatures, waiverTemplates, uuidv7, discounts, membershipDiscounts, taxRates, databaseCode } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { joinAdmissionResponseSchema, publicContracts, publicSubmissionResponseSchema } from '@plaingym/shared/contracts';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import { createWaiversService, type WaiverOptions } from '../../areas/waivers/waivers.js';
import { preflightWaiver } from '../../areas/waivers/pdf.js';
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
import { awaitingConfirmationCondition, createHouseholdUsersService } from '../../areas/members/household-users.js';
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
import { jobs as joinJobs, joinSignInJob } from './join.jobs.js';

const db = useTestDatabase(), factory = createFactories(db), png = demoSignaturePng(), pngBase64 = png.toString('base64');
const origin = 'https://gym.example.test', timezone = 'America/Vancouver', key = new Uint8Array(32).fill(9);
const password = { AUTH_SECRET: 'join-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' };
const passwordConfig = authConfig(password, false);
const emailConfig = { ...passwordConfig, tenancy: 'multi' as const, passwordEnabled: false, passwordMode: 'off' as const, smtpConfigured: true };
type Person = { firstName: string; lastName: string; dateOfBirth: string };
const adult = (firstName = 'Avery'): Person => ({ firstName, lastName: 'Joiner', dateOfBirth: '1990-01-02' });
const child = (firstName = 'Kai'): Person => ({ firstName, lastName: 'Joiner', dateOfBirth: '2016-05-06' });

async function fixture(mode: 'email' | 'password' = 'email', start = '2026-10-29T18:00:00Z', currency = 'CAD', gymTimezone = timezone,
  waiverOptions: Pick<WaiverOptions, 'preflight' | 'render'> = {}) {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock(start);
  await factory('gyms', gymId, { name: 'North <Gym>', currency, timezone: gymTimezone, billingEnabled: true, memberEmailsEnabled: true, websiteEnabled: false,
    address: { line1: '12 Mat Street', country: 'CA' }, settings: { modules: { website: { phone: '+1 (604) 555-0100', email: 'hello@north.example.test' } } } });
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
  const waivers = createWaiversService({ scope: db.forGym, clock, uploadsFor, documentDelivery, ...waiverOptions });
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor, originFor: async () => origin });
  const config = mode === 'password' ? passwordConfig : emailConfig, mail = new FakeEmail(), sent: Parameters<PortalLoginLinkSender>[0][] = [];
  const invitations = createPortalInvitationService({ config, database: () => db.system.db, scope: db.forGym, householdScope: db.forHousehold,
    smtpConfigured: async () => mode === 'email', mailer: async () => mail, loginLink: async input => { sent.push(input); } });
  const accounts = createAccountService(config, () => db.system.db);
  const settings = createGymSettingsAccessor({ scope: db.forGym, clock }), lifecycle = createMembershipService({ scope: db.forGym, clock, settings });
  const assigned = vi.fn(async (_scope: typeof db.forGym, _membership: Awaited<ReturnType<typeof lifecycle.assign>>) => {});
  const paymentsConfigured = vi.fn(async (id: string) => id === gymId);
  const jobs = new FakeJobs(clock);
  const join = configureJoin({ scope: db.forGym, clock, key, waivers, checkout, paymentsConfigured, invitations, accounts, uploadsFor, jobs,
    memberships: scope => {
      const service = scope === db.forGym ? lifecycle : createMembershipService({ scope, clock, settings: createGymSettingsAccessor({ scope, clock }) });
      return { ...service, async assign(...args) {
        const membership = await service.assign(...args);
        await assigned(scope, membership);
        return membership;
      } };
    },
    invitationStore: createPortalInvitationStore(() => db.system.db) });
  // As the runtime registers them: the passwordless sign-in runs as a job, after the request answers.
  for (const job of joinJobs) if (job.cron) jobs.schedule(job.id, job.cron, job.handler); else jobs.handle(job.id, job.handler);
  const transitions = createInvoiceTransitions({ scope: db.forGym, clock });
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
  async function webhook(sessionId: string, type = 'checkout.session.completed', thenDrain = true) {
    const event = { id: 'evt_' + uuidv7(), type, gymId, objectKind: 'checkout' as const, objectId: sessionId };
    await handlers.get(type)!(event, { gymId, clock, timezone: gymTimezone, jobId: uuidv7(), attempt: 1, payments: provider });
    if (thenDrain) await drain();
  }
  async function drain() { await effects.publish(gymId); while (await jobs.runNext()) { /* every effect now due */ } }
  const app = (resolved = gymId) => createApp({ skipSetup: true, clock, authorize, contributions: areaContributions, origin, rateLimit: { limit: 10_000 },
    resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: resolved, timezone: gymTimezone, enabledModules: new Set() } }); await next(); },
    session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal: { kind: 'anonymous' } }); await next(); } });
  const server = app();
  const get = (path: string, cookie = '', target = server) => target.request(origin + path, { headers: cookie ? { cookie } : {} });
  const post = (path: string, body: unknown, cookie = '', target = server) => {
    const init = body === undefined ? { headers: {} } : jsonInit(body);
    return target.request(origin + path, { method: 'POST', ...init,
      headers: { ...init.headers, origin, ...(cookie ? { cookie } : {}) } });
  };
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
    uploads, uploadsFor, paymentsConfigured, waivers, checkout, invitations, accounts, settings, lifecycle, assigned, join, jobs, transitions, sent, mail, afterCheckout, afterInvoicePaid, webhook, drain,
    app, server, get, post, admit, body, submit, pay, rows, joined };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe('join lead intake', () => {
  it.each([
    { smsNoticesConsent: false, smsAnnouncementsConsent: false, phone: '+16045550123' },
    { smsNoticesConsent: true, smsAnnouncementsConsent: false, phone: '+16045550123' },
    { smsNoticesConsent: false, smsAnnouncementsConsent: true, phone: '+1 (604) 555-0123' },
    { smsNoticesConsent: true, smsAnnouncementsConsent: true, phone: '(604) 555-0123' },
  ])('records join SMS choices notices=$smsNoticesConsent announcements=$smsAnnouncementsConsent for $phone without phone audits', async ({
    smsNoticesConsent, smsAnnouncementsConsent, phone,
  }) => {
    const f = await fixture(), people = [adult(), child()], phoneE164 = '+16045550123';
    const choices = { smsNoticesConsent, smsAnnouncementsConsent };
    const contact = { name: 'Pat Payer', email: 'sms@example.invalid', phone };
    const admission = { planId: f.plan.id, contact, ...choices, honeypot: '', members: people.map(member => ({ member,
      signatures: f.templates.map(template => ({ templateId: template.id, templateVersion: template.version, pngBase64,
        signer: member.dateOfBirth > '2008-10-29' ? { kind: 'guardian', name: 'Pat Payer', relationship: 'Parent' } : { kind: 'self', name: member.firstName + ' ' + member.lastName } })) })) };
    const response = await f.post('/join/signatures', admission); expect(response.status).toBe(200);
    const images = joinAdmissionResponseSchema.parse(await response.json()).data;
    const final = { ...f.body(people, images, contact.email, f.plan.id), contact, ...choices };
    const refused = await f.post('/api/public/join', { ...final, smsNoticesConsent: !smsNoticesConsent });
    expect(refused.status).toBe(404);
    expect((await f.post('/api/public/join', final)).status).toBe(200);
    const rows = await f.rows(), home = rows.homes.find(home => home.email === contact.email)!;
    expect(home).toMatchObject({ phone, phoneE164, smsNoticesConsentAt: smsNoticesConsent ? f.clock.now() : null,
      smsNoticesConsentSource: smsNoticesConsent ? 'join' : null });
    const joined = rows.members.filter(person => person.householdId === home.id);
    expect(joined).toHaveLength(2);
    for (const person of joined) {
      expect(person).toMatchObject({ phone, phoneE164, smsNoticesConsentAt: smsNoticesConsent ? f.clock.now() : null,
        smsNoticesConsentSource: smsNoticesConsent ? 'join' : null, smsAnnouncementsConsentAt: smsAnnouncementsConsent ? f.clock.now() : null,
        smsAnnouncementsConsentSource: smsAnnouncementsConsent ? 'join' : null });
    }
    const logs = rows.audits.filter(event => event.action.endsWith('.sms_consent_changed'));
    expect(logs).toHaveLength((smsNoticesConsent ? 3 : 0) + (smsAnnouncementsConsent ? 2 : 0));
    const logged = JSON.stringify(logs.map(log => [log.before, log.after]));
    expect(logged).not.toContain(phone);
    expect(logged).not.toContain('6045550123');
  });
  it.each([[true, false], [false, true], [false, false]])('takes the contact number off the STOP list only with an SMS choice (notices=%s, announcements=%s)', async (smsNoticesConsent, smsAnnouncementsConsent) => {
    const f = await fixture(), people = [adult()], phoneE164 = '+16045550123';
    await factory('smsOptedOutNumbers', f.gymId, { phoneE164 });
    // Another gym's row for the number is never touched.
    await factory('smsOptedOutNumbers', f.otherGym, { phoneE164 });
    const contact = { name: 'Pat Payer', email: 'stop-list@example.invalid', phone: '(604) 555-0123' };
    const choices = { smsNoticesConsent, smsAnnouncementsConsent };
    const admission = { planId: f.plan.id, contact, ...choices, honeypot: '', members: people.map(member => ({ member,
      signatures: f.templates.map(template => ({ templateId: template.id, templateVersion: template.version, pngBase64,
        signer: { kind: 'self', name: member.firstName + ' ' + member.lastName } })) })) };
    const response = await f.post('/join/signatures', admission); expect(response.status).toBe(200);
    const images = joinAdmissionResponseSchema.parse(await response.json()).data;
    expect((await f.post('/api/public/join', { ...f.body(people, images, contact.email, f.plan.id), contact, ...choices })).status).toBe(200);
    const listed = (gymId: string) => db.forGym(gymId, tx => tx.select({ phoneE164: smsOptedOutNumbers.phoneE164 }).from(smsOptedOutNumbers));
    expect(await listed(f.gymId)).toEqual(smsNoticesConsent || smsAnnouncementsConsent ? [] : [{ phoneE164 }]);
    expect(await listed(f.otherGym)).toEqual([{ phoneE164 }]);
  });
  it.each(['', 'not a phone'])('refuses join opt-in with an unparseable phone %s before admission', async phone => {
    const f = await fixture(), form = nativeForm(f, f.plan.id, 'sms-invalid@example.invalid');
    form.set('phone', phone); form.set('smsNoticesConsent', 'on');
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    expect(response.status).toBe(400); expect(await response.text()).toContain('enter a valid contact phone number');
    expect(await f.joined()).toHaveLength(0);
  });
  it('uses the same field rules in admission and submission before persisting anything further', async () => {
    const f = await fixture(), people = [adult()], email = 'rules@example.invalid';
    const images = await f.admit(people, email, f.plan.id), original = f.body(people, images, email, f.plan.id);
    const cases = [
      { contact: { name: 'x'.repeat(201) } }, { contact: { email: 'a'.repeat(243) + '@example.invalid' } }, { contact: { phone: 'x'.repeat(101) } },
      { member: { firstName: 'x'.repeat(201) } }, { member: { lastName: 'x'.repeat(201) } }, { member: { dateOfBirth: '2099-01-01' } },
      { member: { dateOfBirth: child().dateOfBirth } }, { signer: { kind: 'self' as const, name: 'x'.repeat(201) } },
      { signer: { kind: 'guardian' as const, name: 'Parent', relationship: 'x'.repeat(101) } },
    ];
    for (const change of cases) {
      const contact = { ...original.contact, ...change.contact }, member = { ...people[0]!, ...change.member };
      const waivers = original.members[0]!.waivers.map(w => ({ ...w, signer: change.signer ?? w.signer }));
      await expect(f.join.join(f.gymId, { ...original, contact, members: [{ member, waivers }] }, timezone, '192.0.2.1')).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(f.join.admit(f.gymId, { planId: f.plan.id, honeypot: '', contact,
        members: [{ member, signatures: waivers.map(w => ({ templateId: w.templateId, templateVersion: w.templateVersion, signer: w.signer, pngBase64 })) }] }, timezone))
        .rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(await f.joined()).toHaveLength(1);
    const state = await f.rows(); expect(state.invoices).toHaveLength(0); expect(state.memberships).toHaveLength(0);
  });
  it('preflights only signing details for a five-person join with eight PDF templates', async () => {
    const preflight = vi.fn(preflightWaiver), render = vi.fn(async () => { throw new Error('Signing must not merge documents'); });
    const f = await fixture('email', undefined, undefined, undefined, { preflight, render });
    const document = await f.waivers.uploadDocument({ gymId: f.gymId, actor: { kind: 'system' } }, await waiverDocumentFixture());
    const columns = { body: '', documentKey: document.key, documentHash: document.hash, documentPages: document.pages, documentBytes: document.bytes };
    await db.forGym(f.gymId, tx => tx.update(waiverTemplates).set(columns));
    for (let i = 2; i < 8; i++) f.templates.push(await factory('waiverTemplates', f.gymId, { name: `Terms ${i}`, ...columns }));
    const { response } = await f.submit(Array.from({ length: 5 }, (_, i) => adult(`Person ${i}`)), 'five@example.invalid');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(preflight).toHaveBeenCalledTimes(40); expect(render).not.toHaveBeenCalled();
    expect((await f.waivers.listSignatures(f.gymId)).pagination.total).toBe(40);
  });
  it('reconciles a staff-set visitor to trial when a received join completes and records the billing audit once', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult()], 'visitor@example.invalid', f.trial.id);
    const [home] = await f.joined(), person = (await f.rows()).members.find(m => m.householdId === home!.id)!;
    await db.forGym(f.gymId, tx => tx.update(members).set({ status: 'visitor', revision: person.revision + 1 }).where(eq(members.id, person.id)));
    await f.pay(cookie);
    const state = await f.rows();
    expect(state.members.find(m => m.id === person.id)).toMatchObject({ status: 'trial', revision: person.revision + 2 });
    expect(state.memberships.find(m => m.memberId === person.id)?.status).toBe('trial');
    const changes = state.audits.filter(a => a.action === 'billing.member.trial_started' && a.targetId === person.id);
    expect(changes).toHaveLength(1); expect(changes[0]!.before).toMatchObject({ status: 'visitor' });
    expect(changes[0]!.after).toMatchObject({ status: 'trial', cause: 'public.join.completed' });
    expect(state.audits.some(a => a.action === 'public.join.member_activated')).toBe(false);
  });
  it.each(['frozen', 'cancelled'] as const)('refuses replay after staff set a pending join member to %s, but accepts its matching membership state', async status => {
    const f = await fixture(), email = 'staff-state@example.invalid', people = [adult()];
    const { images } = await f.submit(people, email), body = f.body(people, images, email, f.plan.id);
    const [home] = await f.joined(), person = (await f.rows()).members.find(m => m.householdId === home!.id)!;
    await db.forGym(f.gymId, tx => tx.update(members).set({ status }).where(eq(members.id, person.id)));
    await expect(f.join.join(f.gymId, body, timezone, '192.0.2.1')).rejects.toMatchObject({ code: 'not_found' });
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ status }).where(eq(memberships.memberId, person.id)));
    await expect(f.join.join(f.gymId, body, timezone, '192.0.2.1')).resolves.toMatchObject({ linkId: expect.any(String) });
    expect((await f.rows()).invoices.filter(i => i.householdId === home!.id)).toHaveLength(1);
  });
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
  it('joins the chosen country code to a native form phone, and leaves a phone with no choice as typed', async () => {
    const f = await fixture();
    const submit = async (email: string, fields: Record<string, string>) => {
      const form = nativeForm(f, f.free.id, email);
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
      expect(response.status).toBe(303);
      const rows = await f.rows(), home = rows.homes.find(row => row.email === email)!;
      return { home, members: rows.members.filter(person => person.householdId === home.id) };
    };
    const abroad = await submit('gb-phone@example.invalid', { phoneCountry: 'GB', phone: '020 7946 0018', smsNoticesConsent: 'on' });
    expect(abroad.home).toMatchObject({ phone: '+44 020 7946 0018', phoneE164: '+442079460018', smsNoticesConsentSource: 'join' });
    expect(abroad.home.smsNoticesConsentAt).not.toBeNull();
    expect(abroad.members).toHaveLength(1);
    expect(abroad.members[0]).toMatchObject({ phone: '+44 020 7946 0018', phoneE164: '+442079460018', smsNoticesConsentSource: 'join' });
    const local = await submit('no-choice@example.invalid', { phoneCountry: '', phone: '(604) 555-0123' });
    expect(local.home).toMatchObject({ phone: '(604) 555-0123', phoneE164: '+16045550123' });
  });
  it.each(['GB', 'US'] as const)('sends a native form phone typed with the chosen country\'s international prefix as a + number in a %s gym, and keeps text consent', async country => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ address: { line1: '12 Mat Street', country } }).where(eq(gyms.id, f.gymId)));
    const form = nativeForm(f, f.free.id, `gb-prefix-${country.toLowerCase()}@example.invalid`);
    for (const [name, value] of Object.entries({ phoneCountry: 'GB', phone: '0044 20 7946 0018', smsNoticesConsent: 'on' })) form.set(name, value);
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    expect(response.status).toBe(303);
    const home = (await f.rows()).homes.find(row => row.email === `gb-prefix-${country.toLowerCase()}@example.invalid`)!;
    expect(home).toMatchObject({ phone: '+44 20 7946 0018', phoneE164: '+442079460018', smsNoticesConsentSource: 'join' });
    expect(home.smsNoticesConsentAt).not.toBeNull();
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
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
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
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
    expect((await f.get('/join/checkout', cookie)).headers.get('location')).toBe('/join/return');
    expect((await f.post('/api/public/join', f.body(people, images, email, f.free.id))).status).toBe(200);
    // The completion queued its sign-in once; the job sends it.
    expect(f.sent).toHaveLength(0); expect(create).not.toHaveBeenCalled(); expect(charge).not.toHaveBeenCalled();
    await f.drain(); expect(f.sent).toHaveLength(1);
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
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
    expect(create).not.toHaveBeenCalled();
  });
});
describe('plan edits while joining', () => {
  it.each([[0, 7], [7, 0], [7, 14]])('serializes a plan edit between two assignments from %i to %i trial days', async (before, after) => {
    const f = await fixture(), plan = await factory('plans', f.gymId, { trialDays: before, amountCents: 10_000 });
    let edit: Promise<unknown> | undefined, assigned = false;
    const release = Promise.withResolvers<void>();
    f.assigned.mockImplementationOnce(async () => {
      assigned = true;
      await release.promise;
    });
    const people = [adult(), child()], email = 'family-plan-edit@example.invalid';
    const submitting = f.submit(people, email, plan.id);
    let submission: Awaited<ReturnType<typeof f.submit>>;
    try {
      await expect.poll(() => assigned, { timeout: 10_000, interval: 10 }).toBe(true);
      // A competing editor must wait until every person and the first invoice commit.
      try {
        await db.forGym(f.gymId, tx => tx.select().from(plans).where(eq(plans.id, plan.id)).for('update', { noWait: true }));
        throw new Error('The assigning transaction released its plan lock');
      } catch (error) { expect(databaseCode(error)).toBe('55P03'); }
      edit = db.forGym(f.gymId, tx => tx.update(plans).set({ trialDays: after }).where(eq(plans.id, plan.id)));
      release.resolve();
      submission = await submitting;
    } finally { release.resolve(); await submitting; await edit; }
    const { response, images } = submission;
    expect(response.status, await response.clone().text()).toBe(200);
    const [home] = await f.joined(), state = await f.rows();
    expect(state.memberships.filter(m => m.householdId === home!.id).map(m => m.trialEndsOn))
      .toEqual([before === 0 ? null : '2026-11-05', before === 0 ? null : '2026-11-05']);
    expect((await db.forGym(f.gymId, tx => tx.select().from(plans).where(eq(plans.id, plan.id))))[0]!.trialDays).toBe(after);
    expect((await f.post('/api/public/join', f.body(people, images, email, plan.id))).status).toBe(200);
    expect((await f.rows()).invoices.filter(i => i.householdId === home!.id)).toHaveLength(1);
  });
  it.each(['waiver', 'assignment'] as const)('bills the recorded assignment fee, taxes and description after a plan edit during %s', async timing => {
    const f = await fixture();
    async function edit(scope: typeof db.forGym) {
      await scope(f.gymId, async tx => {
        await tx.update(plans).set({ name: 'Revised plan', signupFeeCents: 7_000 }).where(eq(plans.id, f.plan.id));
        await tx.update(taxRates).set({ rateMillionths: 100_000 }).where(eq(taxRates.name, 'GST'));
      });
    }
    if (timing === 'waiver') {
      const sign = f.waivers.sign.bind(f.waivers);
      vi.spyOn(f.waivers, 'sign').mockImplementationOnce(async (...args) => {
        await edit(db.forGym); return sign(...args);
      });
    } else f.assigned.mockImplementationOnce(async scope => edit(scope));
    const { response } = await f.submit([adult()], 'fee-edit@example.invalid');
    expect(response.status, await response.clone().text()).toBe(200);
    const [home] = await f.joined(), state = await f.rows();
    const revised = timing === 'waiver', description = revised ? 'Revised plan' : f.plan.name;
    expect(state.lines.find(line => line.householdId === home!.id && line.kind === 'signup_fee'))
      .toMatchObject({ amountCents: revised ? 7_000 : 5_000, description: expect.stringContaining(description) });
    expect(state.lines.find(line => line.householdId === home!.id && line.kind === 'membership')!.description).toBe(description);
    expect(state.invoices.find(bill => bill.householdId === home!.id)!.amountCents).toBe(revised ? 24_200 : 21_000);
    expect(state.audits.find(event => event.action === 'billing.membership.assigned')!.after)
      .toMatchObject({ billing: { description, signupFeeCents: revised ? 7_000 : 5_000,
        taxes: [{ rateMillionths: revised ? 100_000 : 50_000 }] } });
  });
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
    f.assigned.mockImplementation(async scope => {
      await scope(f.gymId, tx => tx.update(plans).set({ trialDays: after }).where(eq(plans.id, plan.id)));
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
    f.assigned.mockImplementation(async scope => {
      await scope(f.gymId, tx => tx.update(plans).set({ amountCents: after }).where(eq(plans.id, plan.id)));
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
  it('drops an abandoned join\'s listed number on cleanup and keeps it when cleanup is refused or another record holds it', async () => {
    const f = await fixture();
    const cleaned = '+16045550123', kept = '+16045550144', shared = '+16045550155';
    const admitWithPhone = async (email: string, phone: string) => {
      const response = await f.post('/join/signatures', {
        planId: f.plan.id, contact: { name: 'Pat Payer', email, phone }, honeypot: '',
        members: [{ member: adult(), signatures: f.templates.map(template => ({
          templateId: template.id, templateVersion: template.version, pngBase64, signer: { kind: 'self', name: 'Avery Joiner' },
        })) }],
      });
      expect(response.status).toBe(200);
    };
    await admitWithPhone('cleaned-stop@example.invalid', '(604) 555-0123');
    await admitWithPhone('kept-stop@example.invalid', '(604) 555-0144');
    await admitWithPhone('shared-stop@example.invalid', '(604) 555-0155');
    // Attach staff work to the second admission so cleanup refuses it, and give another member the third number.
    const rows = await f.rows();
    const keptHome = rows.homes.find(h => h.email === 'kept-stop@example.invalid')!;
    const keptMember = rows.members.find(m => m.householdId === keptHome.id)!;
    await factory('leads', f.gymId, { memberId: keptMember.id });
    await factory('members', f.gymId, { householdId: f.existingHome.id, phone: '(604) 555-0155', phoneE164: shared });
    for (const phoneE164 of [cleaned, kept, shared]) await factory('smsOptedOutNumbers', f.gymId, { phoneE164 });
    await factory('smsOptedOutNumbers', f.otherGym, { phoneE164: cleaned });
    f.clock.set('2026-10-31T07:00:00Z');
    expect(await f.join.cleanup.run(f.gymId, timezone)).toBe(2);
    const listed = (gymId: string) => db.forGym(gymId, tx => tx.select({ phoneE164: smsOptedOutNumbers.phoneE164 }).from(smsOptedOutNumbers))
      .then(list => list.map(row => row.phoneE164).sort());
    expect(await listed(f.gymId)).toEqual([kept, shared].sort());
    expect(await listed(f.otherGym)).toEqual([cleaned]);
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
  it('spends no intake allowance on invalid plan, templates, PNG, code, or unavailable billing', async () => {
    const f = await fixture(), store = createIntakeRateLimitStore(db.forSystem), reserve = vi.spyOn(store, 'reserve');
    const reset = configureSharedRateLimits(store);
    const input = { planId: f.plan.id, contact: { name: 'Pat Payer', email: 'validation@example.invalid' }, honeypot: '',
      members: [{ member: adult(), signatures: f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64,
        signer: { kind: 'self' as const, name: 'Avery Joiner' } })) }] };
    try {
      for (const bad of [
        { ...input, planId: uuidv7() },
        { ...input, members: input.members.map(m => ({ ...m, signatures: m.signatures.map(s => ({ ...s, templateVersion: 999 })) })) },
        { ...input, members: input.members.map(m => ({ ...m, signatures: m.signatures.map(s => ({ ...s, pngBase64: Buffer.from('invalid PNG').toString('base64') })) })) },
        { ...input, code: 'UNKNOWN-CODE' },
      ]) expect((await f.post('/join/signatures', bad)).status).toBeGreaterThanOrEqual(400);
      f.paymentsConfigured.mockResolvedValue(false);
      expect((await f.post('/join/signatures', input)).status).toBe(503);
      expect(reserve).not.toHaveBeenCalled(); expect(await f.joined()).toHaveLength(0);
      f.paymentsConfigured.mockResolvedValue(true);
      expect((await f.post('/join/signatures', input)).status).toBe(200);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ gymId: f.gymId, buckets: expect.arrayContaining([
        expect.objectContaining({ routeKey: 'public.intake.participants', amount: 1 }),
        expect.objectContaining({ routeKey: 'public.intake.signature_kib', amount: Math.ceil(f.templates.length * png.length / 1024) }),
      ]) }));
    } finally { reset(); }
  });

  it('uses the short busy retry for a failed intake counter on JSON and native join', async () => {
    const f = await fixture(), store = createIntakeRateLimitStore(db.forSystem);
    const reserve = vi.spyOn(store, 'reserve').mockImplementation(async ({ now }) => ({ allowed: false, resetAt: now + 3_600_000, failed: true }));
    const reset = configureSharedRateLimits(store);
    try {
      const reply = await f.post('/join/signatures', { planId: f.plan.id, contact: { name: 'Pat Payer', email: 'busy@example.invalid' }, honeypot: '',
        members: [{ member: adult(), signatures: f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64,
          signer: { kind: 'self', name: 'Avery Joiner' } })) }] });
      expect(reply.status).toBe(429); expect(reply.headers.get('retry-after')).toBe('1');
      expect(await reply.json()).toMatchObject({ error: { code: 'rate_limited', message: expect.stringContaining('Wait a moment'), details: { reason: ['busy'] } } });
      const native = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: nativeForm(f, f.plan.id, 'native-busy@example.invalid') }));
      expect(native.status).toBe(429); expect(native.headers.get('retry-after')).toBe('1');
      expect(await native.text()).toContain('Wait a moment');
      expect(await f.joined()).toHaveLength(0); expect(reserve).toHaveBeenCalledTimes(2);
    } finally { reset(); }
  });

  it('applies the shared gym ceiling to JSON and native join creation without refusing an existing admission', async () => {
    const f = await fixture(), people = [adult()], email = 'existing-admission@example.invalid';
    const images = await f.admit(people, email, f.plan.id), store = createIntakeRateLimitStore(db.forSystem);
    const now = f.clock.now().getTime(), start = Math.floor(now / publicIntakeLimits.windowMs) * publicIntakeLimits.windowMs;
    await store.reserve({ gymId: f.gymId, now, buckets: [{ routeKey: 'public.intake.signature_kib', amount: publicIntakeLimits.signatureKiB,
      limit: publicIntakeLimits.signatureKiB, start, resetAt: start + publicIntakeLimits.windowMs }] });
    const reset = configureSharedRateLimits(store);
    try {
      const response = await f.post('/join/signatures', { planId: f.plan.id, contact: { name: 'Pat Payer', email: 'refused@example.invalid' }, honeypot: '',
        members: people.map(member => ({ member, signatures: f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64, signer: { kind: 'self', name: 'Pat Payer' } })) })) });
      expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('3600');
      expect(await response.json()).toMatchObject({ error: { code: 'rate_limited', message: expect.stringContaining('online forms are busy') } });
      const native = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: nativeForm(f, f.plan.id, 'native@example.invalid') }));
      expect(native.status).toBe(429); expect(native.headers.get('retry-after')).toBe('3600');
      expect(await native.text()).toContain('online forms are busy');
      expect((await f.post('/api/public/join', f.body(people, images, email, f.plan.id))).status).toBe(200);
      expect(await f.joined()).toHaveLength(1);
    } finally { reset(); }
  });

  it('labels the phone country choice in words on the join form and its refused redisplay', async () => {
    const f = await fixture(), page = await f.get(`/join?plan=${f.plan.id}&members=1`), html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('data-join-form');
    expect(html).toContain('>Country code<');
    expect(html).toContain('>Choose a country<');
    expect(html).not.toMatch(/\b(shell|public|waivers)\/[a-z-]+:[A-Za-z]/);
    const form = nativeForm(f, f.plan.id, 'labels@example.invalid'); form.set('contactName', 'x'.repeat(201));
    const refused = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    const redisplay = await refused.text();
    expect(refused.status).toBe(400);
    expect(redisplay).toContain('data-join-form');
    expect(redisplay).toContain('>Country code<');
    expect(redisplay).not.toMatch(/\b(shell|public|waivers)\/[a-z-]+:[A-Za-z]/);
  });
  it('keeps native join drafts and identifies missing signatures and consent without saving a household', async () => {
    const f = await fixture(), form = nativeForm(f, f.plan.id, 'draft@example.invalid');
    form.set('contactName', 'Pat <Payer>'); form.set('phone', '555-0123'); form.set('code', 'TRYAGAIN');
    form.set('waiver-0-0-kind', 'guardian'); form.set('waiver-0-0-name', 'Pat <Payer>'); form.set('waiver-0-0-relationship', 'Parent');
    form.delete('waiver-0-0-image'); form.delete('waiver-0-0-consent');
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain('role="alert"');
    expect(html).toContain('tabindex="-1" autofocus');
    expect(html).toContain(f.templates[0]!.name + ': choose a PNG signature image');
    expect(html).toContain(f.templates[0]!.name + ': agree to the document');
    for (const value of ['Pat &lt;Payer&gt;', 'draft@example.invalid', '555-0123', 'Avery', 'Native', '1990-01-02', 'Parent', 'TRYAGAIN']) expect(html).toContain('value="' + value + '"');
    expect(html).toContain('value="guardian" selected');
    expect(html).toContain('signature files must be selected again');
    expect(html).not.toContain('<Payer>'); expect(html).not.toContain(pngBase64);
    expect((await f.joined()).some(home => home.email === 'draft@example.invalid')).toBe(false);
  });
  it.each([
    ['not a PNG', 'waiver-0-0-image', 'not an image', 'choose a valid, supported PNG'],
    ['corrupt PNG', 'waiver-0-0-image', png.subarray(0, 40), 'choose a valid, supported PNG'],
    ['oversized image', 'waiver-0-0-image', Buffer.alloc(256 * 1024 + 1), 'choose a PNG signature image'],
    ['missing consent', 'waiver-0-0-consent', '', 'agree to the document'],
    ['minor self-signing', 'member-0-dateOfBirth', '2016-05-06', 'a parent or legal guardian must sign'],
    ['future birth date', 'member-0-dateOfBirth', '2099-01-01', 'date of birth must not be in the future'],
    ['invalid email', 'email', 'invalid', 'Check Email.'],
    ['missing signer', 'waiver-0-0-name', '', 'Check Person 1: Signer full name.'],
    ['long signer', 'waiver-0-0-name', 'x'.repeat(201), 'Check Person 1: Signer full name.'],
    ['long contact', 'contactName', 'x'.repeat(201), 'Check Contact or parent/guardian name.'],
    ['long phone', 'phone', 'x'.repeat(101), 'Check Phone (optional).'],
    ['long first name', 'member-0-firstName', 'x'.repeat(201), 'Check Person 1: First name.'],
    ['long last name', 'member-0-lastName', 'x'.repeat(201), 'Check Person 1: Last name.'],
    ['long guardian relationship', 'waiver-0-0-relationship', 'x'.repeat(101), 'Relationship to participant'],
    ['missing guardian relationship', 'waiver-0-0-relationship', '', 'Relationship to participant'],
  ] as const)('explains the native refusal for %s without creating an admission', async (_reason, field, value, message) => {
    const f = await fixture(), form = nativeForm(f, f.plan.id, 'bad-form@example.invalid');
    if (field.endsWith('-image')) form.set(field, new File([value], 'signature.png', { type: 'image/png' }));
    else form.set(field, String(value));
    if (field.endsWith('-relationship')) form.set('waiver-0-0-kind', 'guardian');
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
    expect(html).toContain('data-join-form');
    expect(await f.joined()).toHaveLength(0);
  });
  it.each(['', 'March 3'])('names only the birth date field when it is %j, without age-based problems', async dateOfBirth => {
    const f = await fixture(), form = nativeForm(f, f.plan.id, 'no-birth-date@example.invalid');
    form.set('member-0-dateOfBirth', dateOfBirth);
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain('Check Person 1: Date of birth.');
    expect(html).not.toContain('a parent or legal guardian must sign for anyone under 18');
    expect(html).not.toContain('date of birth must not be in the future');
    expect(await f.joined()).toHaveLength(0);
  });
  it('groups parallel PNG and field problems by person and document', async () => {
    const f = await fixture(), form = nativeForm(f, f.plan.id, 'ordered@example.invalid');
    form.set('members', '2');
    for (const [name, value] of [...form]) {
      if (name.startsWith('member-0-') || name.startsWith('waiver-0-')) form.set(name.replace('-0-', '-1-'), value);
    }
    form.set('member-1-firstName', 'x'.repeat(201));
    for (const i of [0, 1]) for (const j of [0, 1]) {
      form.delete(`waiver-${i}-${j}-consent`);
      form.set(`waiver-${i}-${j}-image`, new File(['invalid PNG'], 'signature.png', { type: 'image/png' }));
    }
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    expect(response.status).toBe(400); const html = await response.text();
    const messages = [
      'Person 1: Conduct: agree to the document', 'Person 1: Conduct: choose a valid, supported PNG',
      'Person 1: Participation: agree to the document', 'Person 1: Participation: choose a valid, supported PNG',
      'Check Person 2: First name.', 'Person 2: Conduct: agree to the document', 'Person 2: Conduct: choose a valid, supported PNG',
      'Person 2: Participation: agree to the document', 'Person 2: Participation: choose a valid, supported PNG',
    ];
    let previous = -1;
    for (const message of messages) { const index = html.indexOf(message); expect(index, message).toBeGreaterThan(previous); previous = index; }
  });
  it.each(['join', 'state', 'firstInvoice'] as const)('asks for gym help after admission when %s refuses', async step => {
    const f = await fixture(), form = nativeForm(f, f.plan.id, 'already-admitted@example.invalid');
    const admit = vi.spyOn(f.join, 'admit');
    vi.spyOn(f.join, step).mockRejectedValueOnce(new AppError('conflict', 'Interrupted after admission'));
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain('We received your details');
    expect(html).toContain('Do not submit another form');
    expect(html).not.toContain('Start again');
    expect(html).not.toContain('data-join-form');
    expect(html).not.toContain('role="alert"');
    expect(admit).toHaveBeenCalledTimes(1);
    expect(await f.joined()).toHaveLength(1);
  });
  it.each(['unavailable', 'unexpected'] as const)('preserves the %s error status after admission', async kind => {
    const f = await fixture();
    vi.spyOn(f.join, 'join').mockRejectedValueOnce(kind === 'unavailable' ? new AppError('unavailable', 'Provider offline') : new Error('Unexpected fault'));
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: nativeForm(f, f.plan.id, 'outage@example.invalid') }));
    const html = await response.text();
    expect(response.status).toBe(kind === 'unavailable' ? 503 : 500);
    if (kind === 'unavailable') {
      expect(html).toContain('Online joining is temporarily unavailable');
      expect(html).toContain('We received your details');
      expect(html).not.toContain('Start again');
    }
    expect(html).not.toContain('We could not save your details');
    expect(await f.joined()).toHaveLength(1);
  });
  it('reuses the first ready result for admission and validation redisplay, but refreshes a conflict', async () => {
    const f = await fixture(), ready = vi.spyOn(f.join, 'ready'), templates = vi.spyOn(f.waivers, 'listTemplates');
    const send = async (form: FormData) => f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    const invalid = nativeForm(f, f.plan.id, 'invalid@example.invalid'); invalid.set('contactName', 'x'.repeat(201));
    expect((await send(invalid)).status).toBe(400);
    expect(ready).toHaveBeenCalledTimes(1); expect(templates).toHaveBeenCalledTimes(1);
    ready.mockClear(); templates.mockClear();
    vi.spyOn(f.join, 'admit').mockRejectedValueOnce(new AppError('conflict', 'Changed template'));
    expect((await send(nativeForm(f, f.plan.id, 'conflict@example.invalid'))).status).toBe(400);
    expect(ready).toHaveBeenCalledTimes(2); expect(templates).toHaveBeenCalledTimes(2);
    ready.mockClear(); templates.mockClear();
    expect((await send(nativeForm(f, f.plan.id, 'received@example.invalid'))).status).toBe(200);
    expect(ready).toHaveBeenCalledTimes(1); expect(templates).toHaveBeenCalledTimes(2); // join rechecks before signing.
  });
  it('explains a changed document set on a native refusal that also names the missing signatures', async () => {
    const f = await fixture(), form = nativeForm(f, f.plan.id, 'changed-set@example.invalid');
    // The page the visitor saw held only the first document; the gym's current set has two.
    for (const name of ['template', 'version', 'kind', 'name', 'consent', 'image']) form.delete('waiver-0-1-' + name);
    const response = await f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain('The waivers or membership have changed');
    expect(html).toContain(f.templates[1]!.name + ': choose a PNG signature image');
    expect((await f.joined()).some(home => home.email === 'changed-set@example.invalid')).toBe(false);
  });
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
    expect(html).toContain('12 Mat Street'); expect(html).toContain('href="tel:+16045550100"'); expect(html).toContain('href="mailto:hello@north.example.test"');
    expect(html).toContain('Adult monthly'); expect(html).toContain('Annual'); expect(html).toContain('$150.00\u00a0+\u00a0tax per month'); expect(html).toMatch(/Sign-up fee: [A-Z]*\$50\.00\u00a0\+\u00a0tax/);
    expect(html).toContain('Trial plan'); expect(html).toContain('Free plan'); expect(html).toContain('href="/join"');
    for (const hidden of ['Retired plan', 'Private other plan', 'Private']) expect(html).not.toContain(hidden);
    expect(list.headers.get('content-security-policy')).toContain("form-action 'self'"); expect(list.headers.get('cache-control')).toBe('no-store');
    expect(list.headers.get('content-security-policy')).toMatch(/; report-uri \/csp-report; report-to csp$/);
    expect(list.headers.get('reporting-endpoints')).toBe('csp="/csp-report"');
    const form = await (await f.get(`/join?plan=${f.plan.id}&members=2`)).text();
    expect(form).toContain('href="mailto:hello@north.example.test"');
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
      expect(text).not.toContain('North &lt;Gym&gt;'); expect(text).not.toContain('North <Gym>'); expect(text).not.toContain('Adult monthly'); expect(text).not.toContain(f.plan.id);
    }
    expect((await f.get('/join/client.js')).headers.get('content-type')).toContain('text/javascript');
    f.paymentsConfigured.mockResolvedValue(false);
    const unavailable = await f.get('/join');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.text()).toContain('Online joining is not available right now');
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ billingEnabled: false }).where(eq(gyms.id, f.gymId)));
    const billingOff = await f.get('/join');
    expect(billingOff.status).toBe(200);
    expect(await billingOff.text()).toContain('Online joining is not available right now');
  });

  it('answers 503 with the not-available page and logs the error name once when checking Stripe fails on /join', async () => {
    const { setLogSink } = await import('../../core/log.js');
    const f = await fixture();
    const lines: string[] = [];
    const restore = setLogSink(line => lines.push(line));
    try {
      f.paymentsConfigured.mockRejectedValueOnce(new Error('secret key material'));
      const response = await f.get('/join');
      expect(response.status).toBe(503);
      const html = await response.text();
      expect(html).toContain('Online joining is not available right now');
      expect(html).not.toContain('secret key material');
      const entries = lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.event === 'join.payments_read_failed');
      expect(entries).toEqual([{ time: expect.any(String), level: 'warn', event: 'join.payments_read_failed', gymId: f.gymId, error: 'Error' }]);
      expect(lines.join('\n')).not.toContain('secret key material');
    } finally { setLogSink(restore); }
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

  it('keeps the family active and able to sign in while its PAD invoice enters dunning', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ bankDebitsEnabled: true }).where(eq(gyms.id, f.gymId)));
    const { cookie } = await f.submit([adult(), child()]);
    const redirect = await f.get('/join/checkout', cookie), sessionId = new URL(redirect.headers.get('location')!).pathname.slice(1);
    const session = f.provider.completeCheckout(sessionId, { method: 'acss_debit' });
    await f.webhook(sessionId); await f.webhook(sessionId);
    const state = await f.rows(), invoice = state.invoices.find(row => row.id === session.metadata.invoiceId)!;
    expect(invoice.status).toBe('processing');
    expect(state.memberships.filter(row => row.householdId === invoice.householdId).map(row => row.status)).toEqual(['active', 'active']);
    expect(state.methods).toMatchObject([{ type: 'acss_debit', bankName: 'STRIPE TEST BANK', last4: '6789', mandateId: session.mandateId, isDefault: true }]);
    const link = state.links.find(row => row.id === session.metadata.linkId)!;
    expect(link.usedAt).not.toBeNull();
    expect(await f.join.state(f.gymId, link.id)).toMatchObject({ status: 'active', processing: true });
    expect(await (await f.get('/join/return', cookie)).text()).toContain('Your bank payment is processing.');
    expect(await (await f.post('/join/sign-in', undefined, cookie)).text()).toContain('Your bank payment is processing.');
    f.provider.settleCharge(session.chargeId!, 'insufficient_funds');
    await f.webhook(sessionId, 'checkout.session.async_payment_failed');
    await f.webhook(sessionId, 'checkout.session.async_payment_failed');
    const failed = await f.rows();
    expect(failed.invoices.find(row => row.id === invoice.id)?.status).toBe('past_due');
    expect(failed.memberships.filter(row => row.householdId === invoice.householdId).map(row => row.status)).toEqual(['active', 'active']);
    const joinState = await f.join.state(f.gymId, link.id);
    expect(joinState).toMatchObject({ status: 'active' });
    expect(joinState).not.toHaveProperty('processing');

    const returned = await f.get('/join/return', cookie);
    expect(returned.status).toBe(200);
    const welcome = await returned.text();
    expect(welcome).toContain('If this address can receive a portal login, a sign-in link is on its way.');
    expect(welcome).not.toContain('data-join-confirming');
    expect(welcome).not.toContain('Your bank payment is processing.');

    const sentBeforeResend = f.sent.length;
    const resent = await f.post('/join/sign-in', undefined, cookie);
    expect(resent.status).toBe(200);
    const confirmation = await resent.text();
    expect(confirmation).toContain('Use the newest email');
    expect(confirmation).not.toContain('data-join-confirming');
    expect(confirmation).not.toContain('Your bank payment is processing.');
    await f.drain();
    expect(f.sent).toHaveLength(sentBeforeResend + 1);
    expect(f.mail.messages.filter(message => message.text.includes("didn't go through"))).toHaveLength(1);
  });

  it('uses the pay link and starts the join memberships when the bank method has no last four digits', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ bankDebitsEnabled: true }).where(eq(gyms.id, f.gymId)));
    const { cookie } = await f.submit([adult(), child()]);
    const redirect = await f.get('/join/checkout', cookie);
    expect(redirect.status).toBe(303);
    const sessionId = new URL(redirect.headers.get('location')!).pathname.slice(1);
    const session = f.provider.completeCheckout(sessionId, { method: 'acss_debit' });
    f.provider.recordPaymentMethod({ id: session.paymentMethodId!, customerId: session.customerId, last4: '' });

    await f.webhook(sessionId);
    await f.webhook(sessionId);

    const state = await f.rows(), invoice = state.invoices.find(row => row.id === session.metadata.invoiceId)!;
    const link = state.links.find(row => row.id === session.metadata.linkId)!;
    expect(invoice.status).toBe('processing');
    expect(link.usedAt).toEqual(f.clock.now());
    expect(state.memberships.filter(row => row.householdId === invoice.householdId).map(row => row.status)).toEqual(['active', 'active']);
    expect(state.methods).toEqual([]);
    expect(state.audits.filter(row => row.action === 'signed_link.used' && row.targetId === link.id)).toHaveLength(1);
    expect(state.audits.filter(row => row.action === 'billing.invoice.processing' && row.targetId === invoice.id)).toHaveLength(1);
    expect(await f.join.state(f.gymId, link.id)).toMatchObject({ status: 'active', processing: true });
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
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=7200']) expect(header).toContain(part);
    expect(header).not.toContain('Path=/join');
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
    expect(welcome).toContain('If this address can receive a portal login, a sign-in link is on its way.'); expect(welcome).not.toContain('payer@example.invalid');
    // Once settled, the same URL no longer carries the marker, which is what ends the script's polling.
    expect(welcome).not.toContain('data-join-confirming');
    expect(await (await f.post('/join/sign-in', undefined, cookie)).text()).toContain('Use the newest email');
    await f.drain();
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

  it('ends a completed card join and stops resending when all its memberships are cancelled', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult(), child()]);
    await f.pay(cookie);
    const state = await f.rows(), [link] = state.links;
    const joinedMemberships = state.memberships.filter(row => row.householdId === link!.householdId);
    expect(joinedMemberships.map(row => row.status)).toEqual(['active', 'active']);
    const cancel = (id: string) => db.forGym(f.gymId, tx => tx.update(memberships)
      .set({ status: 'cancelled', cancelledAt: f.clock.now() }).where(eq(memberships.id, id)));

    await cancel(joinedMemberships[0]!.id);
    expect(await f.join.state(f.gymId, link!.id)).toMatchObject({ status: 'active' });
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');

    await cancel(joinedMemberships[1]!.id);
    const sentBeforeResend = f.sent.length;
    expect(sentBeforeResend).toBe(1);
    expect(await f.join.state(f.gymId, link!.id)).toEqual({ status: 'ended' });
    const returned = await f.get('/join/return', cookie);
    expect(returned.status).toBe(200);
    const html = await returned.text();
    expect(html).toContain('This membership has ended');
    expect(html).toContain('The membership from this sign-up has ended');
    expect(html).toContain('Please contact the gym if you have questions');
    expect(html).not.toContain('The gym has closed this payment');
    expect(html).not.toContain('a sign-in link is on its way');
    expect(html).not.toContain('If this address can receive a portal login, a sign-in link is on its way.');
    const resent = await f.post('/join/sign-in', undefined, cookie);
    expect(resent.status).toBe(303);
    expect(resent.headers.get('location')).toBe('/join/return');
    expect(f.sent).toHaveLength(sentBeforeResend);
  });

  it('keeps a completed join with live memberships active after its first invoice is voided', async () => {
    const f = await fixture(), { cookie } = await f.submit();
    await f.pay(cookie);
    const state = await f.rows(), [link] = state.links;
    expect(state.memberships.map(row => row.status)).toEqual(['active']);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'void' }).where(eq(invoices.id, link!.invoiceId!)));
    expect(await f.join.state(f.gymId, link!.id)).toMatchObject({ status: 'active' });
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
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

  it.each(['single', 'multi'] as const)('sets the join cookie __Host- at Path=/ over HTTPS and continues an old one only in %s mode', async tenancy => {
    configureCookies({ hostPrefix: true, legacyNames: tenancy === 'single' });
    try {
      const f = await fixture(), { response, cookie } = await f.submit();
      expect(response.status).toBe(200);
      const header = response.headers.get('set-cookie')!;
      expect(header).toMatch(/^__Host-plaingym_join=/); expect(header).toMatch(/;\s*Path=\/(;|$)/); expect(header).toMatch(/;\s*Secure(;|$)/);
      expect(header).toMatch(/;\s*HttpOnly(;|$)/); expect(header).toMatch(/;\s*SameSite=Lax(;|$)/); expect(header).not.toMatch(/domain=/i);
      const missing = 'This browser no longer has your sign-up';
      const current = await f.get('/join/checkout', cookie);
      expect(current.headers.get('location')).not.toBeNull();
      // The cookie as an earlier version set it (unprefixed, at /join), or as another host could plant it in multi mode.
      const old = await f.get('/join/checkout', joinCookie + '=' + cookie.slice(appCookieName(joinCookie).length + 1));
      if (tenancy === 'single') expect(old.headers.get('location')).toBe(current.headers.get('location'));
      else { expect(old.headers.get('location')).toBeNull(); expect(await old.text()).toContain(missing); }
    } finally { configureCookies({ hostPrefix: false, legacyNames: false }); }
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

  it('completes the join through another household link and keeps it active after revocation while a membership is live', async () => {
    const f = await fixture(), { cookie } = await f.submit();
    const [home] = await f.joined(), before = await f.rows();
    const bill = before.invoices.find(i => i.householdId === home!.id)!, joinLink = before.links.find(l => l.invoiceId === bill.id)!;
    const links = createSignedLinksService({ scope: db.forGym, clock: f.clock });
    const system = { gymId: f.gymId, actor: { kind: 'system' as const } };
    const staff = await links.create(system,
      { purpose: 'pay_invoice', householdId: home!.id, invoiceId: bill.id, expiresAt: '2026-11-05T00:00:00Z' });
    const opened = await f.checkout.start(f.gymId, staff.link.id);
    f.provider.completeCheckout(opened.session.id);
    await f.webhook(opened.session.id);
    expect((await f.rows()).members.filter(m => m.householdId === home!.id).map(m => m.status)).toEqual(['active']);
    expect(f.afterCheckout).toHaveBeenCalledWith(f.gymId, staff.link.id, opened.session.id);
    expect(f.afterInvoicePaid).toHaveBeenCalledWith(f.gymId, bill.id);
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
    expect((await f.rows()).audits.filter(a => a.action === 'public.join.completed')).toHaveLength(1);
    expect(f.sent).toHaveLength(1);

    const revoked = await links.revoke(system, joinLink.id);
    expect(revoked.revokedAt).toBe(f.clock.now().toISOString());
    expect(await f.join.state(f.gymId, joinLink.id)).toMatchObject({ status: 'active' });
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');

    await db.forGym(f.gymId, tx => tx.update(memberships).set({ status: 'cancelled', cancelledAt: f.clock.now() })
      .where(eq(memberships.householdId, home!.id)));
    expect(await f.join.state(f.gymId, joinLink.id)).toEqual({ status: 'ended' });
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
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
    expect((await f.get('/join/checkout', cookie)).headers.get('location')).toBe('/join/return');
    // A retried command, a replayed effect and the Checkout hook all find the join complete.
    await f.transitions.manualPayment(context, cash); await f.drain();
    await f.join.afterInvoicePaid(f.gymId, bill.id);
    await f.join.afterCheckout(f.gymId, state.links.find(l => l.invoiceId === bill.id)!.id);
    state = await f.rows();
    expect(state.audits.filter(a => a.action === 'public.join.completed')).toHaveLength(1);
    expect(state.audits.filter(a => a.action === 'billing.member.activated')).toHaveLength(2);
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
    expect(await (await f.get('/join/return', cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
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
    expect(await (await f.get('/join/return', recording.cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
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
      expect(await (await f.get('/join/return', staffJoin.cookie)).text()).toContain('If this address can receive a portal login, a sign-in link is on its way.');
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

describe('promo codes on /join', () => {
  type Discount = Partial<typeof discounts.$inferInsert>;
  const withCode = async (f: Fixture, terms: Discount, gymId = f.gymId) => factory('discounts', gymId, { code: 'SPRING-20', ...terms });
  const discountRow = async (f: Fixture, id: string) => (await db.forGym(f.gymId, tx => tx.select().from(discounts).where(eq(discounts.id, id))))[0]!;
  const applications = (f: Fixture) => db.forGym(f.gymId, tx => tx.select().from(membershipDiscounts));
  const signed = (f: Fixture, person: Person) => f.templates.map(t => ({ templateId: t.id, templateVersion: t.version, pngBase64,
    signer: person.dateOfBirth > '2008-10-29' ? { kind: 'guardian' as const, name: 'Pat Payer', relationship: 'Parent' } : { kind: 'self' as const, name: person.firstName + ' Joiner' } }));
  const admitWith = (f: Fixture, people: Person[], email: string, code?: string, planId = f.plan.id) => f.post('/join/signatures', {
    planId, contact: { name: 'Pat Payer', email }, honeypot: '', ...(code === undefined ? {} : { code }),
    members: people.map(member => ({ member, signatures: signed(f, member) })) });
  /** Admits with the code and returns the submission body that repeats it. */
  async function admitted(f: Fixture, people: Person[], email: string, code: string, planId = f.plan.id) {
    const response = await admitWith(f, people, email, code, planId);
    expect(response.status, await response.clone().text()).toBe(200);
    return { ...f.body(people, joinAdmissionResponseSchema.parse(await response.json()).data, email, planId), code };
  }
  const household = async (f: Fixture, email: string) => (await f.joined()).find(h => h.email === email)!;
  const invoiceOf = async (f: Fixture, email: string) => {
    const home = await household(f, email), state = await f.rows(), bill = state.invoices.find(i => i.householdId === home.id)!;
    return { home, bill, lines: state.lines.filter(l => l.invoiceId === bill.id), state };
  };
  // Everything but the request ID: unknown, malformed, without a code, off, ended, used up, another plan and another gym's look the same.
  const neutral = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: unknown }).error });

  it('settles a rounded zero future cycle using the same pricing as the runner', async () => {
    const f = await fixture(), plan = await factory('plans', f.gymId, { amountCents: 1, currency: 'CAD', signupFeeCents: 0 });
    await withCode(f, { percentBasisPoints: 9999, duration: 'forever' });
    const body = await admitted(f, [adult()], 'rounded@example.invalid', 'SPRING-20', plan.id);
    const response = await f.post('/api/public/join', body);
    expect(response.status, await response.clone().text()).toBe(200);
    const { bill, state, home } = await invoiceOf(f, 'rounded@example.invalid');
    expect(bill).toMatchObject({ amountCents: 0, status: 'paid' });
    expect(state.links.find(l => l.householdId === home.id)!.purpose).toBe('pay_invoice');
  });

  it('bills the discounted first cycle, takes one use per person once, and a replay takes none', async () => {
    const f = await fixture(), discount = await withCode(f, { name: 'Spring', percentBasisPoints: 2000, duration: 'once', maxUses: 5 });
    const email = 'spring@example.invalid', body = await admitted(f, [adult(), adult('Blake')], email, 'spring-20');
    const first = await f.post('/api/public/join', body);
    expect(first.status, await first.clone().text()).toBe(200);
    expect((await f.post('/api/public/join', body)).status).toBe(200);
    expect((await discountRow(f, discount.id)).uses).toBe(2);
    const { bill, lines, state } = await invoiceOf(f, email);
    // Two people: (150.00 - 20%) and the 50.00 sign-up fee each, plus 5% GST.
    expect(lines.filter(l => l.kind === 'discount').map(l => [l.description, l.amountCents])).toEqual([['Spring', -3000], ['Spring', -3000]]);
    expect(lines.filter(l => l.kind === 'signup_fee')).toHaveLength(2);
    expect(bill.amountCents).toBe(35_700);
    // A once discount uses its cycle on the first full period, and completes.
    expect((await applications(f)).map(a => [a.cyclesLeft, a.endReason])).toEqual([[0, 'completed'], [0, 'completed']]);
    expect(state.audits.filter(a => a.action === 'billing.discount.uses_taken')).toHaveLength(1);
    expect(state.audits.filter(a => a.action === 'public.join.discounted')).toHaveLength(1);
    expect(state.audits.filter(a => a.action === 'billing.membership.discount_cycle_taken')).toHaveLength(2);
    // The review step shows the discounted first invoice before payment.
    const review = await f.get('/join/review', first.headers.get('set-cookie')!.split(';')[0]!);
    const page = await review.text();
    expect(review.status).toBe(200);
    expect(page).toContain('data-join-invoice'); expect(page).toContain('Spring'); expect(page).toContain('357.00');
    expect(page).toContain('href="/join/checkout"');
  });
  it('waives the sign-up fee on the first invoice for a fee-only code', async () => {
    const f = await fixture();
    const discount = await withCode(f, { code: 'NO-FEE', percentBasisPoints: null, duration: null, waivesSignupFee: true });
    const email = 'nofee@example.invalid', response = await f.post('/api/public/join', await admitted(f, [adult()], email, 'NO-FEE'));
    expect(response.status, await response.clone().text()).toBe(200);
    const { bill, lines } = await invoiceOf(f, email);
    expect(lines.map(l => l.kind).sort()).toEqual(['membership', 'tax']);
    expect(bill.amountCents).toBe(15_750);
    expect((await discountRow(f, discount.id)).uses).toBe(1);
    expect((await applications(f)).map(a => [a.waivesSignupFee, a.endReason])).toEqual([[true, 'completed']]);
  });
  it.each([['forever', 'pay_invoice', 'paid', 'active'], ['once', 'update_card', 'open', 'pending']] as const)(
    'settles a 100%% %s code with the fee waived as free only when nothing is charged later', async (duration, purpose, status, membership) => {
      const f = await fixture();
      await withCode(f, { code: 'ALL-FREE', percentBasisPoints: 10_000, duration, waivesSignupFee: true });
      const email = `free-${duration}@example.invalid`, response = await f.post('/api/public/join', await admitted(f, [adult()], email, 'ALL-FREE'));
      expect(response.status, await response.clone().text()).toBe(200);
      const { home, bill, state } = await invoiceOf(f, email);
      expect(bill).toMatchObject({ amountCents: 0, status });
      expect(state.links.find(l => l.householdId === home.id)?.purpose).toBe(purpose);
      expect(state.memberships.find(m => m.householdId === home.id)?.status).toBe(membership);
      expect(state.audits.some(a => a.action === 'public.join.completed' && a.targetId === home.id)).toBe(duration === 'forever');
      expect(state.methods).toEqual([]);
    });
  it('refuses a join for three with two uses left, taking none, and continues without the code', async () => {
    const f = await fixture(), discount = await withCode(f, { maxUses: 2 }), people = [adult(), adult('Blake'), child()];
    // At admission: nothing is written.
    expect((await admitWith(f, people, 'three@example.invalid', 'SPRING-20')).status).toBe(400);
    expect(await f.joined()).toEqual([]);
    // After admission, the uses run short: the submission is refused before anything is signed or taken.
    await db.forGym(f.gymId, tx => tx.update(discounts).set({ maxUses: 5 }).where(eq(discounts.id, discount.id)));
    const body = await admitted(f, people, 'three@example.invalid', 'SPRING-20');
    await db.forGym(f.gymId, tx => tx.update(discounts).set({ uses: 3 }).where(eq(discounts.id, discount.id)));
    const refused = await f.post('/api/public/join', body);
    expect(await neutral(refused)).toMatchObject({ status: 400, error: { details: { reason: ['code_refused'] } } });
    let state = await f.rows();
    expect((await discountRow(f, discount.id)).uses).toBe(3);
    expect(state.memberships).toEqual([]); expect(state.signatures).toEqual([]); expect(await applications(f)).toEqual([]);
    // Continuing without the code (the field cleared) reuses the admission.
    expect((await f.post('/api/public/join', { ...body, code: '' })).status).toBe(200);
    state = await f.rows();
    expect(state.memberships).toHaveLength(3); expect(await applications(f)).toEqual([]);
    expect(state.lines.filter(l => l.kind === 'discount')).toEqual([]);
    expect((await discountRow(f, discount.id)).uses).toBe(3);
  });
  it('gives every refused code the same answer, writes nothing, and never finds another gym\'s code', async () => {
    const f = await fixture();
    const named = await factory('discounts', f.gymId, { code: null, name: 'Staff-only' });
    await withCode(f, { code: 'TURNED-OFF', active: false });
    await withCode(f, { code: 'ENDED', endsOn: '2026-10-28' });
    await withCode(f, { code: 'USED-UP', maxUses: 1, uses: 1 });
    const annualOnly = await withCode(f, { code: 'ANNUAL-ONLY' });
    await factory('discountPlans', f.gymId, { discountId: annualOnly.id, planId: f.annual.id });
    await withCode(f, { code: 'OTHER-GYM' }, f.otherGym);
    const reference = await neutral(await admitWith(f, [adult()], 'unknown@example.invalid', 'NOPE-123'));
    expect(reference).toMatchObject({ status: 400, error: { code: 'invalid_request', details: { reason: ['code_refused'] } } });
    for (const code of ['50% off', 'ab', named.id, 'Staff-only', 'TURNED-OFF', 'ENDED', 'USED-UP', 'ANNUAL-ONLY', 'OTHER-GYM'])
      expect(await neutral(await admitWith(f, [adult()], `refused-${code.length}@example.invalid`, code)), code).toEqual(reference);
    // Ten admissions: the join admission limit for one gym and address.
    expect(await f.joined()).toEqual([]);
  });
  it('refuses at submission a code that was not admitted, or a different one, like an unknown code', async () => {
    const f = await fixture();
    await withCode(f, { code: 'OTHER-GYM' }, f.otherGym);
    const reference = await neutral(await admitWith(f, [adult()], 'unknown@example.invalid', 'NOPE-123'));
    await withCode(f, {});
    const images = await f.admit([adult()], 'later@example.invalid', f.plan.id);
    const late = await f.post('/api/public/join', { ...f.body([adult()], images, 'later@example.invalid', f.plan.id), code: 'SPRING-20' });
    expect(await neutral(late)).toEqual(reference);
    const other = await admitted(f, [adult()], 'swapped@example.invalid', 'SPRING-20');
    expect(await neutral(await f.post('/api/public/join', { ...other, code: 'OTHER-GYM' }))).toEqual(reference);
  });
  it('lets exactly one of two concurrent joins take the last use', async () => {
    const f = await fixture(), discount = await withCode(f, { maxUses: 1 });
    const bodies = [await admitted(f, [adult()], 'race-a@example.invalid', 'SPRING-20'), await admitted(f, [adult()], 'race-b@example.invalid', 'SPRING-20')];
    const statuses = (await Promise.all(bodies.map(body => f.post('/api/public/join', body)))).map(r => r.status);
    expect(statuses.sort()).toEqual([200, 400]);
    expect((await discountRow(f, discount.id)).uses).toBe(1);
    expect(await applications(f)).toHaveLength(1);
    expect((await f.rows()).memberships).toHaveLength(1);
  });
  it('takes a code on the native form, shows the discounted invoice, and refuses a bad code with the same page', async () => {
    const f = await fixture();
    await withCode(f, { name: 'Spring', percentBasisPoints: 2000, duration: 'forever' });
    const send = async (code: string, email: string) => {
      const form = nativeForm(f, f.plan.id, email);
      form.set('code', code);
      return f.server.request(await requestWithLength(origin + '/join', { method: 'POST', headers: { origin }, body: form }));
    };
    const accepted = await send('Spring-20', 'native-code@example.invalid'), page = await accepted.text();
    expect(accepted.status).toBe(200);
    expect(page).toContain('data-join-invoice'); expect(page).toContain('Spring');
    for (const code of ['NOPE-123', '%%']) {
      const refused = await send(code, 'native-refused@example.invalid');
      expect(refused.status).toBe(400); expect(await refused.text()).toContain('This code can');
    }
  });
});

it('keeps a paid staff-address join public response neutral and records refusals without identity data', async () => {
  const { setLogSink } = await import('../../core/log.js');
  const f = await fixture(), staffEmail = 'join-staff@example.invalid', ordinaryEmail = 'join-member@example.invalid';
  const staffUser = await factory('authUser', f.gymId, { email: staffEmail, name: 'Jordan Staff' });
  await factory('staffRoles', f.gymId, { userId: staffUser.id, role: 'admin' });
  const warnings: unknown[] = [];
  const restore = setLogSink(line => {
    const { event, ...fields } = JSON.parse(line) as Record<string, unknown>;
    if (event === 'public.join.sign_in_refused') warnings.push(fields);
  });
  try {
    const staff = await f.submit([adult()], staffEmail);
    expect(staff.response.status).toBe(200);
    const session = await f.pay(staff.cookie);
    await f.webhook(session);
    const staffHome = (await f.joined()).find(h => h.email === staffEmail)!;
    const audits = async (householdId: string) => (await f.rows()).audits.filter(a => a.targetType === 'household' && a.targetId === householdId);
    const refusals = async () => (await audits(staffHome.id)).filter(a => a.action === 'household_user.invite_refused');
    const checkRefusals = async (count: number) => {
      const records = await refusals();
      expect(records.map(({ before, after }) => ({ before, after }))).toEqual(
        Array.from({ length: count }, () => ({ before: null, after: { reason: 'staff_identity' } })));
      expect(warnings).toEqual(Array.from({ length: count }, () => ({ time: expect.any(String), level: 'warn', gymId: f.gymId, householdId: staffHome.id })));
      const serialized = JSON.stringify([records.map(({ before, after }) => ({ before, after })), warnings]);
      for (const value of [staffEmail, staffUser.id, staffUser.name]) expect(serialized).not.toContain(value);
    };
    expect(f.sent).toEqual([]);
    expect((await f.rows()).logins.filter(login => login.householdId === staffHome.id)).toEqual([]);
    await checkRefusals(1);
    const staffReturn = await f.get('/join/return', staff.cookie), staffPage = await staffReturn.text();
    expect(staffReturn.status).toBe(200);
    expect(staffPage).toContain('Your membership is active. If this address can receive a portal login, a sign-in link is on its way. Open it to set up your member portal login. If nothing arrives, contact the gym.');
    expect(staffPage).toContain('Send the sign-in link again');

    const resend = await f.post('/join/sign-in', undefined, staff.cookie);
    expect(resend.status).toBe(200);
    const staffResent = await resend.text();
    expect(staffResent).toContain('If your membership email can receive a portal login, a new sign-in link is on its way. Use the newest email.');
    // The resend only queues the sign-in: the refusal is the job's, after the response.
    expect(f.jobs.jobs.filter(job => job.name === 'public.join.sign_in')).toHaveLength(2);
    await checkRefusals(1);
    await f.drain();
    expect(f.sent).toEqual([]);
    await checkRefusals(2);

    const ordinary = await f.submit([adult()], ordinaryEmail);
    expect(ordinary.response.status).toBe(200);
    await f.pay(ordinary.cookie);
    expect(f.sent).toEqual([expect.objectContaining({ gymId: f.gymId, email: ordinaryEmail })]);
    const ordinaryHome = (await f.joined()).find(h => h.email === ordinaryEmail)!;
    const ordinaryActions = (await audits(ordinaryHome.id)).map(a => a.action);
    expect(ordinaryActions.filter(action => action === 'household_user.invited')).toHaveLength(1);
    expect(ordinaryActions).not.toContain('household_user.invite_refused');
    const ordinaryReturn = await f.get('/join/return', ordinary.cookie);
    expect(ordinaryReturn.status).toBe(staffReturn.status);
    expect(await ordinaryReturn.text()).toBe(staffPage);
    const ordinaryResend = await f.post('/join/sign-in', undefined, ordinary.cookie);
    expect(ordinaryResend.status).toBe(resend.status);
    expect(await ordinaryResend.text()).toBe(staffResent);
    expect(f.sent).toHaveLength(1);
    await f.drain();
    expect(f.sent).toEqual([expect.objectContaining({ email: ordinaryEmail }), expect.objectContaining({ email: ordinaryEmail })]);
    await checkRefusals(2);
  } finally {
    setLogSink(restore);
  }
});

describe('the passwordless sign-in leaves the request', () => {
  const signInJobs = (f: Fixture) => f.jobs.jobs.filter(job => job.name === joinSignInJob);
  /** Pays the join's Checkout and records it as the webhook handler does, without running any queued job. */
  async function complete(f: Fixture, email: string) {
    const { cookie } = await f.submit([adult()], email), checkout = await f.get('/join/checkout', cookie);
    const sessionId = new URL(checkout.headers.get('location')!).pathname.slice(1);
    f.provider.completeCheckout(sessionId);
    await f.webhook(sessionId, undefined, false);
    const home = (await f.joined()).find(h => h.email === email)!;
    return { cookie, home };
  }
  const completions = async (f: Fixture, householdId: string) => (await f.rows()).audits
    .filter(a => a.action === 'public.join.completed' && a.targetId === householdId);

  it('queues one sign-in with the completion for an ordinary address, and the job sends its link', async () => {
    const f = await fixture(), email = 'ordinary-join@example.invalid';
    const { home } = await complete(f, email);
    expect(await completions(f, home.id)).toHaveLength(1);
    expect(f.sent).toEqual([]);
    expect(signInJobs(f)).toMatchObject([{ payload: { householdId: home.id },
      options: { gymId: f.gymId, idempotencyKey: `join-sign-in:${home.id}:completed`, maxAttempts: 5 } }]);
    await f.drain();
    expect(f.sent).toEqual([expect.objectContaining({ gymId: f.gymId, email })]);
    // A replayed completion queues nothing more.
    await f.join.afterInvoicePaid(f.gymId, (await f.rows()).invoices.find(i => i.householdId === home.id)!.id);
    await f.drain();
    expect(signInJobs(f)).toHaveLength(1); expect(f.sent).toHaveLength(1);
  });

  it('queues the same sign-in for a staff login\'s address, whose job sends nothing and records the refusal', async () => {
    const f = await fixture(), email = 'staff-join@example.invalid';
    const staff = await factory('authUser', f.gymId, { email });
    await factory('staffRoles', f.gymId, { userId: staff.id, role: 'coach' });
    const { home } = await complete(f, email);
    expect(signInJobs(f)).toMatchObject([{ options: { idempotencyKey: `join-sign-in:${home.id}:completed` } }]);
    const refusals = async () => (await f.rows()).audits.filter(a => a.action === 'household_user.invite_refused' && a.targetId === home.id);
    expect(await refusals()).toEqual([]);
    await f.drain();
    expect(f.sent).toEqual([]);
    expect(await refusals()).toHaveLength(1);
    expect((await f.rows()).logins.filter(l => l.userId === staff.id)).toEqual([]);
  });

  it('answers a resend alike for a staff and an ordinary address, sending nothing before each answers', async () => {
    const f = await fixture(), staffEmail = 'staff-resend@example.invalid', ordinaryEmail = 'ordinary-resend@example.invalid';
    const staff = await factory('authUser', f.gymId, { email: staffEmail });
    await factory('staffRoles', f.gymId, { userId: staff.id, role: 'front_desk' });
    const staffJoin = await complete(f, staffEmail), ordinaryJoin = await complete(f, ordinaryEmail);
    await f.drain();
    expect(f.sent).toEqual([expect.objectContaining({ email: ordinaryEmail })]);
    const queuedFor = (householdId: string) => signInJobs(f).filter(job => (job.payload as { householdId: string }).householdId === householdId);
    const answers = [];
    for (const join of [staffJoin, ordinaryJoin]) {
      const before = queuedFor(join.home.id).length, response = await f.post('/join/sign-in', undefined, join.cookie);
      answers.push({ status: response.status, body: await response.text() });
      expect(f.sent).toHaveLength(1);
      expect(queuedFor(join.home.id)).toHaveLength(before + 1);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]!.status).toBe(200);
    await f.drain();
    expect(f.sent).toHaveLength(2);
    // Two resends queue two jobs, and each sends a link.
    for (let i = 0; i < 2; i++) expect((await f.post('/join/sign-in', undefined, ordinaryJoin.cookie)).status).toBe(200);
    expect(f.sent).toHaveLength(2);
    expect(queuedFor(ordinaryJoin.home.id).map(job => job.options.idempotencyKey)).toEqual([
      `join-sign-in:${ordinaryJoin.home.id}:completed`, expect.stringMatching(`^join-sign-in:${ordinaryJoin.home.id}:`),
      expect.stringMatching(`^join-sign-in:${ordinaryJoin.home.id}:`), expect.stringMatching(`^join-sign-in:${ordinaryJoin.home.id}:`)]);
    expect(new Set(queuedFor(ordinaryJoin.home.id).map(job => job.options.idempotencyKey)).size).toBe(4);
    await f.drain();
    expect(f.sent.slice(2)).toEqual([expect.objectContaining({ email: ordinaryEmail }), expect.objectContaining({ email: ordinaryEmail })]);
    expect(f.sent.filter(link => link.email === staffEmail)).toEqual([]);
  });

  it('queues no sign-in in password mode, where a resend is refused', async () => {
    const f = await fixture('password'), { home } = await complete(f, 'password-join@example.invalid');
    expect(await completions(f, home.id)).toHaveLength(1);
    await f.drain();
    const [link] = (await f.rows()).links.filter(l => l.householdId === home.id);
    await expect(f.join.resend(f.gymId, link!.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(signInJobs(f)).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it('retries a sign-in whose delivery fails, and the join stays completed', async () => {
    const f = await fixture(), email = 'retry-join@example.invalid';
    const accept = vi.spyOn(f.invitations, 'accept').mockRejectedValueOnce(new Error('SMTP unavailable'));
    const { home } = await complete(f, email);
    await f.drain();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([]);
    expect(signInJobs(f)).toMatchObject([{ status: 'queued', attempt: 1 }]);
    expect(await completions(f, home.id)).toHaveLength(1);
    expect((await f.rows()).memberships.filter(m => m.householdId === home.id).map(m => m.status)).toEqual(['active']);
    f.clock.advance(1000);
    await f.drain();
    expect(signInJobs(f)).toMatchObject([{ status: 'completed', attempt: 2 }]);
    expect(f.sent).toEqual([expect.objectContaining({ gymId: f.gymId, email })]);
    expect(await completions(f, home.id)).toHaveLength(1);
    // One live payer invitation stays: the retry's replaced the first attempt's.
    expect(await createPortalInvitationStore(() => db.system.db).outstanding(f.gymId, home.id, f.clock)).toHaveLength(1);
  });

  /** The sign-in job's skip and failure logs while `run` runs. */
  async function logged<T>(run: (lines: Record<string, unknown>[]) => Promise<T>) {
    const { setLogSink } = await import('../../core/log.js'), lines: Record<string, unknown>[] = [];
    const restore = setLogSink(line => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.event === 'public.join.sign_in_skipped' || parsed.event === 'public.join.sign_in_failed') lines.push(parsed);
    });
    try { return await run(lines); } finally { setLogSink(restore); }
  }
  const invited = async (f: Fixture, householdId: string) => (await f.rows()).audits
    .filter(a => a.action === 'household_user.invited' && a.targetId === householdId);
  /** A completion whose first sign-in attempt fails, leaving the job queued for its retry. */
  async function failedOnce(f: Fixture, email: string) {
    const accept = vi.spyOn(f.invitations, 'accept').mockRejectedValueOnce(new Error('SMTP unavailable'));
    const { home } = await complete(f, email);
    await f.drain();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(signInJobs(f)).toMatchObject([{ status: 'queued', attempt: 1 }]);
    expect(await invited(f, home.id)).toHaveLength(1);
    return { home, accept };
  }

  it('sends nothing on a retry after the join ended', async () => {
    const f = await fixture(), { home, accept } = await failedOnce(f, 'ended-retry@example.invalid');
    await db.forGym(f.gymId, tx => tx.update(memberships).set({ status: 'cancelled', cancelledAt: f.clock.now() }).where(eq(memberships.householdId, home.id)));
    const [link] = (await f.rows()).links.filter(l => l.householdId === home.id);
    expect(await f.join.state(f.gymId, link!.id)).toEqual({ status: 'ended' });
    await logged(async lines => {
      f.clock.advance(1000);
      await f.drain();
      expect(lines).toEqual([expect.objectContaining({ event: 'public.join.sign_in_skipped', level: 'info', gymId: f.gymId, householdId: home.id, reason: 'not_active' })]);
    });
    expect(signInJobs(f)).toMatchObject([{ status: 'completed', attempt: 2 }]);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([]);
    expect(await invited(f, home.id)).toHaveLength(1);
  });

  it('sends nothing on a retry after the gym switched to password mode', async () => {
    const f = await fixture(), { home, accept } = await failedOnce(f, 'password-retry@example.invalid');
    vi.spyOn(f.invitations, 'passwordRequired').mockResolvedValue(true);
    await logged(async lines => {
      f.clock.advance(1000);
      await f.drain();
      expect(lines).toEqual([expect.objectContaining({ event: 'public.join.sign_in_skipped', gymId: f.gymId, householdId: home.id, reason: 'password_mode' })]);
    });
    expect(signInJobs(f)).toMatchObject([{ status: 'completed', attempt: 2 }]);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([]);
    expect(await invited(f, home.id)).toHaveLength(1);
  });

  const confirmationRequests = async (f: Fixture, householdId: string) => (await f.rows()).audits
    .filter(a => a.action === 'household_user.confirmation_requested' && a.targetId === householdId);
  const awaitingConfirmation = (f: Fixture) => db.forGym(f.gymId, async tx => (await tx.select({ id: households.id }).from(households)
    .where(awaitingConfirmationCondition(tx, f.gymId))).map(row => row.id));
  const ended = (f: Fixture, householdId: string) => db.forGym(f.gymId, tx => tx.update(memberships)
    .set({ status: 'cancelled', cancelledAt: f.clock.now() }).where(eq(memberships.householdId, householdId)));

  it('asks staff to confirm the address on a retry after the gym switched to password mode', async () => {
    const f = await fixture(), { home, accept } = await failedOnce(f, 'password-confirm@example.invalid');
    expect(await confirmationRequests(f, home.id)).toEqual([]);
    vi.spyOn(f.invitations, 'passwordRequired').mockResolvedValue(true);
    await logged(async lines => {
      f.clock.advance(1000);
      await f.drain();
      expect(lines).toEqual([expect.objectContaining({ event: 'public.join.sign_in_skipped', gymId: f.gymId, householdId: home.id, reason: 'password_mode' })]);
    });
    expect(signInJobs(f)).toMatchObject([{ status: 'completed', attempt: 2 }]);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([]);
    expect(await invited(f, home.id)).toHaveLength(1);
    expect(await confirmationRequests(f, home.id)).toMatchObject([{ actorKind: 'system', targetType: 'household' }]);
    expect(await awaitingConfirmation(f)).toEqual([home.id]);
  });

  it('asks for no confirmation on a password-mode retry after the join ended', async () => {
    const f = await fixture(), { home, accept } = await failedOnce(f, 'password-ended@example.invalid');
    await ended(f, home.id);
    vi.spyOn(f.invitations, 'passwordRequired').mockResolvedValue(true);
    await logged(async lines => {
      f.clock.advance(1000);
      await f.drain();
      expect(lines).toEqual([expect.objectContaining({ event: 'public.join.sign_in_skipped', gymId: f.gymId, householdId: home.id, reason: 'password_mode' })]);
    });
    expect(signInJobs(f)).toMatchObject([{ status: 'completed', attempt: 2 }]);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([]);
    expect(await confirmationRequests(f, home.id)).toEqual([]);
    expect(await awaitingConfirmation(f)).toEqual([]);
  });

  it('leaves the failed attempt\'s invitation until it expires when a retry skips', async () => {
    const f = await fixture(), { home } = await failedOnce(f, 'skipped-invitation@example.invalid');
    await ended(f, home.id);
    await logged(async lines => {
      f.clock.advance(1000);
      await f.drain();
      expect(lines).toEqual([expect.objectContaining({ event: 'public.join.sign_in_skipped', householdId: home.id, reason: 'not_active' })]);
    });
    expect(await createPortalInvitationStore(() => db.system.db).outstanding(f.gymId, home.id, f.clock)).toHaveLength(1);
    expect(await confirmationRequests(f, home.id)).toEqual([]);
  });

  it('completes without sending for a household whose address or row is gone', async () => {
    const f = await fixture(), { home } = await complete(f, 'gone-join@example.invalid'), gone = uuidv7();
    await db.forGym(f.gymId, tx => tx.update(households).set({ email: null }).where(eq(households.id, home.id)));
    await f.jobs.enqueue(joinSignInJob, { householdId: gone }, { gymId: f.gymId, timezone });
    await logged(async lines => {
      await f.drain();
      expect(lines).toEqual([
        expect.objectContaining({ event: 'public.join.sign_in_skipped', gymId: f.gymId, householdId: home.id, reason: 'missing' }),
        expect.objectContaining({ event: 'public.join.sign_in_skipped', gymId: f.gymId, householdId: gone, reason: 'missing' })]);
    });
    expect(signInJobs(f)).toMatchObject([{ status: 'completed', attempt: 1 }, { status: 'completed', attempt: 1 }]);
    expect(f.sent).toEqual([]);
    expect(await invited(f, home.id)).toEqual([]);
  });

  it('logs a delivery that fails every attempt once, on the last', async () => {
    const f = await fixture(), accept = vi.spyOn(f.invitations, 'accept').mockRejectedValue(new Error('SMTP unavailable'));
    const { home } = await complete(f, 'always-failing@example.invalid');
    await logged(async lines => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        await f.drain();
        expect(signInJobs(f)).toMatchObject([{ attempt, status: attempt < 5 ? 'queued' : 'failed' }]);
        expect(lines).toEqual(attempt < 5 ? [] : [expect.objectContaining({ event: 'public.join.sign_in_failed', level: 'warn', gymId: f.gymId, householdId: home.id, attempt: 5 })]);
        f.clock.advance(60_000);
      }
    });
    expect(accept).toHaveBeenCalledTimes(5);
    expect(f.sent).toEqual([]);
  });

  it('runs a sign-in whose payload carries a key this release does not know', async () => {
    const f = await fixture(), email = 'extra-key@example.invalid', { home } = await complete(f, email);
    await f.drain();
    expect(f.sent).toHaveLength(1);
    await f.jobs.enqueue(joinSignInJob, { householdId: home.id, extra: 1 }, { gymId: f.gymId, timezone, idempotencyKey: 'extra-key' });
    await f.drain();
    expect(signInJobs(f)).toMatchObject([{ status: 'completed' }, { status: 'completed', attempt: 1 }]);
    expect(f.sent).toEqual([expect.objectContaining({ email }), expect.objectContaining({ gymId: f.gymId, email })]);
  });
});

describe('join return page after a membership ends', () => {
  const joined = async (f: Fixture) => {
    const state = await f.rows(), [link] = state.links;
    return { link: link!, rows: state.memberships.filter(row => row.householdId === link!.householdId),
      bill: state.invoices.find(row => row.householdId === link!.householdId)! };
  };
  const update = (f: Fixture, id: string, values: { status?: 'pending' | 'trial' | 'active' | 'frozen' | 'cancelled'; cancelledAt?: Date | null; frozenAt?: Date | null }) =>
    db.forGym(f.gymId, tx => tx.update(memberships).set(values).where(eq(memberships.id, id)));
  // A member erased or a membership row removed: the invoice lines keep their own snapshot and no longer name it.
  const remove = (f: Fixture, id: string) => db.forGym(f.gymId, async tx => {
    await tx.update(invoiceLineItems).set({ membershipId: null }).where(eq(invoiceLineItems.membershipId, id));
    await tx.delete(membershipDiscounts).where(eq(membershipDiscounts.membershipId, id));
    await tx.delete(memberships).where(eq(memberships.id, id));
  });
  const finishCard = async (f: Fixture, cookie: string) => {
    const response = await f.get('/join/checkout', cookie);
    expect(response.status).toBe(303);
    const sessionId = new URL(response.headers.get('location')!).pathname.slice(1);
    f.provider.completeCheckout(sessionId);
    await f.webhook(sessionId);
    await f.webhook(sessionId);
  };

  it('shows the welcome page while one membership row remains and the ended page once none do', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult(), child()]);
    await f.pay(cookie);
    const before = await joined(f);
    expect(before.rows.map(row => row.status)).toEqual(['active', 'active']);
    await remove(f, before.rows[0]!.id);
    const welcome = await f.get('/join/return', cookie);
    expect(welcome.status).toBe(200);
    const welcomeHtml = await welcome.text();
    expect(welcomeHtml).toContain('a sign-in link is on its way');
    expect(welcomeHtml).not.toContain('This membership has ended');
    await remove(f, before.rows[1]!.id);
    expect(await f.join.state(f.gymId, before.link.id)).toEqual({ status: 'ended' });
    const ended = await f.get('/join/return', cookie);
    expect(ended.status).toBe(200);
    const endedHtml = await ended.text();
    expect(endedHtml).toContain('This membership has ended');
    expect(endedHtml).toContain('The membership from this sign-up has ended');
    expect(endedHtml).not.toContain('The gym has closed this payment');
    expect(endedHtml).not.toContain('Confirming');
  });

  it('treats one pending membership of a completed settled join as welcome and falls back when the invoice is open', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult(), child()]);
    await f.pay(cookie);
    const { link, rows, bill } = await joined(f);
    await update(f, rows[0]!.id, { status: 'pending', cancelledAt: null, frozenAt: null });
    await update(f, rows[1]!.id, { status: 'cancelled', cancelledAt: f.clock.now() });
    expect(await f.join.state(f.gymId, link.id)).toMatchObject({ status: 'active' });
    const welcome = await f.get('/join/return', cookie);
    expect(welcome.status).toBe(200);
    const welcomeHtml = await welcome.text();
    expect(welcomeHtml).toContain('a sign-in link is on its way');
    expect(welcomeHtml).not.toContain('Confirming your payment');
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'open' }).where(eq(invoices.id, bill.id)));
    expect(await f.join.state(f.gymId, link.id)).toMatchObject({ status: 'pending' });
    const confirming = await f.get('/join/return', cookie);
    expect(confirming.status).toBe(200);
    const confirmingHtml = await confirming.text();
    expect(confirmingHtml).toContain('Confirming your payment');
    expect(confirmingHtml).not.toContain('a sign-in link is on its way');
  });

  it('ends a completed card-only join when its only trial is cancelled', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult()], 'trial-ended@example.invalid', f.trial.id);
    await finishCard(f, cookie);
    const { link, rows } = await joined(f);
    expect(rows.map(row => row.status)).toEqual(['trial']);
    await update(f, rows[0]!.id, { status: 'cancelled', cancelledAt: f.clock.now() });
    expect(await f.join.state(f.gymId, link.id)).toEqual({ status: 'ended' });
    const html = await (await f.get('/join/return', cookie)).text();
    expect(html).toContain('This membership has ended');
    expect(html).not.toContain('Confirming');
  });

  it('keeps a completed card-only join welcome when one of two trials is cancelled', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult(), child()], 'trial-partial@example.invalid', f.trial.id);
    await finishCard(f, cookie);
    const { link, rows } = await joined(f);
    expect(rows.map(row => row.status)).toEqual(['trial', 'trial']);
    await update(f, rows[0]!.id, { status: 'cancelled', cancelledAt: f.clock.now() });
    expect(await f.join.state(f.gymId, link.id)).toMatchObject({ status: 'active' });
    const html = await (await f.get('/join/return', cookie)).text();
    expect(html).toContain('a sign-in link is on its way');
    expect(html).not.toContain('This membership has ended');
  });

  it('keeps a completed join welcome when its only membership is frozen', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult()]);
    await f.pay(cookie);
    const { link, rows } = await joined(f);
    await update(f, rows[0]!.id, { status: 'frozen', frozenAt: f.clock.now() });
    expect(await f.join.state(f.gymId, link.id)).toMatchObject({ status: 'active' });
    const html = await (await f.get('/join/return', cookie)).text();
    expect(html).toContain('a sign-in link is on its way');
  });

  it('renders the ended page on every join step and starts no Checkout', async () => {
    const f = await fixture(), { cookie } = await f.submit([adult()]);
    await f.pay(cookie);
    const start = vi.spyOn(f.join, 'checkout'), create = vi.spyOn(f.provider, 'createCheckout'), { rows } = await joined(f);
    await update(f, rows[0]!.id, { status: 'cancelled', cancelledAt: f.clock.now() });
    for (const path of ['/join/checkout', '/join/review', '/join/return', '/join/cancelled']) {
      const response = await f.get(path, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      const html = await response.text();
      expect(html).toContain('This membership has ended');
      expect(html).toContain('The membership from this sign-up has ended');
      expect(html).not.toContain('The gym has closed this payment');
      expect(html).not.toContain('Confirming');
    }
    expect(start).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
