// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { auditEvents, households, linkCampaigns, members, signedLinks, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, createTranslator, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { linksContracts, type CreateLinkCampaignRequest } from '@plaingym/shared/contracts';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createApp } from '../../app.js';
import { authorize } from '../staff/auth.permissions.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createSignedLinkCheckout } from '../billing/signed-link-checkout.js';
import { createInvoiceTransitions } from '../billing/transitions/index.js';
import { registerBillingWebhookHandlers } from '../billing/webhooks/handlers/index.js';
import type { WebhookHandler } from '../billing/webhooks/inbox.js';
import { createCustomersService } from '../billing/customers.js';
import { createGoLiveService } from '../settings/go-live.js';
import { createSignedLinksService } from './service.js';
import { createCampaignsService, configureCampaigns, campaignPublishJob, campaignSendJob } from './campaigns.js';
import { createWaiversService } from '../waivers/waivers.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { configureLinkPages } from '../../public/links/links.routes.js';
import { createCampaignRoutes } from './campaigns.routes.js';
import { createCampaignJobs } from './campaigns.jobs.js';
import { matchCampaignCustomer } from './campaigns.customers.js';
import type { SignedLinkDelivery } from './service.delivery.js';

const db = useTestDatabase(), factory = createFactories(db);
const origin = 'https://gym.example.test';
const messages = JSON.parse(await readFile(new URL('../../../../../locales/en/links/service.json', import.meta.url), 'utf8')) as Record<string, string>;
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true, billingEnabled: true, timezone: 'America/Los_Angeles' });
  const household = await factory('households', gymId, { email: 'payer@example.test' });
  const member = await factory('members', gymId, { householdId: household.id, email: household.email });
  const user = await factory('authUser', gymId);
  const provider = new FakePayments(gymId, clock), jobs = new FakeJobs(clock), email = new FakeEmail();
  const paymentsFor = vi.fn(async () => { expect(isInTransaction()).toBe(false); return provider; });
  const prepare = vi.fn(async (id: string) => {
    expect(isInTransaction()).toBe(false);
    return { gymId: id, gymName: 'Test Gym', origin, email, memberEmailsEnabled: true, t: createTranslator({ 'links/service': messages }) };
  });
  const delivery: SignedLinkDelivery = { prepare };
  const service = createCampaignsService({ scope: db.forGym, clock, jobs, delivery, paymentsFor });
  const links = createSignedLinksService({ scope: db.forGym, clock });
  createServerRegistry({ jobs: createCampaignJobs(() => service) }).registerJobs(jobs, new Set());
  const context = { gymId, actor: { kind: 'system' as const } };
  const input = (purpose: 'onboarding' | 'update_card' = 'update_card'): Extract<CreateLinkCampaignRequest, { purpose: 'onboarding' | 'update_card' }> => ({ name: 'Collect cards', purpose,
    expiresAt: '2026-11-26T12:00:00Z', reminderSchedule: [3, 7], recipients: [{ householdId: household.id }] });
  async function campaign(purpose: 'onboarding' | 'update_card' = 'update_card') {
    const created = await service.create(context, input(purpose));
    const recipient = (await service.recipients(gymId, created.campaign.id)).data[0]!;
    return { ...created, link: recipient.link };
  }
  const staff = (role: StaffRole = 'owner'): Principal => ({ kind: 'staff', gymId, userId: user.id, roles: [role] });
  function server(principal: Principal = staff(), resolvedGym = gymId) {
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (c, next) => {
      c.set('context', { requestId: 'campaign-test', gym: { gymId: resolvedGym, timezone: 'America/Vancouver', enabledModules: new Set() }, principal, clock });
      await next();
    });
    app.onError((error, c) => c.json(errorResponse(error, 'campaign-test'), error instanceof AppError ? error.status : 500));
    createServerRegistry({ routes: createCampaignRoutes(() => service) }).mount(app, authorize, new Set());
    return app;
  }
  async function drain() { for (let n = 0; n < 50 && await jobs.runNext(); n++); }
  const token = () => email.messages.at(-1)!.text.match(/\/l\/([A-Za-z0-9_-]+)/)![1]!;
  const goLive = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true });
  async function emailSwitch(memberEmailsEnabled: boolean) {
    await goLive.update(context, { revision: (await goLive.checklist(gymId)).revision, memberEmailsEnabled });
  }
  return { gymId, clock, household, member, user, provider, jobs, email, paymentsFor, prepare, delivery, service, links, context, input, campaign, staff, server, drain, token, emailSwitch };
}
const post = (app: ReturnType<Awaited<ReturnType<typeof fixture>>['server']>, path: string, body?: unknown) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
const paths = ['createCampaign', 'listCampaigns', 'getCampaign', 'listCampaignRecipients', 'remindCampaign'] as const;
async function request(f: Awaited<ReturnType<typeof fixture>>, name: typeof paths[number], id: string, principal: Principal) {
  const contract = linksContracts[name], path = contract.path.replace('{campaignId}', id), app = f.server(principal);
  return contract.method === 'get' ? app.request(path) : post(app, path, name === 'createCampaign' ? f.input() : undefined);
}

