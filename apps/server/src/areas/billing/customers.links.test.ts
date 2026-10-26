// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { asc, eq } from 'drizzle-orm';
import { allocateInvoiceNumber, households, invoiceLineItems, invoices, paymentAttempts, paymentMethods, payments, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { membersContracts, portalSignedLinkContracts, type SignedLinkPurposeName } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { authorize } from '../staff/auth.permissions.js';
import type { Principal } from '../../core/context.js';
import { createMembersRoutes } from '../members/members.routes.js';
import { createMembersService } from '../members/members.js';
import { createSignedLinksService } from '../links/service.js';
import { createWaiversService } from '../waivers/waivers.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createSignedLinkCheckout, CustomerNotLinked } from './signed-link-checkout.js';
import { createCustomersService } from './customers.js';
import { createChargeRunner } from './runner/index.js';
import { createInvoiceTransitions } from './transitions/index.js';
import { registerBillingWebhookHandlers } from './webhooks/handlers/index.js';
import type { WebhookHandler } from './webhooks/inbox.js';
import { configureLinkPages } from '../../public/links/links.routes.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';

const db = useTestDatabase(), factory = createFactories(db);
const origin = 'https://gym.example.test';
async function fixture(purpose: SignedLinkPurposeName = 'pay_invoice', invoiceKind: 'cycle' | 'assignment' | 'one_off' = 'cycle') {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z');
  await factory('gyms', gymId, { currency: 'CAD', billingEnabled: true });
  const user = await factory('authUser', gymId);
  const members = createMembersService({ scope: db.forGym, clock });
  const memberRoutes = createMembersRoutes(members);
  const replaced = new Set(memberRoutes.map(r => r.id));
  const contributions = { ...areaContributions,
    routes: [...areaContributions.routes.filter(r => !replaced.has(r.id)), ...memberRoutes] };
  const app = (principal: Principal = { kind: 'anonymous' }, resolvedGym = gymId) => createApp({
    clock, skipSetup: true, authorize, origin, contributions, rateLimit: { limit: 10000 },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: resolvedGym, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
  });
  const admin = app({ kind: 'staff', gymId, userId: user.id, roles: ['owner'] });
  const created = await admin.request(origin + '/api/households', { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'New Household', email: 'payer@example.invalid', billingDay: 26 }) });
  expect(created.status).toBe(200);
  const householdId = membersContracts.createHousehold.response.parse(await created.json()).data.id;
  const before = await db.forGym(gymId, tx => tx.select().from(households).where(eq(households.id, householdId)));
  expect(before[0]!.stripeCustomerId).toBeNull();
  const person = await factory('members', gymId, { householdId, status: 'active' });
  const number = await db.forGym(gymId, tx => allocateInvoiceNumber(tx, gymId));
  const invoice = await factory('invoices', gymId, { householdId, number, status: 'open', amountCents: 10000,
    kind: invoiceKind === 'cycle' ? 'cycle' : 'one_off', dueOn: '2026-10-26',
    ...(invoiceKind === 'cycle' ? { periodStartsOn: '2026-10-26', periodEndsOn: '2026-11-26' } : {}) });
  await factory('invoiceLineItems', gymId, { householdId, invoiceId: invoice.id, kind: invoiceKind === 'one_off' ? 'charge' : 'membership' });
  const provider = new FakePayments(gymId, clock);
  const paymentsFor = vi.fn(async () => provider);
  const log = vi.fn<(line: string) => void>();
  const checkout = createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor, originFor: async () => origin, log });
  const links = createSignedLinksService({ scope: db.forGym, clock });
  const link = await links.create({ gymId, actor: { kind: 'system' } }, { householdId,
    expiresAt: new Date(clock.now().getTime() + 7 * 86400000).toISOString(),
    ...(purpose === 'pay_invoice' ? { purpose, invoiceId: invoice.id } : { purpose: purpose as 'update_card' | 'onboarding' }) });
  configureLinkPages({ scope: db.forHousehold, checkout, links, receiptKey: new Uint8Array(32).fill(7),
    waivers: createWaiversService({ scope: db.forGym, clock, uploadsFor: async () => new FakeUploads(gymId, clock) }), stylesheet: async () => '' });
  const server = app();
  const path = '/api/links/' + purpose.replaceAll('_', '-');
  const request = (suffix = '/checkout', cookie = '', token = link.token, target = server) => target.request(origin + path + suffix, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', authorization: 'Bearer ' + token,
      ...(cookie ? { cookie } : {}) }, body: '{}',
  });
  const transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  const handlers = new Map<string, WebhookHandler>();
  registerBillingWebhookHandlers({ register(type, handler) { handlers.set(type, handler); } }, { scope: db.forGym, clock, transitions });
  const read = () => db.forGym(gymId, async tx => ({
    household: (await tx.select().from(households).where(eq(households.id, householdId)))[0]!,
    methods: await tx.select().from(paymentMethods), payments: await tx.select().from(payments),
    invoices: await tx.select().from(invoices).orderBy(asc(invoices.number)), attempts: await tx.select().from(paymentAttempts),
  }));
  async function complete(sessionId: string) {
    const session = provider.completeCheckout(sessionId);
    const event = { id: 'evt_' + uuidv7(), type: 'checkout.session.completed', gymId, objectKind: 'checkout' as const, objectId: sessionId };
    const context = { gymId, clock, timezone: 'UTC', jobId: uuidv7(), attempt: 1, payments: provider };
    await handlers.get(event.type)!(event, context);
    await handlers.get(event.type)!(event, context);
    return session;
  }
  const customers = createCustomersService({ scope: db.forGym, clock, paymentsFor });
  async function savedCard() {
    const customerId = await customers.ensureCustomer(gymId, householdId), processorId = 'pm_existing';
    const createdAt = new Date(clock.now().getTime() - 86400000);
    provider.recordPaymentMethod({ id: processorId, customerId, last4: '1111', expiresMonth: 12, expiresYear: 2030, createdAt });
    return factory('paymentMethods', gymId, { householdId, processorId, isDefault: true, processorCreatedAt: createdAt });
  }
  return { gymId, clock, householdId, person, invoice, provider, paymentsFor, links, link, checkout, app, admin,
    request, read, complete, transitions, log, savedCard, customers };
}

