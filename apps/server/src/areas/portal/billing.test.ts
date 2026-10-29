// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { invoices, paymentMethods, signedLinks, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the default app-role pools for the production registrations; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { portalContracts as contracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../core/app.js';
import { areaContributions } from '../../core/registry-areas.js';
import type { Principal } from '../../core/context.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakePayments, type CheckoutSession } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import type { PdfInput } from '../../infra/pdf/index.js';
import { checkoutReceipts } from '../../public/links/receipt.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createSignedLinksService } from '../links/service.js';
import { createSignedLinkCheckout } from '../billing/signed-link-checkout.js';
import { createWebhookInbox } from '../billing/webhooks/inbox.js';
import { createWebhookInboxRoutes } from '../billing/webhooks/inbox.routes.js';
import { composeBillingWebhooks } from '../billing/webhooks/handlers/composition.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createPortalBillingService } from './billing.js';
import { configurePortalBilling, createPortalBillingRoutes } from './billing.routes.js';
import { adultPrincipal, otherPayerPrincipal, outsidePrincipals, payerPrincipal, portalApp, portalFixture, send } from './household.fixture.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test', secret = 'synthetic-signing-secret';
const receiptKey = new Uint8Array(32).fill(7), receipts = checkoutReceipts(receiptKey);
beforeAll(() => initializeDatabase(db.appUrl));
afterAll(closeDatabase);
async function fixture() {
  const f = await portalFixture(factory, { billingEnabled: true, memberEmailsEnabled: true });
  const clock = new TestClock('2026-10-29T16:00:00Z'), fake = new FakePayments(f.gymId, clock, secret), uploads = new FakeUploads(f.gymId, clock);
  fake.seedCustomer({ id: f.household.stripeCustomerId!, email: f.household.email! });
  const open = await factory('invoices', f.gymId, { householdId: f.household.id, number: 7, status: 'open', amountCents: 2500, dueOn: '2026-10-20' });
  await factory('invoiceLineItems', f.gymId, { householdId: f.household.id, invoiceId: open.id, description: 'Mat fee', amountCents: 2500 });
  const paid = await factory('invoices', f.gymId, { householdId: f.household.id, number: 6, status: 'paid', amountCents: 1000, dueOn: '2026-09-20', paidAt: new Date('2026-09-21T10:00:00Z') });
  await factory('invoiceLineItems', f.gymId, { householdId: f.household.id, invoiceId: paid.id, description: 'Seminar', amountCents: 1000 });
  const draft = await factory('invoices', f.gymId, { householdId: f.household.id, status: 'draft', amountCents: 500, dueOn: '2026-11-20' });
  const other = await factory('invoices', f.gymId, { householdId: f.otherHousehold.id, number: 8, status: 'open', amountCents: 900, dueOn: '2026-10-21' });
  const card = await factory('paymentMethods', f.gymId, { householdId: f.household.id, isDefault: true, expiryMonth: 4, expiryYear: 2029 });
  const revoked = await factory('paymentMethods', f.gymId, { householdId: f.household.id, revokedAt: new Date('2026-10-01Z') });
  const paymentsFor = async () => fake;
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor, originFor: async () => origin });
  const service = createPortalBillingService({ households: createMemberHouseholdContext(db.forGym), householdScope: db.forHousehold, clock,
    links: createSignedLinksService({ scope: db.forGym, clock }), checkout: () => checkout, uploadsFor: () => async () => uploads });
  // The shared webhook inbox records payments and cards through the invoice transitions and the idempotent card writer.
  const jobs = new FakeJobs(clock), settings = createGymSettingsAccessor({ scope: db.forGym, clock });
  const inbox = createWebhookInbox({ scope: db.forGym, system: db.forSystem, clock, jobs, gymSettings: settings, paymentsFor });
  composeBillingWebhooks({ scope: db.forGym, clock, inbox, jobs, settings, paymentsFor, prepare: async () => ({ email: new FakeEmail(), origin }),
    staffRecipients: async () => [], async afterCheckoutRecorded(gymId, linkId, sessionId) {
      try { await checkout.complete(gymId, linkId, sessionId); } catch (error) { if (!(error instanceof AppError && error.code === 'not_found')) throw error; }
    } });
  const webhooks = createApp({ clock, skipSetup: true, contributions: { routes: createWebhookInboxRoutes(inbox) },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (_c, next) => { await next(); }, authorize: () => async (_c, next) => { await next(); } });
  async function webhook(session: CheckoutSession) {
    const eventId = 'evt_' + uuidv7(), body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', gymId: f.gymId, objectKind: 'checkout', objectId: session.id });
    const response = await webhooks.request(origin + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': fake.signWebhook(new TextEncoder().encode(body)) } });
    expect(response.status).toBe(200);
    await inbox.dispatch({ eventId, replay: false }, { gymId: f.gymId, clock, timezone: 'UTC', attempt: 1, jobId: uuidv7() });
  }
  const app = (principal: Principal, production = false) => {
    if (production) configurePortalBilling({ checkout, receiptKey, uploadsFor: async () => uploads });
    return portalApp(db, f, principal, production ? areaContributions.routes ?? [] : createPortalBillingRoutes(service, () => receipts), clock);
  };
  const invoice = async (id: string) => (await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, id))))[0]!;
  return { ...f, clock, fake, uploads, open, paid, draft, other, card, revoked, checkout, app, webhook, invoice };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const json = async <T>(response: Response, schema: { parse(value: unknown): T }) => { expect(response.status).toBe(200); return schema.parse(await response.json()); };