describe('campaign contract, authorization and isolation', () => {
  it.each(staffRoles)('declares and enforces every route for %s', async role => {
    const f = await fixture(), c = await f.campaign();
    for (const name of paths) {
      const response = await request(f, name, c.campaign.id, f.staff(role));
      expect(response.status, name).toBe(role === 'coach' ? 403 : 200);
      if (response.ok) {
        expect(linksContracts[name].response.safeParse(await response.json()).success, name).toBe(true);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
  });
  it('denies every route to both household logins, signed links, kiosk and anonymous users', async () => {
    const f = await fixture(), c = await f.campaign();
    const other = await factory('households', f.gymId);
    const principals: Principal[] = [
      { kind: 'anonymous' }, { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
      ...[f.household.id, other.id].map(householdId => ({ kind: 'member' as const, userId: f.user.id, scope: { gymId: f.gymId, householdId, role: 'payer' as const } })),
      ...[f.household.id, other.id].map(householdId => ({ kind: 'signed_link' as const, gymId: f.gymId, householdId, linkId: c.link.id, link: { purpose: 'update_card' as const } })),
    ];
    for (const principal of principals) for (const name of paths)
      expect((await request(f, name, c.campaign.id, principal)).status, `${principal.kind}: ${name}`).toBe(principal.kind === 'anonymous' ? 401 : 403);
  });
  it('isolates every route by gym, including lists and creation recipients', async () => {
    const a = await fixture(), b = await fixture(), c = await b.campaign();
    for (const suffix of ['', '/recipients', '/remind']) {
      const path = `/api/link-campaigns/${c.campaign.id}${suffix}`;
      expect((suffix === '/remind' ? await post(a.server(), path) : await a.server().request(path)).status).toBe(404);
    }
    expect((await a.service.list(a.gymId)).data).toEqual([]);
    const list = await a.server().request('/api/link-campaigns');
    expect(linksContracts.listCampaigns.response.parse(await list.json()).data).toEqual([]);
    expect((await post(a.server(), '/api/link-campaigns', { ...a.input(), recipients: [{ householdId: b.household.id }] })).status).toBe(404);
    for (const name of paths) expect((await request(a, name, c.campaign.id, b.staff())).status).toBe(403);
    expect((await a.service.list(a.gymId)).data).toEqual([]);
    await a.service.send({ campaignId: c.campaign.id, linkId: c.link.id, occurrence: 'initial' }, a.gymId);
    expect(a.email.messages).toHaveLength(0);
  });
  it('rejects cross-household invoice and member resources atomically', async () => {
    const f = await fixture(), other = await factory('households', f.gymId);
    const foreign = await fixture();
    for (const target of [{ gymId: f.gymId, householdId: other.id }, { gymId: foreign.gymId, householdId: foreign.household.id }]) {
      const invoice = await factory('invoices', target.gymId, { householdId: target.householdId });
      const member = await factory('members', target.gymId, { householdId: target.householdId });
      for (const [purpose, resource] of [['pay_invoice', { invoiceId: invoice.id }], ['sign_waiver', { memberId: member.id }]] as const) {
        const response = await post(f.server(), '/api/link-campaigns', { ...f.input(), purpose, recipients: [{ householdId: f.household.id, ...resource }] });
        expect(response.status).toBe(404);
      }
    }
    expect((await f.service.list(f.gymId)).data).toEqual([]);
    expect(await db.forGym(f.gymId, tx => tx.select().from(signedLinks))).toEqual([]);
  });
  it('rejects invalid schedules, duplicate recipients and expired credentials without partial campaigns', async () => {
    const f = await fixture();
    for (const reminderSchedule of [[3, 3], [7, 3], [0], [-1], [1.5]])
      expect((await post(f.server(), '/api/link-campaigns', { ...f.input(), reminderSchedule })).status).toBe(400);
    expect((await post(f.server(), '/api/link-campaigns', { ...f.input(), recipients: [{ householdId: f.household.id }, { householdId: f.household.id }] })).status).toBe(400);
    expect((await post(f.server(), '/api/link-campaigns', { ...f.input(), expiresAt: f.clock.now().toISOString() })).status).toBe(400);
    expect((await f.service.list(f.gymId)).data).toEqual([]);
  });
  it('paginates and filters campaigns and the disjoint recipient states without secrets', async () => {
    const f = await fixture(), people = await Promise.all(Array.from({ length: 4 }, () => factory('households', f.gymId)));
    const created = await f.service.create(f.context, { ...f.input(), recipients: people.map(p => ({ householdId: p.id })) });
    const recipients = (await f.service.recipients(f.gymId, created.campaign.id)).data;
    await f.links.markUsed({ gymId: f.gymId, linkId: recipients[0]!.link.id });
    await f.links.revoke(f.context, recipients[0]!.link.id);
    await f.links.revoke(f.context, recipients[1]!.link.id);
    await db.forGym(f.gymId, tx => tx.update(signedLinks).set({ expiresAt: f.clock.now() }).where(eq(signedLinks.id, recipients[2]!.link.id)));
    const detail = await f.service.get(f.gymId, created.campaign.id);
    expect(detail.progress).toEqual({ total: 4, pending: 1, completed: 1, revoked: 1, expired: 1 });
    for (const state of ['pending', 'completed', 'revoked', 'expired'] as const)
      expect((await f.service.recipients(f.gymId, created.campaign.id, { state })).data.map(r => r.state)).toEqual([state]);
    expect((await f.service.recipients(f.gymId, created.campaign.id, { limit: 1, offset: 1 })).pagination).toEqual({ total: 4, limit: 1, offset: 1 });
    await f.campaign('onboarding');
    expect((await f.service.list(f.gymId, { purpose: 'update_card' })).data).toHaveLength(1);
    expect((await f.service.list(f.gymId, { limit: 1, offset: 1 })).pagination).toEqual({ total: 2, limit: 1, offset: 1 });
    expect(JSON.stringify([detail, await f.service.recipients(f.gymId, created.campaign.id)])).not.toMatch(/token|stripe_customer|processor/i);
  });
});

describe('campaign sends and reminders', () => {
  it('creates 2000 recipients with only one publish job, then publishes once with audit batches of 100', async () => {
    const f = await fixture();
    const people = await db.forGym(f.gymId, tx => tx.insert(households).values(Array.from({ length: 2000 }, (_, i) => ({
      gymId: f.gymId, name: 'Household ' + i, email: `payer${i}@example.test`,
    }))).returning({ id: households.id }));
    let transactions = 0;
    const service = createCampaignsService({ scope: async (gymId, fn) => { transactions++; return db.forGym(gymId, fn); },
      clock: f.clock, jobs: f.jobs, delivery: f.delivery, paymentsFor: f.paymentsFor });
    const enqueue = vi.spyOn(f.jobs, 'enqueue');
    const c = await service.create(f.context, { ...f.input(), recipients: people.map(p => ({ householdId: p.id })) });
    expect(enqueue).toHaveBeenCalledTimes(1); expect(f.jobs.jobs[0]!.name).toBe(campaignPublishJob);
    expect(transactions).toBe(3); // Definition, settings, and response; no recipient publication work.
    transactions = 0;
    const publish = createCampaignJobs(() => service).find(j => j.id === campaignPublishJob)!;
    await publish.handler({ campaignId: c.campaign.id }, { gymId: f.gymId, timezone: 'UTC', clock: f.clock, jobId: uuidv7(), attempt: 1 });
    expect(transactions).toBe(23); // Settings, recipients, history, twenty audit batches.
    await service.publish({ campaignId: c.campaign.id }, f.gymId);
    const sends = f.jobs.jobs.filter(j => j.name === campaignSendJob);
    expect(sends).toHaveLength(2000); expect(new Set(sends.map(j => j.options.idempotencyKey)).size).toBe(2000);
    expect(f.email.messages).toHaveLength(0);
  });
  it('repairs a publication interrupted midway through an audit batch without duplicate sends', async () => {
    const f = await fixture();
    const people = await db.forGym(f.gymId, tx => tx.insert(households).values(Array.from({ length: 12 }, (_, i) => ({
      gymId: f.gymId, name: 'Household ' + i, email: `payer${i}@example.test`,
    }))).returning({ id: households.id }));
    const c = await f.service.create(f.context, { ...f.input(), recipients: people.map(p => ({ householdId: p.id })) });
    const enqueue = f.jobs.enqueue.bind(f.jobs); let sends = 0;
    vi.spyOn(f.jobs, 'enqueue').mockImplementation(async (...args) => {
      if (args[0] === campaignSendJob && ++sends === 7) throw new Error('Publication interrupted');
      return enqueue(...args);
    });
    await expect(f.service.publish({ campaignId: c.campaign.id }, f.gymId)).rejects.toThrow('interrupted');
    await f.service.scan(f.gymId); await f.drain();
    expect(f.jobs.jobs.filter(j => j.name === campaignSendJob)).toHaveLength(12);
    expect(f.email.messages).toHaveLength(12); expect(new Set(f.email.messages.map(m => m.to)).size).toBe(12);
  });
  it('skips a queued occurrence with emails disabled without retries or token changes, then sends the next occurrence', async () => {
    const f = await fixture(), c = await f.campaign(); await f.drain(); const token = f.token();
    f.clock.advance(86400000); await f.service.remindCampaign(f.context, c.campaign.id); await f.emailSwitch(false);
    await f.drain();
    expect(f.jobs.jobs.at(-1)).toMatchObject({ status: 'completed', attempt: 1 });
    expect((await f.links.resolve(f.gymId, token)).status).toBe('active');
    const audit = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, c.link.id), eq(auditEvents.action, 'link_campaign.delivery_skipped'))));
    expect(audit).toHaveLength(1); expect(audit[0]!.after).toMatchObject({ campaignId: c.campaign.id, occurrence: 'manual:2026-10-27', reason: 'member_emails_disabled' });
    expect((await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, c.link.id), eq(auditEvents.action, 'link_campaign.delivery_reserved')))))).toHaveLength(1);
    await f.emailSwitch(true); f.clock.set('2026-10-29T16:07:00Z'); await f.service.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(2);
  });
  it('publishes initial sends after restart, uses the signed-link delivery and replays once', async () => {
    const f = await fixture(), c = await f.campaign();
    expect(f.email.messages).toHaveLength(0);
    expect(f.jobs.jobs).toMatchObject([{ name: campaignPublishJob, options: { idempotencyKey: `${c.campaign.id}:initial` } }]);
    const restarted = createCampaignsService({ scope: db.forGym, clock: f.clock, jobs: f.jobs, delivery: f.delivery, paymentsFor: f.paymentsFor });
    await restarted.scan(f.gymId); await restarted.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(1);
    expect(f.email.messages[0]!.to).toBe('payer@example.test');
    expect(await f.links.resolve(f.gymId, f.token())).toMatchObject({ status: 'active', principal: { linkId: c.link.id, householdId: f.household.id } });
    const lookup = vi.spyOn(f.provider, 'findCustomerByEmail');
    await restarted.send({ campaignId: c.campaign.id, linkId: c.link.id, occurrence: 'initial' }, f.gymId);
    expect(lookup).not.toHaveBeenCalled();
    expect(f.email.messages).toHaveLength(1);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents));
    expect(audits.some(a => a.action === 'link_campaign.created')).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(f.token());
    expect(JSON.stringify(audits)).not.toContain('payer@example.test');
    expect(JSON.stringify(f.jobs.jobs)).not.toContain(f.token());
  });
  it('schedules at gym-local 09:00 through DST, rotates the same link and catches up only the latest day', async () => {
    const f = await fixture(), c = await f.campaign();
    await f.service.scan(f.gymId); await f.drain(); const original = f.token();
    f.clock.set('2026-10-29T15:59:00Z'); await f.service.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(1);
    f.clock.set('2026-10-29T16:00:00Z'); await f.service.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(2); expect((await f.links.resolve(f.gymId, original)).status).toBe('not_found');
    expect((await f.links.resolve(f.gymId, f.token())).status).toBe('active');
    f.clock.set('2026-11-02T16:59:00Z'); await f.service.scan(f.gymId); await f.drain(); expect(f.email.messages).toHaveLength(2);
    f.clock.set('2026-11-02T17:00:00Z'); await f.service.scan(f.gymId); await f.drain(); expect(f.email.messages).toHaveLength(3);
    expect((await f.service.get(f.gymId, c.campaign.id)).progress).toMatchObject({ total: 1, pending: 1 });
    expect((await f.links.get(f.gymId, c.link.id)).expiresAt).toBe(c.link.expiresAt);
    const other = await f.campaign(); f.clock.set('2026-11-11T17:00:00Z'); await f.service.scan(f.gymId); await f.drain();
    expect(f.jobs.jobs.filter(j => j.name === campaignSendJob && (j.payload as { campaignId: string }).campaignId === other.campaign.id)
      .map(j => (j.payload as { occurrence: string }).occurrence).sort()).toEqual(['day:7', 'initial']);
    expect(f.email.messages).toHaveLength(4); // The queued but now stale initial job did not send.
  });
  it('an empty schedule sends only the initial message and manual reminders deduplicate per local day', async () => {
    const f = await fixture(), c = await f.service.create(f.context, { ...f.input(), reminderSchedule: [] });
    await f.service.scan(f.gymId); await f.drain();
    f.clock.set('2026-11-02T18:00:00Z'); await f.service.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(1);
    await Promise.all([f.service.remindCampaign(f.context, c.campaign.id), f.service.remindCampaign(f.context, c.campaign.id)]); await f.drain();
    expect(f.email.messages).toHaveLength(2);
  });
  // TODO: enforce these campaign request limits in the shared contract.
  it('rejects campaign requests beyond the local limits', async () => {
    const f = await fixture();
    for (const override of [
      { reminderSchedule: [2147483647] }, { reminderSchedule: Array.from({ length: 11 }, (_, i) => i + 1) },
      { name: 'x'.repeat(121) }, { recipients: Array.from({ length: 2001 }, () => ({ householdId: uuidv7() })) },
      { expiresAt: new Date(f.clock.now().getTime() + 90 * 86400000 + 1).toISOString() },
    ]) await expect(f.service.create(f.context, { ...f.input(), ...override })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await f.service.list(f.gymId)).data).toEqual([]); expect(f.jobs.jobs).toEqual([]);
    await f.service.create(f.context, { ...f.input(), name: 'x'.repeat(120), reminderSchedule: [1, 2, 3, 4, 5, 6, 7, 8, 9, 365],
      expiresAt: new Date(f.clock.now().getTime() + 90 * 86400000).toISOString() });
  });
  it('does not retry an occurrence reserved before a crash, but permits a later manual reminder', async () => {
    const f = await fixture(), c = await f.campaign();
    await db.forGym(f.gymId, tx => writeAudit(tx, { gymId: f.gymId, actorKind: 'system',
      action: 'link_campaign.delivery_reserved', targetType: 'signed_link', targetId: c.link.id,
      after: { campaignId: c.campaign.id, occurrence: 'initial' }, occurredAt: f.clock.now() }));
    await f.service.scan(f.gymId); await f.drain(); expect(f.email.messages).toHaveLength(0);
    f.clock.advance(86400000);
    await f.service.remindCampaign(f.context, c.campaign.id); await f.drain(); expect(f.email.messages).toHaveLength(1);
  });
  it.each(['used', 'revoked', 'expired'] as const)('stops a queued reminder when the link becomes %s', async state => {
    const f = await fixture(), c = await f.campaign();
    await f.service.scan(f.gymId);
    if (state === 'used') await f.links.markUsed({ gymId: f.gymId, linkId: c.link.id });
    if (state === 'revoked') await f.links.revoke(f.context, c.link.id);
    if (state === 'expired') f.clock.set(c.link.expiresAt);
    await f.drain(); await f.service.scan(f.gymId);
    expect(f.email.messages).toHaveLength(0);
    expect(await f.service.remindCampaign(f.context, c.campaign.id)).toEqual({ queued: 0 });
  });
  it('rechecks completion after delivery preparation and never reopens a completed link', async () => {
    const f = await fixture(), c = await f.campaign();
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async id => { await f.links.markUsed({ gymId: id, linkId: c.link.id }); return prepare(id); });
    await f.service.send({ campaignId: c.campaign.id, linkId: c.link.id, occurrence: 'initial' }, f.gymId);
    expect(f.email.messages).toHaveLength(0);
    expect((await f.service.get(f.gymId, c.campaign.id)).campaign.completedAt).toBe(f.clock.now().toISOString());
  });
  it('respects memberEmailsEnabled for initial sends and reminders, including a switch changed during preparation', async () => {
    const f = await fixture();
    await f.emailSwitch(false);
    const c = await f.campaign();
    await f.service.scan(f.gymId); expect(f.jobs.jobs.filter(j => j.name === campaignSendJob)).toHaveLength(0);
    expect(await f.service.remindCampaign(f.context, c.campaign.id)).toEqual({ queued: 0 });
    await f.service.send({ campaignId: c.campaign.id, linkId: c.link.id, occurrence: 'initial' }, f.gymId);
    await f.emailSwitch(true);
    await f.service.scan(f.gymId); await f.drain(); expect(f.email.messages).toHaveLength(1);
    const original = f.token(); f.clock.advance(86400000);
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async id => {
      await f.emailSwitch(false);
      return prepare(id);
    });
    await f.service.remindCampaign(f.context, c.campaign.id); await f.drain();
    expect(f.email.messages).toHaveLength(1);
    expect((await f.links.resolve(f.gymId, original)).status).toBe('active');
  });
  it('suppresses opted-out recipients and records uncertain SMTP without replaying or adding links', async () => {
    const f = await fixture(), c = await f.campaign();
    await db.forGym(f.gymId, tx => tx.update(members).set({ emailOptOut: true }).where(eq(members.id, f.member.id)));
    await f.service.scan(f.gymId); await f.drain(); expect(f.email.messages).toHaveLength(0);
    await db.forGym(f.gymId, tx => tx.update(members).set({ emailOptOut: false }).where(eq(members.id, f.member.id)));
    f.clock.advance(86400000);
    f.email.respondNext(new Error('SMTP reply lost'));
    await f.service.remindCampaign(f.context, c.campaign.id); await f.drain();
    await f.service.remindCampaign(f.context, c.campaign.id); await f.drain(); expect(f.email.messages).toHaveLength(0);
    f.clock.advance(86400000); await f.service.remindCampaign(f.context, c.campaign.id); await f.drain();
    expect(f.email.messages).toHaveLength(1);
    expect((await f.service.get(f.gymId, c.campaign.id)).progress.total).toBe(1);
  });
  it('concurrent delivery callbacks reserve one attempt for the occurrence', async () => {
    const f = await fixture(), c = await f.campaign();
    const payload = { campaignId: c.campaign.id, linkId: c.link.id, occurrence: 'initial' };
    await Promise.all([f.service.send(payload, f.gymId), f.service.send(payload, f.gymId)]);
    expect(f.email.messages).toHaveLength(1);
  });
  it('repairs a crash after campaign commit without creating a second campaign', async () => {
    const f = await fixture();
    vi.spyOn(f.jobs, 'enqueue').mockRejectedValueOnce(new Error('Queue unavailable'));
    const c = await f.campaign(); expect(f.jobs.jobs).toHaveLength(0);
    await f.service.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(1);
    expect((await f.service.list(f.gymId)).data.map(d => d.campaign.id)).toEqual([c.campaign.id]);
  });
  it('does not publish or call Stripe when nothing is due, even on the following local day', async () => {
    const f = await fixture(); await f.campaign(); await f.drain();
    const enqueue = vi.spyOn(f.jobs, 'enqueue'), lookup = vi.spyOn(f.provider, 'findCustomerByEmail');
    await f.service.scan(f.gymId); f.clock.advance(86400000); await f.service.scan(f.gymId);
    expect(enqueue).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
    expect(f.jobs.jobs).toHaveLength(2); // One publisher and one recipient send.
  });
  it('filters completed and expired campaigns in the scan query without loading their recipients', async () => {
    const f = await fixture(), completed = await f.campaign(), expired = await f.campaign();
    await f.links.markUsed({ gymId: f.gymId, linkId: completed.link.id });
    await db.forGym(f.gymId, tx => tx.update(signedLinks).set({ expiresAt: f.clock.now() }).where(eq(signedLinks.id, expired.link.id)));
    let transactions = 0;
    const service = createCampaignsService({ scope: async (gymId, fn) => { transactions++; return db.forGym(gymId, fn); },
      clock: f.clock, jobs: f.jobs, delivery: f.delivery, paymentsFor: f.paymentsFor });
    const enqueue = vi.spyOn(f.jobs, 'enqueue'); await service.scan(f.gymId);
    expect(transactions).toBe(2); // Gym settings and the grouped active-campaign query only.
    expect(enqueue).not.toHaveBeenCalled();
  });
  it.each(['scheduled', 'manual'] as const)('shares one daily send limit when %s wins, including concurrent callbacks', async first => {
    const f = await fixture(), c = await f.campaign(); await f.drain();
    f.clock.set('2026-10-29T16:07:00Z');
    if (first === 'scheduled') { await f.service.scan(f.gymId); await f.drain(); await f.service.remindCampaign(f.context, c.campaign.id); }
    else { await f.service.remindCampaign(f.context, c.campaign.id); await f.drain(); await f.service.scan(f.gymId); }
    await Promise.all(['day:3', 'manual:2026-10-29'].map(occurrence => f.service.send({ campaignId: c.campaign.id, linkId: c.link.id, occurrence }, f.gymId)));
    await f.drain(); expect(f.email.messages).toHaveLength(2);
  });
  it.each(['opt_out', 'undeliverable', 'missing_email', 'invalid_email', 'transport_suppressed'] as const)(
    'keeps the earlier token and records suppression for %s', async reason => {
    const f = await fixture(), c = await f.campaign(); await f.drain(); const oldToken = f.token();
    f.clock.advance(86400000);
    if (reason === 'opt_out') await db.forGym(f.gymId, tx => tx.update(members).set({ emailOptOut: true }).where(eq(members.id, f.member.id)));
    if (reason === 'undeliverable') await db.forGym(f.gymId, tx => tx.update(members).set({ emailDeliverable: false }).where(eq(members.id, f.member.id)));
    if (reason === 'missing_email' || reason === 'invalid_email') await db.forGym(f.gymId, tx => tx.update(households)
      .set({ email: reason === 'missing_email' ? null : 'bad\r\naddress' }).where(eq(households.id, f.household.id)));
    if (reason === 'transport_suppressed') f.email.respondNext({ status: 'suppressed', reason: 'disabled' });
    await f.service.remindCampaign(f.context, c.campaign.id); await f.drain();
    expect((await f.links.resolve(f.gymId, oldToken)).status).toBe('active');
    expect(f.email.messages).toHaveLength(1);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, c.link.id)));
    expect(audits.some(a => a.action === 'link_campaign.delivery_suppressed')).toBe(true);
    expect(audits.some(a => a.action === 'link_campaign.delivery_uncertain')).toBe(false);
  });
  it('keeps a possibly accepted token usable after a lost SMTP reply and never replays it', async () => {
    const f = await fixture(), c = await f.campaign();
    const send = f.email.sendEmail.bind(f.email);
    vi.spyOn(f.email, 'sendEmail').mockImplementationOnce(async message => { await send(message); throw new Error('Reply lost'); });
    await f.drain(); const token = f.token();
    expect((await f.links.resolve(f.gymId, token)).status).toBe('active');
    await f.service.send({ campaignId: c.campaign.id, linkId: c.link.id, occurrence: 'initial' }, f.gymId);
    expect(f.email.sendEmail).toHaveBeenCalledTimes(1);
  });
  // TODO: expose delivery acceptance classification through the email interface.
  it('treats refused connections without delivery acceptance classification as ambiguous', async () => {
    const f = await fixture(), c = await f.campaign();
    f.email.respondNext(Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }));
    const send = vi.spyOn(f.email, 'sendEmail'); await f.drain();
    await f.service.send({ campaignId: c.campaign.id, linkId: c.link.id, occurrence: 'initial' }, f.gymId);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, c.link.id),
      eq(auditEvents.action, 'link_campaign.delivery_uncertain')))))).toHaveLength(1);
  });
  it('leaves a working token untouched when the trusted origin fails before reservation', async () => {
    const f = await fixture(), c = await f.campaign(); await f.drain(); const token = f.token(); f.clock.advance(86400000);
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async gymId => ({ ...await prepare(gymId), origin: 'https://attacker.test/unsafe/path' }));
    await f.service.remindCampaign(f.context, c.campaign.id); await f.drain();
    expect((await f.links.resolve(f.gymId, token)).status).toBe('active');
    expect((await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, c.link.id),
      eq(auditEvents.action, 'link_campaign.delivery_cancelled')))))).toHaveLength(1);
  });
});