describe('new household billing through production route registrations', () => {
  it('pays an admin-created household invoice, saves its card through the webhook and collects the next cycle', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCustomer'), sessions = vi.spyOn(f.provider, 'createCheckout');
    const response = await f.request();
    expect(response.status).toBe(200);
    portalSignedLinkContracts.payInvoice.response.parse(await response.json());
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const current = await f.read(), sessionId = current.invoices[0]!.checkoutSessionId!;
    expect(sessions.mock.calls[0]![0]).toMatchObject({ customerId: current.household.stripeCustomerId, saveForOffSession: true });
    const completed = await f.complete(sessionId);
    expect((await f.request('/complete', cookie)).status).toBe(200);
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('used');
    expect((await f.read()).methods).toMatchObject([{ processorId: completed.paymentMethodId, isDefault: true }]);
    expect((await f.read()).invoices[0]!.status).toBe('paid');
    const plan = await factory('plans', f.gymId);
    await factory('memberships', f.gymId, { householdId: f.householdId, memberId: f.person.id, planId: plan.id,
      status: 'active', interval: 'monthly', startsOn: '2026-10-26', nextDueOn: '2026-11-26', amountCents: 10000 });
    f.clock.set('2026-11-26T12:00:00Z');
    const runner = createChargeRunner({ scope: db.forGym, clock: f.clock, transitions: f.transitions,
      settings: createGymSettingsAccessor({ scope: db.forGym }), jobs: new FakeJobs(f.clock), payments: f.paymentsFor });
    expect((await runner.daily(f.gymId)).errors).toEqual([]);
    const after = await f.read();
    expect(after.invoices.map(i => i.status)).toEqual(['paid', 'paid']);
    expect(after.payments).toHaveLength(2);
    expect(after.attempts).toMatchObject([{ stripeCustomerId: current.household.stripeCustomerId, savedPaymentMethod: completed.paymentMethodId, status: 'succeeded' }]);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each(['update_card', 'onboarding'] as const)('creates a customer and saves a card for %s', async purpose => {
    const f = await fixture(purpose), sessions = vi.spyOn(f.provider, 'createCheckout');
    const response = await f.request(); expect(response.status).toBe(200);
    const customerId = (await f.read()).household.stripeCustomerId!;
    expect(sessions.mock.calls[0]![0]).toMatchObject({ mode: 'setup', customerId });
    const session = await f.checkout.start(f.gymId, f.link.link.id);
    await f.complete(session.session.id);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    expect((await f.request('/complete', cookie)).status).toBe(200);
    expect((await f.links.resolve(f.gymId, f.link.token)).status).toBe('used');
    expect((await f.read()).methods).toMatchObject([{ isDefault: true, householdId: f.householdId }]);
    expect(await f.provider.findCustomerByEmail('payer@example.invalid')).toEqual([{ id: customerId, email: 'payer@example.invalid' }]);
  });
  it.each([false, true])('one-off payment collects no card and preserves an existing default: %s', async existingCard => {
    const f = await fixture('pay_invoice', 'one_off'), sessions = vi.spyOn(f.provider, 'createCheckout');
    if (existingCard) await f.savedCard();
    const before = (await f.read()).methods;
    expect((await f.request()).status).toBe(200);
    expect(sessions.mock.calls[0]![0]).toMatchObject({ mode: 'payment', saveForOffSession: false });
    const completed = await f.complete((await f.read()).invoices[0]!.checkoutSessionId!);
    expect(completed.savesCard).toBe(false);
    expect((await f.read()).methods).toEqual(before);
    expect((await f.read()).invoices[0]!.status).toBe('paid');
  });
  it('a dunning cycle link replaces the saved card and the next run uses the new default', async () => {
    const f = await fixture(), previous = await f.savedCard();
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'past_due' }).where(eq(invoices.id, f.invoice.id)));
    expect((await f.request()).status).toBe(200);
    const completed = await f.complete((await f.read()).invoices[0]!.checkoutSessionId!);
    const methods = (await f.read()).methods;
    expect(methods.find(m => m.id === previous.id)!.isDefault).toBe(false);
    expect(methods.find(m => m.processorId === completed.paymentMethodId)!.isDefault).toBe(true);
    const plan = await factory('plans', f.gymId);
    await factory('memberships', f.gymId, { householdId: f.householdId, memberId: f.person.id, planId: plan.id,
      status: 'active', startsOn: '2026-10-26', nextDueOn: '2026-11-26' });
    f.clock.set('2026-11-26T12:00:00Z');
    const runner = createChargeRunner({ scope: db.forGym, clock: f.clock, transitions: f.transitions,
      settings: createGymSettingsAccessor({ scope: db.forGym }), jobs: new FakeJobs(f.clock), payments: f.paymentsFor });
    expect((await runner.daily(f.gymId)).errors).toEqual([]);
    expect((await f.read()).attempts).toMatchObject([{ savedPaymentMethod: completed.paymentMethodId, status: 'succeeded' }]);
  });
  it('an assignment invoice link saves the card using the shared membership-line rule', async () => {
    const f = await fixture('pay_invoice', 'assignment'), sessions = vi.spyOn(f.provider, 'createCheckout');
    await factory('invoiceLineItems', f.gymId, { householdId: f.householdId, invoiceId: f.invoice.id, kind: 'signup_fee' });
    expect((await f.request()).status).toBe(200);
    expect(sessions.mock.calls[0]![0]).toMatchObject({ mode: 'payment', saveForOffSession: true });
    const completed = await f.complete((await f.read()).invoices[0]!.checkoutSessionId!);
    expect((await f.read()).methods).toMatchObject([{ processorId: completed.paymentMethodId, isDefault: true }]);
  });
  it('rejects a reused session whose card-saving policy differs from the invoice', async () => {
    const f = await fixture();
    expect((await f.request()).status).toBe(200);
    // Simulate a session created before the policy changed, now attached to a one-off invoice.
    await db.forGym(f.gymId, async tx => {
      await tx.update(invoices).set({ kind: 'one_off' }).where(eq(invoices.id, f.invoice.id));
      await tx.update(invoiceLineItems).set({ kind: 'charge' }).where(eq(invoiceLineItems.invoiceId, f.invoice.id));
    });
    expect((await f.request()).status).toBe(503);
    expect((await f.read()).methods).toHaveLength(0);
  });
  it('two concurrent link opens share exactly one customer and Checkout session', async () => {
    const f = await fixture();
    let release!: () => void;
    f.provider.holdNextCustomerCreation(new Promise<void>(resolve => { release = resolve; }));
    const create = f.provider.createCustomer.bind(f.provider);
    vi.spyOn(f.provider, 'createCustomer').mockImplementation(async request => {
      try { return await create(request); }
      catch (error) { release(); throw error; }
    });
    const responses = await Promise.all([f.request(), f.request()]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect(await f.provider.findCustomerByEmail('payer@example.invalid')).toHaveLength(1);
  });
  it('refuses another gym and another household link before creating any customer', async () => {
    const f = await fixture(), create = vi.spyOn(f.provider, 'createCustomer'), gymB = uuidv7();
    await factory('gyms', gymB);
    expect((await f.request('/checkout', '', f.link.token, f.app({ kind: 'anonymous' }, gymB))).status).toBe(404);
    await expect(f.checkout.start(gymB, f.link.link.id)).rejects.toMatchObject({ code: 'not_found' });
    const other = await factory('households', f.gymId, { email: 'other@example.invalid' });
    const wrong = await f.links.create({ gymId: f.gymId, actor: { kind: 'system' } }, {
      purpose: 'update_card', householdId: other.id, expiresAt: new Date(f.clock.now().getTime() + 86400000).toISOString(),
    });
    expect((await f.request('/checkout', '', wrong.token)).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect((await f.read()).household.stripeCustomerId).toBeNull();
  });
  it.each(['missing_details', 'stripe_not_configured', 'creation_expired', 'details_changed'] as const)(
    'logs identifiers and %s without PII and keeps the contact response', async reason => {
    const f = await fixture('update_card'), create = vi.spyOn(f.provider, 'createCustomer');
    if (reason === 'missing_details') await db.forGym(f.gymId, tx => tx.update(households).set({ email: null }).where(eq(households.id, f.householdId)));
    else if (reason === 'stripe_not_configured') f.paymentsFor.mockRejectedValue(new Error('rk_test_SECRETPAYER payer@example.invalid'));
    else {
      f.provider.loseNextResponse('createCustomer');
      await expect(f.customers.ensureCustomer(f.gymId, f.householdId)).rejects.toThrow();
      if (reason === 'creation_expired') f.clock.advance(23 * 60 * 60 * 1000);
      else await db.forGym(f.gymId, tx => tx.update(households).set({ name: 'Private Changed Household' }).where(eq(households.id, f.householdId)));
      create.mockClear();
    }
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ cardSetupUnavailable: true });
    expect(create).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledTimes(1);
    const line = f.log.mock.calls[0]![0];
    expect(JSON.parse(line)).toMatchObject({ gymId: f.gymId, householdId: f.householdId, purpose: 'update_card', reason });
    expect(line).not.toMatch(/payer@example|New Household|Private Changed Household|rk_test_/);
  });
  it('logs unexpected provider errors by name and preserves the original cause', async () => {
    const f = await fixture('update_card'), error = new TypeError('payer@example.invalid rk_test_SECRET');
    vi.spyOn(f.provider, 'createCustomer').mockRejectedValue(error);
    await expect(f.checkout.start(f.gymId, f.link.link.id)).rejects.toMatchObject({ cause: error });
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ cardSetupUnavailable: true });
    expect(f.log).toHaveBeenCalledTimes(2);
    for (const [line] of f.log.mock.calls) {
      expect(JSON.parse(line)).toMatchObject({ reason: 'TypeError', gymId: f.gymId, householdId: f.householdId, purpose: 'update_card' });
      expect(line).not.toMatch(/payer@example|rk_test_/);
    }
  });
  it('logs database failure names while retaining the safe member response type', async () => {
    const f = await fixture('update_card'), error = new Error('Failed query with payer@example.invalid');
    let calls = 0;
    const checkout = createSignedLinkCheckout({ clock: f.clock, paymentsFor: f.paymentsFor, originFor: async () => origin,
      log: f.log, scope: (gymId, fn) => { if (++calls === 2) throw error; return db.forGym(gymId, fn); } });
    await expect(checkout.start(f.gymId, f.link.link.id)).rejects.toBeInstanceOf(CustomerNotLinked);
    expect(JSON.parse(f.log.mock.calls[0]![0])).toMatchObject({ reason: 'Error', gymId: f.gymId, householdId: f.householdId });
    expect(f.log.mock.calls[0]![0]).not.toContain('payer@example');
  });
  it('a concurrent admin edit receives a conflict after lazy customer linking advances the revision', async () => {
    const f = await fixture();
    const household = (await f.read()).household;
    await f.customers.ensureCustomer(f.gymId, f.householdId);
    const response = await f.admin.request(origin + '/api/households/' + f.householdId, {
      method: 'PATCH', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Edited Household', revision: household.revision }),
    });
    expect(response.status).toBe(409);
    expect((await f.read()).household.name).toBe(household.name);
  });
});
