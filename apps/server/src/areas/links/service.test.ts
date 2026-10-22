// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { auditEvents, signedLinks, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, createTranslator, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import {
  createSignedLinkResponseSchema, signedLinkListResponseSchema, signedLinkResponseSchema,
  type CreateSignedLinkRequest, type SignedLinkPurposeName,
} from '@plaingym/shared/contracts';
import { isInTransaction, runInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { FakeEmail } from '../../infra/email/index.js';
import { createSignedLinksService, type SignedLinkPrincipal } from './service.js';
import { createSignedLinksRoutes } from './service.routes.js';
import type { PreparedSignedLinkDelivery } from './service.delivery.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
const service = createSignedLinksService({ scope: database.forGym, clock });
const gymA = uuidv7(), gymB = uuidv7();
const mutation = { gymId: gymA, actor: { kind: 'system' } } as const;
const email = new FakeEmail();
let householdA: string, householdOther: string, householdB: string;
let memberA: string, siblingA: string, memberOther: string, memberB: string;
let invoiceA: string, invoiceSibling: string, invoiceOther: string, invoiceB: string;
let userId: string;
let delivery: PreparedSignedLinkDelivery;
const request = (purpose: SignedLinkPurposeName = 'update_card'): CreateSignedLinkRequest => {
  const fields = { householdId: householdA, expiresAt: '2026-10-23T12:00:00Z' };
  return purpose === 'pay_invoice' ? { ...fields, purpose, invoiceId: invoiceA }
    : purpose === 'sign_waiver' ? { ...fields, purpose, memberId: memberA } : { ...fields, purpose };
};
const sending = createSignedLinksService({ scope: database.forGym, clock, delivery: {
  async prepare(gymId) { expect(isInTransaction()).toBe(false); return { ...delivery, gymId }; },
} });
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB);
  householdA = (await factory('households', gymA, { email: 'payer@example.test' })).id;
  householdOther = (await factory('households', gymA)).id;
  householdB = (await factory('households', gymB)).id;
  memberA = (await factory('members', gymA, { householdId: householdA, email: 'payer@example.test' })).id;
  siblingA = (await factory('members', gymA, { householdId: householdA })).id;
  memberOther = (await factory('members', gymA, { householdId: householdOther })).id;
  memberB = (await factory('members', gymB, { householdId: householdB })).id;
  invoiceA = (await factory('invoices', gymA, { householdId: householdA })).id;
  invoiceSibling = (await factory('invoices', gymA, { householdId: householdA })).id;
  invoiceOther = (await factory('invoices', gymA, { householdId: householdOther })).id;
  invoiceB = (await factory('invoices', gymB, { householdId: householdB })).id;
  await factory('paymentMethods', gymA, { householdId: householdA, processorId: 'pm_private_processor_identifier' });
  await factory('paymentMethods', gymA, { householdId: householdOther });
  await factory('paymentMethods', gymB, { householdId: householdB });
  userId = (await factory('authUser', gymA)).id;
  const messages = JSON.parse(await readFile(new URL('../../../../../locales/en/links/service.json', import.meta.url), 'utf8')) as Record<string, string>;
  delivery = { gymId: gymA, gymName: 'Test Gym', origin: 'https://gym.example.test',
    email, memberEmailsEnabled: true, t: createTranslator({ 'links/service': messages }) };
});
function server(principal: Principal = { kind: 'staff', gymId: gymA, userId, roles: ['owner'] }, gymId = gymA) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { requestId: 'links-test', gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock });
    await next();
  });
  app.onError((error, c) => c.json(errorResponse(error, 'links-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createSignedLinksRoutes(sending) }).mount(app, authorize, new Set());
  return app;
}
function staff(role: StaffRole, gymId = gymA): Principal { return { kind: 'staff', gymId, userId, roles: [role] }; }
const post = (app: ReturnType<typeof server>, path: string, body?: unknown) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
async function active(purpose: SignedLinkPurposeName): Promise<SignedLinkPrincipal> {
  const created = await service.create(mutation, request(purpose));
  const resolved = await service.resolve(gymA, created.token);
  expect(resolved.status).toBe('active');
  if (resolved.status !== 'active') throw new Error('Expected active link');
  return resolved.principal;
}
const householdScope = (link: SignedLinkPrincipal) => ({ kind: 'signed_link' as const, gymId: link.gymId, linkId: link.linkId, now: clock.now() });

describe('signed link creation and metadata', () => {
  it.each(['onboarding', 'update_card', 'pay_invoice', 'sign_waiver'] as const)('creates a scoped %s credential with only a SHA-256 digest stored', async (purpose) => {
    const result = await service.create(mutation, request(purpose));
    expect(createSignedLinkResponseSchema.safeParse({ data: result }).success).toBe(true);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await database.forGym(gymA, (tx) => tx.select().from(signedLinks).where(eq(signedLinks.id, result.link.id)));
    expect(stored!.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(stored!.createdAt).toEqual(clock.now());
    expect(result.link.invoiceId).toBe(purpose === 'pay_invoice' ? invoiceA : null);
    expect(result.link.memberId).toBe(purpose === 'sign_waiver' ? memberA : null);
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, result.link.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'signed_link.created', actorKind: 'system', occurredAt: clock.now(), after: result.link });
    for (const data of [stored, audits, await service.get(gymA, result.link.id), await service.list(gymA)])
      expect(JSON.stringify(data)).not.toContain(result.token);
    for (const data of [audits, result.link, await service.get(gymA, result.link.id), await service.list(gymA)])
      expect(JSON.stringify(data)).not.toMatch(/tokenHash|token_hash/);
    const resolution = await service.resolve(gymA, result.token);
    expect(resolution).toMatchObject({ status: 'active', principal: {
      kind: 'signed_link', gymId: gymA, householdId: householdA, linkId: result.link.id, link: { purpose },
    } });
    expect(JSON.stringify(resolution)).not.toMatch(/tokenHash|token_hash/);
  });
  it('issues fresh independent tokens', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => service.create(mutation, request())));
    expect(new Set(results.map((result) => result.token)).size).toBe(20);
    expect(new Set(results.map((result) => result.link.id)).size).toBe(20);
  });
  it.each(['2026-10-22T12:00:00Z', '2026-10-21T12:00:00Z'])('rejects non-future expiry %s', async (expiresAt) => {
    await expect(service.create(mutation, { ...request(), expiresAt })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('rejects every invalid purpose/resource pairing even for direct service calls', async () => {
    const invalid = [
      { ...request(), invoiceId: invoiceA }, { ...request(), memberId: memberA },
      { ...request('pay_invoice'), memberId: memberA }, { ...request('pay_invoice'), invoiceId: undefined },
      { ...request('sign_waiver'), invoiceId: invoiceA }, { ...request('sign_waiver'), memberId: undefined },
      { ...request('onboarding'), memberId: memberA }, { ...request(), purpose: 'unknown' },
    ];
    for (const input of invalid)
      await expect(service.create(mutation, input as CreateSignedLinkRequest)).rejects.toThrow();
  });
  it('rejects wrong-household, missing, and cross-gym resources without inserting or auditing', async () => {
    const before = await service.list(gymA);
    const cases = [
      { ...request(), householdId: householdB }, { ...request(), householdId: uuidv7() },
      ...[invoiceOther, invoiceB, uuidv7()].map((invoiceId) => ({ ...request('pay_invoice'), invoiceId })),
      ...[memberOther, memberB, uuidv7()].map((memberId) => ({ ...request('sign_waiver'), memberId })),
    ];
    for (const input of cases) await expect(service.create(mutation, input as CreateSignedLinkRequest)).rejects.toMatchObject({ code: 'not_found' });
    expect((await service.list(gymA)).pagination.total).toBe(before.pagination.total);
  });
  it('validates campaign gym and purpose and paginates with all filters', async () => {
    const campaign = await factory('linkCampaigns', gymA, { purpose: 'update_card' });
    const foreign = await factory('linkCampaigns', gymB);
    await expect(service.create(mutation, { ...request(), campaignId: foreign.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.create(mutation, { ...request('pay_invoice'), campaignId: campaign.id })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.create(mutation, { ...request(), campaignId: uuidv7() })).rejects.toMatchObject({ code: 'not_found' });
    const created = await Promise.all([service.create(mutation, { ...request(), campaignId: campaign.id }), service.create(mutation, { ...request(), campaignId: campaign.id })]);
    const page = await service.list(gymA, { campaignId: campaign.id, householdId: householdA, purpose: 'update_card', limit: 1, offset: 1 });
    expect(page.pagination).toEqual({ total: 2, limit: 1, offset: 1 });
    expect(page.data).toHaveLength(1);
    expect(created.map((item) => item.link.id)).toContain(page.data[0]!.id);
    expect(signedLinkListResponseSchema.safeParse(page).success).toBe(true);
    expect((await service.list(gymA, { purpose: 'onboarding', campaignId: campaign.id })).data).toEqual([]);
    expect((await service.list(gymB, { campaignId: campaign.id })).data).toEqual([]);
  });
});

describe('token lifecycle', () => {
  it('returns not_found for missing, malformed, modified, and cross-gym credentials', async () => {
    const created = await service.create(mutation, request());
    for (const token of ['', 'short', '../' + created.token, 'a'.repeat(257), 'Z' + created.token, 'a'.repeat(43)])
      expect(await service.resolve(gymA, token)).toEqual({ status: 'not_found' });
    expect(await service.resolve(gymB, created.token)).toEqual({ status: 'not_found' });
    await expect(service.get(gymB, created.link.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.revoke({ ...mutation, gymId: gymB }, created.link.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.markUsed({ gymId: gymB, linkId: created.link.id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('expires at the exact clock instant, including offset timestamp input', async () => {
    const created = await service.create(mutation, { ...request(), expiresAt: '2026-10-22T05:00:01-07:00' });
    const initial = clock.now();
    try {
      clock.advance(999); expect((await service.resolve(gymA, created.token)).status).toBe('active');
      clock.advance(1); expect(await service.resolve(gymA, created.token)).toEqual({ status: 'expired' });
      await expect(service.markUsed({ gymId: gymA, linkId: created.link.id })).rejects.toMatchObject({ code: 'conflict' });
      await expect(database.forHousehold({ kind: 'signed_link', gymId: gymA, linkId: created.link.id, now: clock.now() }, (q) => q.paymentMethods())).rejects.toThrow();
    } finally { clock.set(initial); }
  });
  it('consumes exactly once under concurrent completion and audits once', async () => {
    const created = await service.create(mutation, request());
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => service.markUsed({ gymId: gymA, linkId: created.link.id })));
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((item) => item.status === 'rejected');
    expect(failures).toHaveLength(11);
    for (const failure of failures) expect(failure.reason).toMatchObject({ code: 'conflict' });
    expect(await service.resolve(gymA, created.token)).toEqual({ status: 'used' });
    expect((await service.get(gymA, created.link.id)).usedAt).toBe(clock.now().toISOString());
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, created.link.id), eq(auditEvents.action, 'signed_link.used'))));
    expect(audits).toHaveLength(1);
    await expect(database.forHousehold({ kind: 'signed_link', gymId: gymA, linkId: created.link.id, now: clock.now() }, (q) => q.paymentMethods())).rejects.toThrow();
  });
  it('revokes idempotently, audits the staff actor and rejects later use', async () => {
    const created = await service.create(mutation, request());
    const actor = { gymId: gymA, actor: { kind: 'user', userId } } as const;
    const results = await Promise.all([service.revoke(actor, created.link.id), service.revoke(actor, created.link.id)]);
    expect(results[0]).toEqual(results[1]);
    expect(await service.resolve(gymA, created.token)).toEqual({ status: 'revoked' });
    await expect(service.markUsed({ gymId: gymA, linkId: created.link.id })).rejects.toMatchObject({ code: 'conflict' });
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, created.link.id), eq(auditEvents.action, 'signed_link.revoked'))));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: 'user', actorUserId: userId, occurredAt: clock.now() });
    await expect(database.forHousehold({ kind: 'signed_link', gymId: gymA, linkId: created.link.id, now: clock.now() }, (q) => q.paymentMethods())).rejects.toThrow();
  });
  it('serializes a revoke/use race so revoked links cannot subsequently be used', async () => {
    const created = await service.create(mutation, request());
    await Promise.allSettled([service.revoke(mutation, created.link.id), service.markUsed({ gymId: gymA, linkId: created.link.id })]);
    expect((await service.resolve(gymA, created.token)).status).not.toBe('active');
    await expect(service.markUsed({ gymId: gymA, linkId: created.link.id })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('resolved principals and real household authorization', () => {
  it('pay_invoice reaches only the bound invoice, including against sibling invoices in the same household', async () => {
    const link = await active('pay_invoice'), scope = householdScope(link);
    expect(link.link).toEqual({ purpose: 'pay_invoice', invoiceId: invoiceA });
    expect((await database.forHousehold(scope, (q) => q.invoices())).map((row) => row.id)).toEqual([invoiceA]);
    for (const id of [invoiceSibling, invoiceOther, invoiceB]) expect(await database.forHousehold(scope, (q) => q.invoice(id))).toEqual([]);
    for (const query of ['members', 'paymentMethods', 'household', 'waiverTemplates', 'attendance'] as const)
      await expect(database.forHousehold(scope, async (q): Promise<unknown> => q[query]())).rejects.toThrow();
  });
  it('sign_waiver reaches only the bound member and never cards, household profile, or invoices', async () => {
    const link = await active('sign_waiver'), scope = householdScope(link);
    expect(link.link).toEqual({ purpose: 'sign_waiver', memberId: memberA });
    expect((await database.forHousehold(scope, (q) => q.members())).map((row) => row.id)).toEqual([memberA]);
    for (const id of [siblingA, memberOther, memberB]) expect(await database.forHousehold(scope, (q) => q.member(id))).toEqual([]);
    for (const query of ['invoices', 'paymentMethods', 'household', 'ranks'] as const)
      await expect(database.forHousehold(scope, async (q): Promise<unknown> => q[query]())).rejects.toThrow();
  });
  it('update_card reaches only masked cards in its household', async () => {
    const scope = householdScope(await active('update_card'));
    const cards = await database.forHousehold(scope, (q) => q.paymentMethods());
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards)).not.toContain('private_processor_identifier');
    for (const query of ['members', 'invoices', 'household', 'waiverTemplates'] as const)
      await expect(database.forHousehold(scope, async (q): Promise<unknown> => q[query]())).rejects.toThrow();
  });
  it('onboarding reaches household members and cards while denying invoices and profiles', async () => {
    const scope = householdScope(await active('onboarding'));
    expect((await database.forHousehold(scope, (q) => q.members())).map((row) => row.id).sort()).toEqual([memberA, siblingA].sort());
    for (const id of [memberOther, memberB]) expect(await database.forHousehold(scope, (q) => q.member(id))).toEqual([]);
    expect(await database.forHousehold(scope, (q) => q.paymentMethods())).toHaveLength(1);
    for (const query of ['invoices', 'household', 'bookings'] as const)
      await expect(database.forHousehold(scope, async (q): Promise<unknown> => q[query]())).rejects.toThrow();
  });
  it('reloads database authorization even if a caller fabricates display metadata', async () => {
    const link = await active('pay_invoice');
    const forged = { ...link, householdId: householdOther, link: { purpose: 'onboarding' as const } };
    expect(await database.forHousehold(householdScope(forged), (q) => q.invoice(invoiceOther))).toEqual([]);
    await expect(database.forHousehold(householdScope(forged), (q) => q.members())).rejects.toThrow();
    await expect(database.forHousehold({ ...householdScope(link), gymId: gymB }, (q) => q.invoices())).rejects.toThrow();
  });
});

describe('signed link HTTP contracts and permissions', () => {
  it.each(staffRoles)('checks every endpoint for %s and returns only contract metadata', async (role) => {
    const app = server(staff(role)), allowed = role !== 'coach';
    const created = await service.create(mutation, request());
    const results = [
      [await post(app, '/api/links', request()), createSignedLinkResponseSchema],
      [await post(app, '/api/links/send', request()), signedLinkResponseSchema],
      [await app.request('/api/links?limit=1'), signedLinkListResponseSchema],
      [await app.request(`/api/links/${created.link.id}`), signedLinkResponseSchema],
      [await post(app, `/api/links/${created.link.id}/revoke`), signedLinkResponseSchema],
    ] as const;
    for (const [response, schema] of results) {
      expect(response.status).toBe(allowed ? 200 : 403);
      if (allowed) {
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(schema.safeParse(await response.json()).success).toBe(true);
      }
    }
    expect((await post(app, '/api/links', {})).status).toBe(allowed ? 400 : 403);
    expect((await post(app, '/api/links/send', {})).status).toBe(allowed ? 400 : 403);
  });
  it('denies anonymous and other principal kinds before validation on every route', async () => {
    const principals: Principal[] = [
      { kind: 'anonymous' }, { kind: 'kiosk', gymId: gymA, deviceId: uuidv7() },
      { kind: 'member', userId, scope: { gymId: gymA, householdId: householdA, role: 'payer' } },
      await active('update_card'), staff('owner', gymB),
    ];
    for (const principal of principals) {
      const app = server(principal), status = principal.kind === 'anonymous' ? 401 : 403;
      expect((await post(app, '/api/links', {})).status).toBe(status);
      expect((await post(app, '/api/links/send', {})).status).toBe(status);
      expect((await app.request('/api/links?limit=bad')).status).toBe(status);
      expect((await app.request('/api/links/bad')).status).toBe(status);
      expect((await post(app, '/api/links/bad/revoke')).status).toBe(status);
    }
  });
  it('returns 404 for other-gym targets through create, send, get, and revoke and excludes them from lists', async () => {
    const app = server(staff('owner'));
    const foreign = await service.create({ ...mutation, gymId: gymB }, { ...request(), householdId: householdB });
    for (const path of ['/api/links', '/api/links/send']) {
      expect((await post(app, path, { ...request(), householdId: householdB })).status).toBe(404);
      expect((await post(app, path, { ...request('pay_invoice'), invoiceId: invoiceB })).status).toBe(404);
      expect((await post(app, path, { ...request('sign_waiver'), memberId: memberB })).status).toBe(404);
    }
    expect((await app.request(`/api/links/${foreign.link.id}`)).status).toBe(404);
    expect((await post(app, `/api/links/${foreign.link.id}/revoke`)).status).toBe(404);
    const list = await app.request(`/api/links?householdId=${householdB}`);
    expect(list.status).toBe(200); expect(await list.json()).toMatchObject({ data: [], pagination: { total: 0 } });
    expect((await service.resolve(gymB, foreign.token)).status).toBe('active');
  });
  it('uses a configured canonical origin for email and never exposes the secret through send or metadata reads', async () => {
    const result = await post(server(), '/api/links/send', request());
    expect(result.status).toBe(200);
    const body = signedLinkResponseSchema.parse(await result.json());
    const message = email.messages.at(-1)!;
    expect(message.to).toBe('payer@example.test');
    const token = /https:\/\/gym[.]example[.]test\/l\/([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
    expect((await service.resolve(gymA, token)).status).toBe('active');
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(await service.get(gymA, body.data.id))).not.toContain(token);
  });
});

describe('email failure and suppression', () => {
  it('requires explicit delivery configuration and does not mint a token when absent', async () => {
    const before = (await service.list(gymA)).pagination.total;
    await expect(service.send(mutation, request())).rejects.toMatchObject({ code: 'unavailable' });
    expect((await service.list(gymA)).pagination.total).toBe(before);
  });
  it('does not prepare or deliver email inside a transaction', async () => {
    await expect(runInTransaction(() => sending.send(mutation, request()))).rejects.toThrow();
  });
  it.each(['transport', 'suppressed'] as const)('revokes the fresh token on %s failure and hides transport errors', async (failure) => {
    email.respondNext(failure === 'transport' ? new Error('SMTP private credentials') : { status: 'suppressed', reason: 'disabled' });
    await expect(sending.send(mutation, request())).rejects.toMatchObject({ code: 'unavailable', message: 'Signed link email was not delivered' });
    const newest = (await service.list(gymA, { limit: 1 })).data[0]!;
    expect(newest.revokedAt).toBe(clock.now().toISOString());
    expect(newest.usedAt).toBeNull();
  });
  it.each([
    { origin: 'https://evil.test/path' }, { origin: 'https://user:pass@evil.test' }, { origin: 'javascript:alert(1)' },
    { gymId: gymB }, { memberEmailsEnabled: false },
  ])('rejects invalid configuration before creating a credential: %j', async (changes) => {
    const configured = createSignedLinksService({ scope: database.forGym, clock, delivery: { async prepare() { return { ...delivery, ...changes }; } } });
    const before = (await service.list(gymA)).pagination.total;
    await expect(configured.send(mutation, request())).rejects.toThrow();
    expect((await service.list(gymA)).pagination.total).toBe(before);
  });
  it.each([{ emailOptOut: true }, { emailDeliverable: false }])('respects member suppression %j and revokes the undisclosed credential', async (flags) => {
    const household = await factory('households', gymA, { email: 'suppressed@example.test' });
    await factory('members', gymA, { householdId: household.id, email: household.email, ...flags });
    const before = email.messages.length;
    await expect(sending.send(mutation, { ...request(), householdId: household.id })).rejects.toMatchObject({ code: 'unavailable' });
    expect(email.messages).toHaveLength(before);
    expect((await service.list(gymA, { householdId: household.id })).data[0]!.revokedAt).not.toBeNull();
  });
  it('refuses missing household email without sending to a fallback member', async () => {
    const before = email.messages.length;
    await expect(sending.send(mutation, { ...request(), householdId: householdOther })).rejects.toMatchObject({ code: 'unavailable' });
    expect(email.messages).toHaveLength(before);
  });
});