/** Every billing route with a valid request for an invoice, so a denial is never a validation error. */
const routes = (invoiceId: string) => [['GET', '/api/portal/invoices'], ['GET', `/api/portal/invoices/${invoiceId}`], ['GET', `/api/portal/invoices/${invoiceId}/receipt`],
  ['POST', `/api/portal/invoices/${invoiceId}/checkout`], ['GET', '/api/portal/payment-methods'], ['POST', '/api/portal/payment-methods/checkout']] as const;
const portalLinks = (f: Fixture) => db.forGym(f.gymId, tx => tx.select().from(signedLinks).where(eq(signedLinks.createdBy, f.payerUser.id)));

describe('portal billing routes', () => {
  it('shows the payer invoices, details and saved cards, never drafts or revoked cards', async () => {
    const f = await fixture(), server = f.app(payerPrincipal(f));
    const list = await json(await server.request('/api/portal/invoices'), contracts.invoices.response);
    expect(list.data.map(row => row.id)).toEqual([f.open.id, f.paid.id]);
    expect((await json(await server.request('/api/portal/invoices?status=paid'), contracts.invoices.response)).data.map(row => row.id)).toEqual([f.paid.id]);
    const detail = await json(await server.request(`/api/portal/invoices/${f.open.id}`), contracts.invoice.response);
    expect(detail.data.lines.map(line => line.description)).toEqual(['Mat fee']);
    expect((await server.request(`/api/portal/invoices/${f.draft.id}`)).status).toBe(404);
    const cards = await json(await server.request('/api/portal/payment-methods'), contracts.paymentMethods.response);
    expect(cards.data).toEqual([{ id: f.card.id, brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2029, isDefault: true }]);
  });
  it('pays an open invoice through the shared Checkout; only the webhook transitions change the invoice', async () => {
    const f = await fixture(), server = f.app(payerPrincipal(f));
    const response = await send(server, 'POST', `/api/portal/invoices/${f.open.id}/checkout`);
    const started = await json(response, contracts.payInvoice.response);
    expect(started.data.url).toMatch(/^https:\/\/checkout\.invalid\//);
    const [link] = await portalLinks(f);
    expect(link).toMatchObject({ purpose: 'pay_invoice', invoiceId: f.open.id, householdId: f.household.id, usedAt: null });
    // Stripe returns to /l/return; the sealed receipt binds that return to the internal link without exposing it to Stripe.
    const cookie = /plaingym_link_checkout=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    const receipt = receipts.open(cookie, f.clock.now(), { gymId: f.gymId, linkId: link!.id });
    expect(receipt).toMatchObject({ linkId: link!.id, tablet: false });
    const sessionId = receipt!.sessionId;
    expect(await f.invoice(f.open.id)).toMatchObject({ status: 'open', checkoutSessionId: sessionId });
    await f.webhook(f.fake.completeCheckout(sessionId));
    expect(await f.invoice(f.open.id)).toMatchObject({ status: 'paid' });
    expect((await portalLinks(f))[0]!.usedAt).not.toBeNull();
    // A paid invoice can't start another Checkout, and now has a receipt.
    expect((await send(server, 'POST', `/api/portal/invoices/${f.open.id}/checkout`)).status).toBe(409);
    const download = await json(await server.request(`/api/portal/invoices/${f.open.id}/receipt`), contracts.receipt.response);
    expect(download.data.url).toMatch(/^https:\/\/uploads\.invalid\//);
  });
  it('updates the card through Checkout in setup mode and the shared card writer', async () => {
    const f = await fixture(), server = f.app(payerPrincipal(f));
    const response = await send(server, 'POST', '/api/portal/payment-methods/checkout');
    await json(response, contracts.updateCard.response);
    const [link] = await portalLinks(f);
    expect(link).toMatchObject({ purpose: 'update_card', invoiceId: null });
    const cookie = /plaingym_link_checkout=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    const session = f.fake.completeCheckout(receipts.open(cookie, f.clock.now(), { gymId: f.gymId })!.sessionId);
    expect(session.mode).toBe('setup');
    await f.webhook(session);
    const cards = await db.forGym(f.gymId, tx => tx.select().from(paymentMethods).where(and(eq(paymentMethods.householdId, f.household.id), eq(paymentMethods.processorId, session.paymentMethodId!))));
    expect(cards).toHaveLength(1);
    expect((await portalLinks(f))[0]!.usedAt).not.toBeNull();
  });
  it('keeps only the newest portal Checkout link usable', async () => {
    const f = await fixture(), server = f.app(payerPrincipal(f));
    for (let n = 0; n < 3; n++) expect((await send(server, 'POST', `/api/portal/invoices/${f.open.id}/checkout`)).status).toBe(200);
    expect((await send(server, 'POST', '/api/portal/payment-methods/checkout')).status).toBe(200);
    const links = (await portalLinks(f)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    expect(links.filter(link => link.purpose === 'pay_invoice' && !link.revokedAt)).toHaveLength(1);
    expect(links.filter(link => link.purpose === 'pay_invoice' && link.revokedAt)).toHaveLength(2);
    expect(links.filter(link => link.purpose === 'update_card' && !link.revokedAt)).toHaveLength(1);
  });
  it('answers 503 and revokes the minted link when Stripe is not configured', async () => {
    const f = await fixture();
    const unconfigured = createSignedLinkCheckout({ scope: db.forGym, clock: f.clock, originFor: async () => origin,
      paymentsFor: async () => { throw new AppError('unavailable', 'Stripe is not configured for this gym'); } });
    const service = createPortalBillingService({ households: createMemberHouseholdContext(db.forGym), householdScope: db.forHousehold, clock: f.clock,
      links: createSignedLinksService({ scope: db.forGym, clock: f.clock }), checkout: () => unconfigured, uploadsFor: () => async () => f.uploads });
    const server = portalApp(db, f, payerPrincipal(f), createPortalBillingRoutes(service, () => receipts), f.clock);
    expect((await send(server, 'POST', '/api/portal/payment-methods/checkout')).status).toBe(503);
    expect((await portalLinks(f)).map(link => link.revokedAt === null)).toEqual([false]);
  });
  it('reports receipts as unavailable when storage refuses them', async () => {
    const f = await fixture();
    const service = createPortalBillingService({ households: createMemberHouseholdContext(db.forGym), householdScope: db.forHousehold, clock: f.clock,
      checkout: () => f.checkout, uploadsFor: () => async () => ({ put: async () => { throw new AppError('forbidden', 'Uploads are disabled in the demo'); } }) as never });
    const server = portalApp(db, f, payerPrincipal(f), createPortalBillingRoutes(service, () => receipts), f.clock);
    expect((await server.request(`/api/portal/invoices/${f.paid.id}/receipt`)).status).toBe(503);
  });
  it('names the gym on the receipt and marks a refund', async () => {
    const f = await fixture(), render = vi.fn(async (_input: PdfInput) => new Uint8Array([37, 80, 68, 70]));
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'partially_refunded' }).where(eq(invoices.id, f.paid.id)));
    const service = createPortalBillingService({ households: createMemberHouseholdContext(db.forGym), householdScope: db.forHousehold, clock: f.clock,
      checkout: () => f.checkout, uploadsFor: () => async () => f.uploads, render });
    const server = portalApp(db, f, payerPrincipal(f), createPortalBillingRoutes(service, () => receipts), f.clock);
    expect((await server.request(`/api/portal/invoices/${f.paid.id}/receipt`)).status).toBe(200);
    const input = render.mock.calls[0]![0];
    const text = input.blocks.map(block => block.kind === 'text' ? block.text : '');
    expect(text[0]).toBe('Test Gym');
    expect(input.footer).toBe('Test Gym · Invoice #6');
    expect(text).toEqual(expect.arrayContaining(['Receipt for invoice #6', 'Paid on Sep 21, 2026', 'Seminar × 1: $10.00', 'Total: $10.00', 'Partially refunded']));
  });
  it('renders a receipt only for paid invoices', async () => {
    const f = await fixture(), server = f.app(payerPrincipal(f));
    const download = await json(await server.request(`/api/portal/invoices/${f.paid.id}/receipt`), contracts.receipt.response);
    const key = decodeURIComponent(new URL(download.data.url).pathname.slice(1));
    expect(key.startsWith(`${f.gymId}/receipts/${f.paid.id}/`)).toBe(true);
    const head = await f.uploads.head(key);
    expect(head).toMatchObject({ contentType: 'application/pdf' });
    expect(head!.deletedAt).not.toBeNull();
    expect((await server.request(`/api/portal/invoices/${f.open.id}/receipt`)).status).toBe(409);
  });
  it('refuses Checkout for invoices that are not payable and revokes the unused link when Checkout is unavailable', async () => {
    const f = await fixture(), server = f.app(payerPrincipal(f));
    const voided = await factory('invoices', f.gymId, { householdId: f.household.id, number: 9, status: 'void', amountCents: 100 });
    expect((await send(server, 'POST', `/api/portal/invoices/${voided.id}/checkout`)).status).toBe(409);
    expect((await send(server, 'POST', `/api/portal/invoices/${f.paid.id}/checkout`)).status).toBe(409);
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ needsReview: true }).where(eq(invoices.id, f.open.id)));
    expect((await send(server, 'POST', `/api/portal/invoices/${f.open.id}/checkout`)).status).toBe(409);
    const links = await portalLinks(f);
    expect(links).toHaveLength(1);
    expect(links[0]!.revokedAt).not.toBeNull();
    expect(await f.invoice(f.open.id)).toMatchObject({ status: 'open', checkoutSessionId: null });
  });
  it('gives an adult non-payer no billing access at all', async () => {
    const f = await fixture(), server = f.app(adultPrincipal(f));
    for (const [method, path] of routes(f.open.id)) expect((await send(server, method, path)).status, `${method} ${path}`).toBe(404);
    expect(await portalLinks(f)).toEqual([]);
  });
  it('returns 404 for other households, other gyms and non-member sessions on every route', async () => {
    const f = await fixture(), foreign = await fixture(), server = f.app(payerPrincipal(f));
    for (const id of [f.other.id, foreign.open.id])
      for (const [method, path] of routes(id).filter(([, path]) => path.includes(id))) expect((await send(server, method, path)).status, `${method} ${path}`).toBe(404);
    const other = f.app(otherPayerPrincipal(f));
    expect((await json(await other.request('/api/portal/invoices'), contracts.invoices.response)).data.map(row => row.id)).toEqual([f.other.id]);
    expect((await json(await other.request('/api/portal/payment-methods'), contracts.paymentMethods.response)).data).toEqual([]);
    for (const [method, path] of routes(f.open.id).filter(([, path]) => path.includes(f.open.id))) expect((await send(other, method, path)).status).toBe(404);
    for (const principal of [payerPrincipal(foreign), ...outsidePrincipals(f)]) {
      const outside = f.app(principal);
      for (const [method, path] of routes(f.open.id)) expect([404], `${method} ${path}`).toContain((await send(outside, method, path)).status);
    }
    expect(await db.forGym(f.gymId, tx => tx.select().from(signedLinks))).toEqual([]);
    expect(await f.invoice(f.open.id)).toMatchObject({ status: 'open', checkoutSessionId: null });
  });
  it('serves the production registrations with the configured Checkout', async () => {
    const f = await fixture(), server = f.app(payerPrincipal(f), true);
    expect((await server.request('/api/portal/invoices')).status).toBe(200);
    expect((await send(server, 'POST', '/api/portal/payment-methods/checkout')).status).toBe(200);
  });
});