describe('campaign customer matching', () => {
  it.each(['paymentsFor', 'findCustomerByEmail'] as const)('sends onboarding once and audits when %s fails', async source => {
    const f = await fixture(), c = await f.campaign('onboarding');
    const lookup = vi.spyOn(f.provider, 'findCustomerByEmail');
    if (source === 'paymentsFor') f.paymentsFor.mockRejectedValue(new AppError('unavailable', 'Stripe is not configured'));
    else lookup.mockRejectedValue(new Error('Lookup failed for payer@example.test / cus_private'));
    await f.drain();
    const send = f.jobs.jobs.find(job => job.name === campaignSendJob)!;
    expect(send).toMatchObject({ status: 'completed', attempt: 1 });
    expect(f.email.messages).toHaveLength(1);
    expect(f.email.messages[0]!.to).toBe(f.household.email);
    expect((await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, f.household.id))))[0]!.stripeCustomerId).toBeNull();
    await f.service.send(send.payload, f.gymId);
    expect(f.email.messages).toHaveLength(1);
    expect(f.paymentsFor).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(source === 'paymentsFor' ? 0 : 1);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'link_campaign.customer_match_failed')));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ targetType: 'signed_link', targetId: c.link.id,
      after: { campaignId: c.campaign.id, occurrence: 'initial' } });
    expect(audits[0]!.after).toEqual({ campaignId: c.campaign.id, occurrence: 'initial' });
    expect(JSON.stringify(audits)).not.toMatch(/payer@example|cus_private/);
  });
  it('uses only gym-tagged exact email matches and retains the household revision', async () => {
    const f = await fixture(), c = await f.campaign();
    f.provider.seedCustomer({ id: 'cus_ours', email: 'PAYER@example.test' });
    f.provider.seedCustomer({ id: 'cus_foreign', email: 'payer@example.test', gymId: uuidv7() });
    const lookup = vi.spyOn(f.provider, 'findCustomerByEmail'), create = vi.spyOn(f.provider, 'createCustomer');
    await f.service.scan(f.gymId); await f.drain();
    const [household] = await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, f.household.id)));
    expect(household).toMatchObject({ stripeCustomerId: 'cus_ours', revision: f.household.revision });
    expect(lookup).toHaveBeenCalledWith('payer@example.test'); expect(create).not.toHaveBeenCalled();
    expect((await f.service.get(f.gymId, c.campaign.id)).progress.completed).toBe(0);
  });
  it.each(['existing', 'ambiguous', 'claimed', 'none', 'reserved'] as const)('leaves %s customer associations alone', async kind => {
    const f = await fixture();
    if (kind !== 'none') f.provider.seedCustomer({ id: 'cus_match', email: 'payer@example.test' });
    if (kind === 'ambiguous') f.provider.seedCustomer({ id: 'cus_two', email: 'payer@example.test' });
    if (kind === 'existing') await db.forGym(f.gymId, tx => tx.update(households).set({ stripeCustomerId: 'cus_keep' }).where(eq(households.id, f.household.id)));
    if (kind === 'claimed') await factory('households', f.gymId, { stripeCustomerId: 'cus_match' });
    if (kind === 'reserved') await db.forGym(f.gymId, tx => writeAudit(tx, { gymId: f.gymId, actorKind: 'system',
      action: 'billing.customer.creation_reserved', targetType: 'household', targetId: f.household.id, occurredAt: f.clock.now() }));
    await matchCampaignCustomer({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor }, f.gymId, f.household.id);
    const [row] = await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, f.household.id)));
    expect(row!.stripeCustomerId).toBe(kind === 'existing' ? 'cus_keep' : null);
  });
  it('cannot match another gym household and does not overwrite concurrent customer creation or a changed email', async () => {
    const f = await fixture(), b = await fixture();
    await matchCampaignCustomer({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor }, f.gymId, b.household.id);
    expect(f.paymentsFor).not.toHaveBeenCalled();
    f.provider.seedCustomer({ id: 'cus_match', email: 'payer@example.test' });
    const customers = createCustomersService({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor });
    vi.spyOn(f.provider, 'findCustomerByEmail').mockImplementationOnce(async () => {
      await customers.ensureCustomer(f.gymId, f.household.id);
      return [{ id: 'cus_match', email: 'payer@example.test' }];
    });
    await matchCampaignCustomer({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor }, f.gymId, f.household.id);
    const [row] = await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, f.household.id)));
    expect(row!.stripeCustomerId).not.toBe('cus_match'); expect(row!.stripeCustomerId).not.toBeNull();
    const other = await factory('households', f.gymId, { email: 'payer@example.test' });
    vi.spyOn(f.provider, 'findCustomerByEmail').mockImplementationOnce(async () => {
      await db.forGym(f.gymId, tx => tx.update(households).set({ email: 'changed@example.test' }).where(eq(households.id, other.id)));
      return [{ id: 'cus_match', email: 'payer@example.test' }];
    });
    await matchCampaignCustomer({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor }, f.gymId, other.id);
    expect((await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.id, other.id))))[0]!.stripeCustomerId).toBeNull();
  });
  it('serializes two households matching the same customer without sharing it', async () => {
    const f = await fixture(), other = await factory('households', f.gymId, { email: 'payer@example.test' });
    f.provider.seedCustomer({ id: 'cus_unique', email: 'payer@example.test' });
    await Promise.all([f.household.id, other.id].map(id => matchCampaignCustomer({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor }, f.gymId, id)));
    const matches = await db.forGym(f.gymId, tx => tx.select().from(households).where(eq(households.stripeCustomerId, 'cus_unique')));
    expect(matches).toHaveLength(1);
  });
});

