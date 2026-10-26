// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, invoices, waiverSignatures, uuidv7 } from '@plaingym/db';
import { createTranslator } from '@plaingym/shared';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { portalSignedLinkContracts as contracts, signedLinkActionContracts as actions, type SignedLinkPurposeName } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import { createSignedLinksService } from '../../areas/links/service.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { createSignedLinkCheckout, CustomerNotLinked } from '../../areas/billing/signed-link-checkout.js';
import { createInvoiceTransitions } from '../../areas/billing/transitions/index.js';
import { registerBillingWebhookHandlers } from '../../areas/billing/webhooks/handlers/index.js';
import type { WebhookHandler } from '../../areas/billing/webhooks/inbox.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { configureLinkPages } from './links.routes.js';
import { cachedLinkAsset } from './assets.js';
import type { Principal } from '../../core/context.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture(purpose: SignedLinkPurposeName = 'pay_invoice', customer = true) {
  const clock = new TestClock('2026-10-25T12:00:00Z'), gymId = uuidv7();
  await factory('gyms', gymId);
  const household = await factory('households', gymId, { stripeCustomerId: customer ? 'cus_' + gymId : null });
  const member = await factory('members', gymId, { householdId: household.id, firstName: 'Target', dateOfBirth: '2020-01-01' });
  const sibling = await factory('members', gymId, { householdId: household.id, firstName: 'Sibling' });
  const other = await factory('members', gymId, { firstName: 'Other household' });
  const invoice = await factory('invoices', gymId, { householdId: household.id, number: 1, status: 'open' });
  const invoiceB = await factory('invoices', gymId, { householdId: household.id, number: 2, status: 'open' });
  const template = await factory('waiverTemplates', gymId, { name: 'Participation', body: 'Read these original terms.' });
  const links = createSignedLinksService({ scope: db.forGym, clock });
  const mutation = { gymId, actor: { kind: 'system' as const } };
  const create = (kind: SignedLinkPurposeName = purpose) => links.create(mutation, { householdId: household.id,
    expiresAt: new Date(clock.now().getTime() + 7 * 86400_000).toISOString(),
    ...(kind === 'pay_invoice' ? { purpose: kind, invoiceId: invoice.id } : kind === 'sign_waiver' ? { purpose: kind, memberId: member.id } : { purpose: kind }) });
  const link = await create();
  const provider = new FakePayments(gymId, clock), uploads = new FakeUploads(gymId, clock);
  const waivers = createWaiversService({ scope: db.forGym, clock, uploadsFor: async () => uploads });
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor: async () => provider, originFor: async () => 'https://gym.example.test' });
  const service = configureLinkPages({ scope: db.forHousehold, waivers, checkout, links, receiptKey: new Uint8Array(32).fill(7), stylesheet: async () => '' });
  const app = (resolvedGym = gymId, principal: Principal = { kind: 'anonymous' }) => createApp({ clock, skipSetup: true, authorize,
    origin: 'https://gym.example.test', contributions: areaContributions,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: resolvedGym, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
    rateLimit: { limit: 10000 },
  });
  const handlers = new Map<string, WebhookHandler>();
  const transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  registerBillingWebhookHandlers({ register(type, handler) { handlers.set(type, handler); } }, { scope: db.forGym, clock, transitions });
  async function completeAtStripe(sessionId: string) {
    const session = provider.completeCheckout(sessionId);
    await handlers.get('checkout.session.completed')!({ id: 'evt_' + uuidv7(), type: 'checkout.session.completed', gymId, objectId: session.id, objectKind: 'checkout' },
      { gymId, clock, timezone: 'UTC', attempt: 1, jobId: uuidv7(), payments: provider });
    return session;
  }
  const path = '/api/links/' + purpose.replaceAll('_', '-');
  const request = (url: string = path, method = 'GET', body: unknown = {}, cookie = '', token = link.token, server = app()) => server.request('https://gym.example.test' + url, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', origin: 'https://gym.example.test', ...(cookie ? { cookie } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { gymId, clock, household, member, sibling, other, invoice, invoiceB, template, links, link, create, provider, uploads, waivers, checkout, service, app, request, path, mutation, completeAtStripe };
}
describe('signed-link pages through production registrations', () => {
  async function signatureInput(f: Awaited<ReturnType<typeof fixture>>, template = f.template) {
    const response = await f.request(f.path + '/signature-images', 'POST', { pngBase64: demoSignaturePng().toString('base64') });
    expect(response.status).toBe(200);
    return { ...actions.uploadWaiver.response.parse(await response.json()).data, templateId: template.id, templateVersion: template.version,
      consent: true, signer: { kind: 'guardian', name: 'Parent', relationship: 'Parent' } };
  }
  it('keeps the second document usable and consumes the link only with the last current signature', async () => {
    const f = await fixture('sign_waiver');
    const agreement = await factory('waiverTemplates', f.gymId, { name: 'Agreement', kind: 'agreement' });
    expect((await f.request(f.path, 'POST', await signatureInput(f))).status).toBe(200);
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('active');
    const page = await f.app().request('/l/' + f.link.token + '?tablet=1');
    expect(page.status).toBe(200); expect(await page.text()).toContain('data-template="' + agreement.id + '"');
    expect((await f.request()).status).toBe(200);
    expect((await f.request(f.path, 'POST', await signatureInput(f, agreement))).status).toBe(200);
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('used');
    expect(await (await f.app().request('/l/' + f.link.token)).text()).toContain('Already done');
  });
  it('concurrent signing of two documents persists exactly two signatures and one consumption', async () => {
    const f = await fixture('sign_waiver');
    const agreement = await factory('waiverTemplates', f.gymId, { name: 'Agreement', kind: 'agreement' });
    const inputs = await Promise.all([signatureInput(f), signatureInput(f, agreement)]);
    const results = await Promise.all(inputs.map(input => f.request(f.path, 'POST', input)));
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures))).toHaveLength(2);
    expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'signed_link.used')))).toHaveLength(1);
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('used');
  });
  it('requires the latest active version and ignores retired families rather than reviving old versions', async () => {
    const f = await fixture('sign_waiver');
    const old = await signatureInput(f);
    // A staff signature on the older version must not satisfy the new current version.
    await f.waivers.sign(f.mutation, { ...old, consent: true, signer: { kind: 'guardian', name: 'Parent', relationship: 'Parent' }, memberId: f.member.id }, { timezone: 'UTC', ipAddress: 'unknown' });
    const current = await factory('waiverTemplates', f.gymId, { name: f.template.name, version: 2 });
    const retired = await factory('waiverTemplates', f.gymId, { name: 'Retired family', version: 1 });
    await factory('waiverTemplates', f.gymId, { name: retired.name, version: 2, retiredAt: f.clock.now() });
    const data = contracts.waiver.response.parse(await (await f.request()).json()).data;
    expect(data.templates.map(t => t.id)).toEqual([current.id]);
    expect(await (await f.app().request('/l/' + f.link.token)).text()).toContain('data-waiver');
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('active');
    expect((await f.request(f.path, 'POST', await signatureInput(f, current))).status).toBe(200);
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('used');
  });
  it('completes an already-fully-signed member link on first open without exposing documents', async () => {
    const f = await fixture('sign_waiver'), input = await signatureInput(f);
    await f.waivers.sign(f.mutation, { ...input, consent: true, signer: { kind: 'guardian', name: 'Parent', relationship: 'Parent' }, memberId: f.member.id }, { timezone: 'UTC', ipAddress: 'unknown' });
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('active');
    const response = await f.app().request('/l/' + f.link.token);
    expect(response.status).toBe(200);
    const page = await response.text(); expect(page).toContain('Already done'); expect(page).not.toContain('original terms');
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('used');
    expect((await f.request()).status).toBe(404);
  });
  it('renders a friendly HTML unavailable page for a non-active invoice resource', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'draft', number: null }).where(eq(invoices.id, f.invoice.id)));
    const response = await f.app().request('/l/' + f.link.token);
    expect(response.status).toBe(404); expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('This link is unavailable');
  });
  it('uses the configured translation and gym locale on resource, cleared and return pages', async () => {
    const f = await fixture();
    configureLinkPages({ scope: db.forHousehold, waivers: f.waivers, checkout: f.checkout, links: f.links, receiptKey: new Uint8Array(32).fill(7),
      t: createTranslator({ 'public/links': { cleared: 'Effacé', unavailable: 'Indisponible', pay_invoice: 'Payer' } }), localeFor: gymId => { expect(gymId).toBe(f.gymId); return 'fr-CA'; } });
    for (const [path, title] of [['/l/cleared', 'Effacé'], ['/l/return', 'Indisponible'], ['/l/' + f.link.token, 'Payer']]) {
      const page = await (await f.app().request(path!)).text(); expect(page).toContain(title); expect(page).toContain('lang="fr-CA"');
    }
  });
  it('returns a controlled unavailable response for missing built assets, logging each failure once', async () => {
    const f = await fixture(), log = vi.fn();
    const read = vi.fn(async (): Promise<string> => { throw new Error('ENOENT'); });
    configureLinkPages({ scope: db.forHousehold, waivers: f.waivers, checkout: f.checkout, links: f.links, receiptKey: new Uint8Array(32).fill(7),
      stylesheet: cachedLinkAsset('links.css', read, log), browserScript: cachedLinkAsset('links.js', read, log) });
    for (const path of ['/l/styles.css', '/l/client.js']) for (let i = 0; i < 2; i++) {
      const response = await f.app().request(path); expect(response.status).toBe(503);
      expect(await response.text()).toContain('Signed-link assets are unavailable');
    }
    expect(log).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledTimes(2);
  });
  it('exposes only invoice A; selectors cannot widen it to invoice B or another household', async () => {
    const f = await fixture();
    const response = await f.request(); expect(response.status).toBe(200);
    const data = contracts.invoice.response.parse(await response.json());
    expect(data.data.invoice.invoice.id).toBe(f.invoice.id);
    for (const id of [f.invoiceB.id, uuidv7()]) {
      expect((await f.request(f.path + '?invoiceId=' + id)).status).toBe(400);
      expect((await f.request(f.path + '/checkout', 'POST', { invoiceId: id })).status).toBe(400);
    }
    for (const purpose of ['sign-waiver', 'update-card', 'onboarding']) expect((await f.request('/api/links/' + purpose)).status).toBe(403);
    const otherGym = uuidv7(); await factory('gyms', otherGym);
    expect((await f.request(f.path, 'GET', {}, '', f.link.token, f.app(otherGym))).status).toBe(404);
  });
  it('a member waiver hides siblings, invoices, cards and cross-household upload targets', async () => {
    const f = await fixture('sign_waiver');
    const response = await f.request(); expect(response.status).toBe(200);
    const text = await response.text(); expect(text).toContain(f.member.id); expect(text).not.toContain(f.sibling.id); expect(text).not.toContain(f.other.id);
    for (const purpose of ['pay-invoice', 'update-card', 'onboarding']) expect((await f.request('/api/links/' + purpose)).status).toBe(403);
    for (const memberId of [f.sibling.id, f.other.id]) expect((await f.request(f.path + '/signature-images', 'POST', { memberId, pngBase64: demoSignaturePng().toString('base64') })).status).toBe(400);
    const page = await f.app().request('/l/' + f.link.token + '?tablet=1');
    expect(page.status).toBe(200); expect(await page.text()).toContain('parent or guardian must sign');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer'); expect(page.headers.get('cache-control')).toContain('no-store');
  });
  for (const state of ['used', 'revoked', 'expired'] as const) it(`${state} links cannot read or write; used pages are friendly and private`, async () => {
    const f = await fixture('sign_waiver');
    if (state === 'used') await f.links.markUsed({ gymId: f.gymId, linkId: f.link.link.id });
    if (state === 'revoked') await f.links.revoke(f.mutation, f.link.link.id);
    if (state === 'expired') f.clock.set(f.link.link.expiresAt);
    expect((await f.request()).status).toBe(404);
    expect((await f.request(f.path + '/signature-images', 'POST', { pngBase64: demoSignaturePng().toString('base64') })).status).toBe(404);
    const response = await f.app().request('/l/' + f.link.token);
    expect(response.status).toBe(state === 'used' ? 200 : 404);
    const html = await response.text(); expect(html).toContain(state === 'used' ? 'Already done' : 'This link is unavailable');
    expect(html).not.toContain('Target'); expect(html).not.toContain('original terms');
  });
  it('uploads through the waiver service, requires a guardian, stores immutable original terms, and consumes the link atomically', async () => {
    const f = await fixture('sign_waiver');
    const upload = await f.request(f.path + '/signature-images', 'POST', { pngBase64: demoSignaturePng().toString('base64') });
    expect(upload.status).toBe(200);
    const image = actions.uploadWaiver.response.parse(await upload.json()).data;
    const input = { ...image, templateId: f.template.id, templateVersion: 1, consent: true, signer: { kind: 'self', name: 'Child' } };
    expect((await f.request(f.path, 'POST', input)).status).toBe(400);
    const signed = await f.request(f.path, 'POST', { ...input, signer: { kind: 'guardian', name: 'Parent', relationship: 'Mother' } });
    expect(signed.status, await signed.clone().text()).toBe(200);
    const signature = contracts.signWaiver.response.parse(await signed.json()).data;
    expect(signature.snapshot).toContain('Read these original terms.');
    expect(signature.snapshot).toContain('Mother');
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('used');
    expect((await f.request(f.path, 'POST', input)).status).toBe(404);
  });
  it('rechecks revocation after image storage and before signing commits', async () => {
    const f = await fixture('sign_waiver'), put = f.uploads.put.bind(f.uploads);
    vi.spyOn(f.uploads, 'put').mockImplementation(async (...args) => { const result = await put(...args); await f.links.revoke(f.mutation, f.link.link.id); return result; });
    await expect(f.waivers.uploadSignedLink(f.gymId, f.link.link.id, f.member.id, demoSignaturePng())).rejects.toThrow();
    expect(await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures))).toHaveLength(0);
  });
  it('rejects siblings and other households again inside the waiver service, and revocation during rendering rolls back signing', async () => {
    const f = await fixture('sign_waiver');
    for (const id of [f.sibling.id, f.other.id]) await expect(f.waivers.uploadSignedLink(f.gymId, f.link.link.id, id, demoSignaturePng())).rejects.toThrow();
    const image = await f.waivers.uploadSignedLink(f.gymId, f.link.link.id, f.member.id, demoSignaturePng());
    const guarded = createWaiversService({ scope: db.forGym, clock: f.clock, uploadsFor: async () => f.uploads,
      render: async () => { await f.links.revoke(f.mutation, f.link.link.id); return new Uint8Array(); } });
    await expect(guarded.signSignedLink(f.gymId, f.link.link.id, { ...image, memberId: f.member.id, templateId: f.template.id, templateVersion: 1,
      consent: true, signer: { kind: 'guardian', name: 'Parent', relationship: 'Parent' } }, { timezone: 'UTC', ipAddress: 'unknown' })).rejects.toThrow();
    expect(await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures))).toHaveLength(0);
  });
  it('concurrent single-use signing creates exactly one immutable signature', async () => {
    const f = await fixture('sign_waiver');
    const image = await f.waivers.uploadSignedLink(f.gymId, f.link.link.id, f.member.id, demoSignaturePng());
    const input = { ...image, memberId: f.member.id, templateId: f.template.id, templateVersion: 1,
      consent: true as const, signer: { kind: 'guardian' as const, name: 'Parent', relationship: 'Parent' } };
    const results = await Promise.allSettled([1, 2].map(() => f.waivers.signSignedLink(f.gymId, f.link.link.id, input, { timezone: 'UTC', ipAddress: 'unknown' })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures))).toHaveLength(1);
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('used');
  });
  it('concurrent Checkout requests converge; unknown sessions are never replaced, confirmed expired sessions can be renewed', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.checkout.start(f.gymId, f.link.link.id), f.checkout.start(f.gymId, f.link.link.id)]);
    expect(a.session.id).toBe(b.session.id);
    f.provider.setUncertain(a.session.id);
    await expect(f.checkout.start(f.gymId, f.link.link.id)).rejects.toThrow('not available');
    f.provider.setUncertain(a.session.id, false); await f.provider.expireCheckout(a.session.id);
    const replacement = await f.checkout.start(f.gymId, f.link.link.id);
    expect(replacement.session.id).not.toBe(a.session.id);
  });
  it('never hands out Checkout while a charge-runner attempt is unresolved, including a reservation during the provider call', async () => {
    const f = await fixture();
    const create = f.provider.createCheckout.bind(f.provider);
    let sessionId = '';
    vi.spyOn(f.provider, 'createCheckout').mockImplementation(async input => {
      const session = await create(input); sessionId = session.id;
      await factory('paymentAttempts', f.gymId, { invoiceId: f.invoice.id, amountCents: f.invoice.amountCents, currency: f.invoice.currency,
        stripeCustomerId: f.household.stripeCustomerId!, savedPaymentMethod: 'pm_existing', status: 'pending', attemptNumber: 1 });
      return session;
    });
    await expect(f.checkout.start(f.gymId, f.link.link.id)).rejects.toThrow('cannot be paid');
    expect(await f.provider.readPaymentObject({ kind: 'checkout', id: sessionId })).toMatchObject({ status: 'found', value: { object: { status: 'expired' } } });
    await expect(f.checkout.start(f.gymId, f.link.link.id)).rejects.toThrow('cannot be paid');
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('active');
  });
  it('starts and reuses invoice Checkout, then waits for the webhook handler to apply the real invoice transitions', async () => {
    const f = await fixture();
    const first = await f.checkout.start(f.gymId, f.link.link.id), again = await f.checkout.start(f.gymId, f.link.link.id);
    expect(again.session.id).toBe(first.session.id); expect(first.session.metadata).toMatchObject({ gymId: f.gymId, invoiceId: f.invoice.id });
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('active');
    expect(await f.checkout.complete(f.gymId, f.link.link.id, first.session.id)).toBe(false);
    await f.completeAtStripe(first.session.id);
    expect(await f.checkout.complete(f.gymId, f.link.link.id, first.session.id)).toBe(true);
    expect((await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, f.invoice.id))))[0]?.status).toBe('paid');
  });
  it('retries a lost invoice Checkout response within its window and reserves a new key after expiry', async () => {
    const f = await fixture(); f.provider.loseNextResponse('createCheckout');
    await expect(f.checkout.start(f.gymId, f.link.link.id)).rejects.toThrow();
    const recovered = await f.checkout.start(f.gymId, f.link.link.id); expect(recovered.session.mode).toBe('payment');
    const g = await fixture(); g.provider.loseNextResponse('createCheckout');
    const create = vi.spyOn(g.provider, 'createCheckout');
    await expect(g.checkout.start(g.gymId, g.link.link.id)).rejects.toThrow();
    g.clock.advance(24 * 60 * 60 * 1000);
    const later = await g.checkout.start(g.gymId, g.link.link.id);
    expect(later.session.mode).toBe('payment');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].idempotencyKey).not.toBe(create.mock.calls[0]![0].idempotencyKey);
    expect((await g.checkout.start(g.gymId, g.link.link.id)).session.id).toBe(later.session.id);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await db.forGym(g.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.checkout.reservation_renewed')))).toHaveLength(1);
  });
  it('uses the existing customer for setup, with gym metadata on session and SetupIntent; abandoned setup remains usable', async () => {
    const f = await fixture('update_card');
    const spy = vi.spyOn(f.provider, 'createCheckout');
    const session = await f.checkout.start(f.gymId, f.link.link.id);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ customerId: f.household.stripeCustomerId, mode: 'setup' });
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('customerEmail');
    expect(session.session.metadata.gymId).toBe(f.gymId);
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('active');
    expect(await f.checkout.complete(f.gymId, f.link.link.id, session.session.id)).toBe(false);
    const completed = f.provider.completeCheckout(session.session.id);
    expect(await f.provider.readPaymentObject({ kind: 'setup', id: completed.setupId! })).toMatchObject({ status: 'found', value: { object: { metadata: { gymId: f.gymId } } } });
    expect(await f.checkout.complete(f.gymId, f.link.link.id, session.session.id)).toBe(false);
    await f.completeAtStripe(session.session.id);
    expect(await f.checkout.complete(f.gymId, f.link.link.id, session.session.id)).toBe(true);
  });
  it('shows the friendly unavailable state without creating a new customer', async () => {
    const f = await fixture('update_card', false), spy = vi.spyOn(f.provider, 'createCheckout');
    await expect(f.checkout.start(f.gymId, f.link.link.id)).rejects.toBeInstanceOf(CustomerNotLinked);
    expect(spy).not.toHaveBeenCalled();
    expect((await f.request(f.path + '/checkout', 'POST')).status).toBe(503);
  });
  it('combined onboarding completes only after card confirmation and all household documents', async () => {
    const f = await fixture('onboarding');
    expect((await f.request(f.path + '/signature-images', 'POST', { memberId: f.other.id, pngBase64: demoSignaturePng().toString('base64') })).status).toBe(404);
    const session = await f.checkout.start(f.gymId, f.link.link.id); await f.completeAtStripe(session.session.id);
    expect(await f.checkout.complete(f.gymId, f.link.link.id, session.session.id)).toBe(false);
    for (const m of [f.member, f.sibling]) {
      const image = await f.waivers.uploadSignedLink(f.gymId, f.link.link.id, m.id, demoSignaturePng());
      await f.waivers.signSignedLink(f.gymId, f.link.link.id, { memberId: m.id, templateId: f.template.id, templateVersion: 1, ...image, consent: true,
        signer: { kind: 'guardian', name: 'Parent', relationship: 'Mother' } }, { timezone: 'UTC', ipAddress: 'unknown' });
      expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('active');
    }
    expect(await f.checkout.complete(f.gymId, f.link.link.id, session.session.id)).toBe(true);
  });
  it('production composition follows Checkout return cookies and confirms completion without trusting the browser', async () => {
    const f = await fixture('update_card');
    const response = await f.request(f.path + '/checkout', 'POST'); expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const returned = await f.app().request('https://gym.example.test/l/return', { headers: { cookie } });
    expect(returned.headers.get('location')).toBe('/l/' + f.link.token + '?returned=1');
    expect(await (await f.request(f.path + '/complete', 'POST', {}, cookie)).json()).toEqual({ data: { completed: false } });
    const session = await f.checkout.start(f.gymId, f.link.link.id); await f.completeAtStripe(session.session.id);
    expect(await (await f.request(f.path + '/complete', 'POST', {}, cookie)).json()).toEqual({ data: { completed: true } });
    expect(await (await f.app().request('/l/' + f.link.token)).text()).toContain('Already done');
  });
  for (const [name, contract] of Object.entries({ ...contracts, ...actions })) it(`${name} requires its exact link purpose; no staff, portal or kiosk credential substitutes`, async () => {
    const f = await fixture(contract.permission.purpose);
    const server = f.app();
    for (const principal of [{ kind: 'anonymous' }, ...['owner', 'admin', 'coach', 'front_desk'].map(role => ({ kind: 'staff', gymId: f.gymId, userId: uuidv7(), roles: [role] })),
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }, { kind: 'member', userId: uuidv7(), scope: { gymId: f.gymId, householdId: f.household.id, role: 'payer', memberId: null } }] as Principal[]) {
      const response = await f.app(f.gymId, principal).request(contract.path, { method: contract.method.toUpperCase(), headers: { 'content-type': 'application/json' }, ...(contract.method === 'post' ? { body: '{}' } : {}) });
      expect(response.status).toBe(401);
    }
    const other = await f.create(contract.permission.purpose === 'pay_invoice' ? 'update_card' : 'pay_invoice');
    expect((await f.request(contract.path, contract.method.toUpperCase(), {}, '', other.token, server)).status).toBe(403);
    // For write endpoints, invalid payload is reached only after successful authorization.
    const allowed = await f.request(contract.path, contract.method.toUpperCase());
    expect([200, 400]).toContain(allowed.status);
    const gymB = uuidv7(); await factory('gyms', gymB);
    expect((await f.request(contract.path, contract.method.toUpperCase(), {}, '', f.link.token, f.app(gymB))).status).toBe(404);
  });
});