describe('campaign completion and production registrations', () => {
  it.each(['update_card', 'pay_invoice'] as const)('protects the old %s token through Checkout and completes its real browser return', async purpose => {
    const f = await fixture();
    const invoice = await factory('invoices', f.gymId, { householdId: f.household.id, status: 'open', number: 1 });
    const c = await f.service.create(f.context, purpose === 'pay_invoice'
      ? { ...f.input(), purpose, recipients: [{ householdId: f.household.id, invoiceId: invoice.id }] } : f.input());
    const link = (await f.service.recipients(f.gymId, c.campaign.id)).data[0]!.link;
    await f.drain(); const token = f.token();
    const checkout = createSignedLinkCheckout({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor, originFor: async () => origin });
    configureLinkPages({ scope: db.forHousehold, links: f.links, checkout, receiptKey: new Uint8Array(32).fill(7),
      waivers: createWaiversService({ scope: db.forGym, clock: f.clock, uploadsFor: async () => new FakeUploads(f.gymId, f.clock) }) });
    const app = createApp({ clock: f.clock, skipSetup: true, authorize, origin, contributions: areaContributions,
      resolveGym: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (ctx, next) => { ctx.set('context', { ...ctx.get('context'), principal: { kind: 'anonymous' } }); await next(); }, rateLimit: { limit: 10000 } });
    f.clock.set('2026-10-29T15:59:00Z');
    const path = '/api/links/' + purpose.replaceAll('_', '-');
    const started = await app.request(origin + path + '/checkout', { method: 'POST', headers: { origin, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}' });
    expect(started.status).toBe(200); const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
    const session = await checkout.start(f.gymId, link.id);
    f.clock.set('2026-10-29T16:07:00Z'); await f.service.scan(f.gymId);
    expect(await f.service.remindCampaign(f.context, c.campaign.id)).toEqual({ queued: 0 });
    await f.drain(); expect(f.email.messages).toHaveLength(1); expect((await f.links.resolve(f.gymId, token)).status).toBe('active');
    expect((await app.request(origin + '/l/return', { headers: { cookie } })).headers.get('location')).toBe('/l/' + token + '?returned=1');
    const complete = () => app.request(origin + path + '/complete', { method: 'POST', headers: { origin, cookie, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}' });
    expect(await (await complete()).json()).toEqual({ data: { completed: false } });
    const paid = f.provider.completeCheckout(session.session.id), handlers = new Map<string, WebhookHandler>();
    registerBillingWebhookHandlers({ register(type, handler) { handlers.set(type, handler); } }, { scope: db.forGym, clock: f.clock,
      transitions: createInvoiceTransitions({ scope: db.forGym, clock: f.clock }) });
    await handlers.get('checkout.session.completed')!({ id: 'evt_' + uuidv7(), type: 'checkout.session.completed', gymId: f.gymId, objectId: paid.id, objectKind: 'checkout' },
      { gymId: f.gymId, clock: f.clock, timezone: 'UTC', attempt: 1, jobId: uuidv7(), payments: f.provider });
    expect(await (await complete()).json()).toEqual({ data: { completed: true } });
    expect((await f.service.get(f.gymId, c.campaign.id)).progress.completed).toBe(1);
    expect((await f.links.resolve(f.gymId, token)).status).toBe('used');
  });
  it('queues a still-current reminder after the 24-hour Checkout hold, but not one millisecond earlier', async () => {
    const f = await fixture(), c = await f.campaign(); await f.drain(); const token = f.token();
    f.clock.set('2026-10-29T15:59:00Z');
    await createSignedLinkCheckout({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor, originFor: async () => origin }).start(f.gymId, c.link.id);
    f.clock.advance(86400000 - 1); await f.service.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(1); expect((await f.links.resolve(f.gymId, token)).status).toBe('active');
    f.clock.advance(1); await f.service.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(2);
  });
  it('does not let another gym Checkout audit block this gym, even with the same target ID', async () => {
    const a = await fixture(), b = await fixture(), c = await a.campaign();
    await db.forGym(b.gymId, tx => writeAudit(tx, { gymId: b.gymId, actorKind: 'system', action: 'billing.card_setup.started',
      targetType: 'signed_link', targetId: c.link.id, occurredAt: a.clock.now() }));
    await a.drain(); expect(a.email.messages).toHaveLength(1);
  });
  it.each(['before_send', 'during_prepare'] as const)('drops an already-published reminder when Checkout starts %s, without rotating its token', async when => {
    const f = await fixture(), c = await f.campaign(); await f.drain(); const token = f.token(); f.clock.advance(86400000);
    await f.service.remindCampaign(f.context, c.campaign.id);
    const checkout = createSignedLinkCheckout({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor, originFor: async () => origin });
    if (when === 'before_send') await checkout.start(f.gymId, c.link.id);
    else { const prepare = f.prepare.getMockImplementation()!; f.prepare.mockImplementationOnce(async gymId => { await checkout.start(gymId, c.link.id); return prepare(gymId); }); }
    await f.drain(); expect((await f.links.resolve(f.gymId, token)).status).toBe('active');
    expect(f.email.messages).toHaveLength(1);
    const audit = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, c.link.id), eq(auditEvents.action, 'link_campaign.delivery_deferred'))));
    expect(audit).toHaveLength(1);
    f.clock.advance(86400000); await f.drain(); expect(f.email.messages).toHaveLength(1);
    await f.service.remindCampaign(f.context, c.campaign.id); await f.drain(); expect(f.email.messages).toHaveLength(2);
  });
  it.each(['onboarding', 'update_card'] as const)('tracks %s after one card-saved webhook and the signed-link completion path', async purpose => {
    const f = await fixture(), c = await f.campaign(purpose);
    await f.service.scan(f.gymId); await f.drain();
    const token = f.token();
    const checkout = createSignedLinkCheckout({ scope: db.forGym, clock: f.clock, paymentsFor: f.paymentsFor, originFor: async () => origin });
    const opened = await checkout.start(f.gymId, c.link.id), session = f.provider.completeCheckout(opened.session.id);
    expect(await checkout.complete(f.gymId, c.link.id, session.id)).toBe(false);
    expect((await f.service.get(f.gymId, c.campaign.id)).progress.pending).toBe(1);
    const handlers = new Map<string, WebhookHandler>();
    registerBillingWebhookHandlers({ register(type, handler) { handlers.set(type, handler); } }, { scope: db.forGym, clock: f.clock,
      transitions: createInvoiceTransitions({ scope: db.forGym, clock: f.clock }) });
    // Exercise both existing ways the card can arrive.
    const event = purpose === 'onboarding'
      ? { id: 'evt_' + uuidv7(), type: 'setup_intent.succeeded', gymId: f.gymId, objectKind: 'setup' as const, objectId: session.setupId! }
      : { id: 'evt_' + uuidv7(), type: 'checkout.session.completed', gymId: f.gymId, objectKind: 'checkout' as const, objectId: session.id };
    await handlers.get(event.type)!(event, { gymId: f.gymId, clock: f.clock, timezone: 'America/Vancouver', jobId: uuidv7(), attempt: 1, payments: f.provider });
    expect(await checkout.complete(f.gymId, c.link.id, session.id)).toBe(true);
    const detail = await f.service.get(f.gymId, c.campaign.id);
    expect(detail.progress).toMatchObject({ completed: 1, pending: 0 });
    expect(detail.campaign.completedAt).toBe(f.clock.now().toISOString());
    expect((await f.links.resolve(f.gymId, token)).status).toBe('used');
    f.clock.advance(7 * 86400000); await f.service.scan(f.gymId); await f.drain();
    expect(await f.service.remindCampaign(f.context, c.campaign.id)).toEqual({ queued: 0 });
    expect(f.email.messages).toHaveLength(1);
  });
  it('creates, delivers and reads progress through createApp with the real area registrations', async () => {
    const f = await fixture(); configureCampaigns(f.service);
    const app = createApp({ clock: f.clock, skipSetup: true, authorize, origin, contributions: areaContributions, rateLimit: { limit: 10000 },
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'America/Vancouver', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal: f.staff() }); await next(); },
    });
    const response = await app.request(origin + '/api/link-campaigns', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(f.input()) });
    expect(response.status).toBe(200);
    const created = linksContracts.createCampaign.response.parse(await response.json()).data;
    const publication = f.jobs.jobs.find(j => j.name === campaignPublishJob)!;
    await areaContributions.jobs.find(j => j.id === campaignPublishJob)!.handler(publication.payload,
      { gymId: f.gymId, timezone: 'America/Vancouver', clock: f.clock, jobId: uuidv7(), attempt: 1 });
    const scan = areaContributions.jobs.find(j => j.id === 'links.campaigns.scan')!;
    await scan.handler({}, { gymId: f.gymId, timezone: 'America/Vancouver', clock: f.clock, jobId: uuidv7(), attempt: 1 });
    const job = f.jobs.jobs.find(j => j.name === campaignSendJob)!;
    await areaContributions.jobs.find(j => j.id === campaignSendJob)!.handler(job.payload, { gymId: f.gymId, timezone: 'America/Vancouver', clock: f.clock, jobId: uuidv7(), attempt: 1 });
    expect((await f.links.resolve(f.gymId, f.token())).status).toBe('active');
    const result = await app.request(origin + '/api/link-campaigns/' + created.campaign.id);
    expect(result.status).toBe(200);
    expect(linksContracts.getCampaign.response.parse(await result.json()).data.progress).toMatchObject({ total: 1, pending: 1 });
    const [stored] = await db.forGym(f.gymId, tx => tx.select().from(linkCampaigns).where(and(eq(linkCampaigns.id, created.campaign.id), eq(linkCampaigns.gymId, f.gymId))));
    expect(stored!.createdBy).toBe(f.user.id);
  });
});
