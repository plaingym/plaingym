// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- One test reads backend PIDs to see a refund wait on the gym row lock.
import { eq, sql } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- One test holds the gym row the way a settings save does.
import { auditEvents, gyms, invoices, paymentAttempts, paymentMethods, payments, refunds, signedLinks, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { canStaff, createTranslator, type StaffRole } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { billingContracts, linksContracts, releaseInvoiceHoldContract, stripeTestPaymentReference, type BillingEndpoint } from '@plaingym/shared/contracts';
import { locales } from '@plaingym/shared/locales';
import { createApp } from '../../app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { areaContributions } from '../../core/registry-areas.js';
import { FakePayments, type DetachOptions } from '../../infra/payments/index.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { FakeJobs, PostgresJobs } from '../../infra/jobs/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGoLiveService } from '../settings/go-live.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createSignedLinksService } from '../links/service.js';
import { createSignedLinksRoutes } from '../links/service.routes.js';
import { createInvoiceTransitions } from './transitions/index.js';
import { createTransitionNotifications } from './transitions/notifications.js';
import { createPaymentService } from './payments.js';
import { createDisputeRefundWriter, processorRefundId } from './disputes-refunds.js';
import { createChargeRunner, type ChargeResult } from './runner/index.js';
import { configurePayments, createPaymentRoutes } from './payments.routes.js';
import { createLapsedRefundJobs, createPaymentJobs, lapsedRefundJob } from './payments.jobs.js';
import { detachJob } from './payments.mutations.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true, memberEmailsEnabled: true });
  const user = await factory('authUser', gymId), home = await factory('households', gymId, { stripeCustomerId: 'cus_fixture', email: 'payer@example.invalid' });
  const card = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_4242', isDefault: true });
  const provider = new FakePayments(gymId, clock); provider.seedCustomer({ id: 'cus_fixture', email: 'payer@example.invalid' });
  const jobs = new FakeJobs(clock), email = new FakeEmail(), settings = createGymSettingsAccessor({ scope: db.forGym });
  const detachCard = vi.fn(async (_gym: string, _id: string, _options?: DetachOptions) => { assertNoTransaction('detachCard'); });
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const options = { scope: db.forGym, clock, settings, jobs, detachCard, paymentsFor: async () => provider,
    transitions: createInvoiceTransitions({ scope: db.forGym, clock }) };
  const runner = createChargeRunner({ ...options, payments: async () => provider });
  const service = createPaymentService({ ...options, runner });
  const create = () => service.createOneOff(context, { source: 'custom', householdId: home.id, dueOn: '2026-10-25', description: 'Drop-in', amountCents: 2500, currency: 'USD' });
  const invoice = await create(), paid = await create();
  const payment = await service.manualPayment(context, paid.id, { amountCents: 2500, currency: 'USD', method: 'cash', paidAt: clock.now().toISOString() });
  const notifications = createTransitionNotifications({ scope: db.forGym, clock, settings,
    prepare: async () => ({ email, origin }), staffRecipients: async () => ['owner@example.invalid'] });
  createServerRegistry({ jobs: createPaymentJobs({ scope: db.forGym, detachCard, notifications }) }).registerJobs(jobs, new Set());
  const links = createSignedLinksService({ scope: db.forGym, clock, delivery: { prepare: async () => ({
    gymId, gymName: 'Gym', origin, email, memberEmailsEnabled: true, t: createTranslator(locales.en ?? {}),
  }) } });
  return { gymId, clock, user, home, card, provider, jobs, email, settings, context, options, runner, service, create, invoice, paid, payment, detachCard, links };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const refundRows = (paymentId: string, f: Fixture) => db.forGym(f.gymId, tx => tx.select().from(refunds).where(eq(refunds.paymentId, paymentId)));
const paymentRow = async (paymentId: string, f: Fixture) => (await db.forGym(f.gymId, tx => tx.select().from(payments).where(eq(payments.id, paymentId))))[0]!;
/** While the app's next refund is waiting to reach the processor, someone refunds the payment in its dashboard and the
 * webhook for that refund is processed. Returns the dashboard refund's ID once it exists. */
function dashboardRefund(f: Fixture, paid: typeof payments.$inferSelect, amount: number) {
  const writer = createDisputeRefundWriter({ scope: db.forGym, clock: f.clock, transitions: f.options.transitions });
  const send = f.provider.refund.bind(f.provider), made: { id?: string } = {};
  vi.spyOn(f.provider, 'refund').mockImplementationOnce(async request => {
    const dashboard = await send({ chargeId: request.chargeId, amount, idempotencyKey: 'dashboard' });
    made.id = dashboard.id;
    await writer.refund(f.gymId, paid, dashboard);
    return send(request);
  });
  return made;
}
function app(f: Fixture, principal: Principal, realRegistrations = false) {
  if (realRegistrations) configurePayments(f.service);
  return createApp({ clock: f.clock, origin, authorize,
    contributions: realRegistrations ? areaContributions : { routes: [...createPaymentRoutes(f.service), ...createSignedLinksRoutes(f.links)] },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
  });
}
const staff = (f: Fixture, role: StaffRole): Principal => ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
const contracts = { ...billingContracts, releaseInvoiceHold: releaseInvoiceHoldContract };
const operations = ['listInvoices', 'getInvoice', 'createOneOffInvoice', 'chargeInvoice', 'recordManualPayment', 'listPayments',
  'listRefunds', 'createRefund', 'listPaymentMethods', 'setDefaultPaymentMethod', 'revokePaymentMethod', 'resendReceipt', 'releaseInvoiceHold'] as const satisfies readonly (BillingEndpoint | 'releaseInvoiceHold')[];
type Operation = typeof operations[number];
function request(server: ReturnType<typeof app>, operation: Operation, f: Fixture, oneOff?: unknown) {
  const contract = contracts[operation];
  const path = contract.path.replace('{invoiceId}', operation === 'resendReceipt' ? f.paid.id : f.invoice.id)
    .replace('{householdId}', f.home.id).replace('{paymentMethodId}', f.card.id).replace('{paymentId}', f.payment.id);
  const body = operation === 'createOneOffInvoice' && oneOff ? oneOff : operation === 'createOneOffInvoice' ? { source: 'custom', householdId: f.home.id, dueOn: '2026-10-25', description: 'Drop-in', amountCents: 2500, currency: 'USD' }
    : operation === 'recordManualPayment' ? { amountCents: 2500, currency: 'USD', method: 'cash', paidAt: f.clock.now().toISOString() }
      : operation === 'createRefund' ? { amountCents: 2500, currency: 'USD', reason: null } : {};
  return server.request(origin + path, { method: contract.method.toUpperCase(),
    ...(contract.method === 'get' ? {} : { headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }) });
}

describe('payment route permissions and tenant isolation', () => {
  it('filters only open disputes before pagination and counting, preserving gym isolation', async () => {
    const f = await fixture(), other = await fixture();
    let number = 1000;
    const issue = (disputeId: string | null, disputeStatus: string | null) => factory('invoices', f.gymId, {
      householdId: f.home.id, status: 'paid', number: number++, dueOn: '2020-01-01', disputeId, disputeStatus,
    });
    const open = [await issue('dp_open', 'needs_response'), await issue('dp_unknown', null)];
    for (const status of ['won', 'lost', 'closed', 'warning_closed']) await issue('dp_' + status, status);
    await issue(null, null);
    await db.forGym(other.gymId, tx => tx.update(invoices).set({ disputeId: 'dp_foreign', disputeStatus: 'needs_response' }).where(eq(invoices.id, other.paid.id)));
    const page = await f.service.listInvoices(f.gymId, { dispute: 'open', limit: 1, offset: 0 });
    expect(page.pagination.total).toBe(2); expect(page.data).toHaveLength(1);
    const response = await app(f, staff(f, 'front_desk')).request(origin + '/api/billing/invoices?dispute=open');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.map((row: { id: string }) => row.id).sort()).toEqual(open.map(row => row.id).sort());
    expect(data.pagination.total).toBe(2);
    expect((await app(f, staff(f, 'coach')).request(origin + '/api/billing/invoices?dispute=open')).status).toBe(403);
    expect((await app(f, staff(f, 'owner')).request(origin + '/api/billing/invoices?dispute=false')).status).toBe(400);
  });
  for (const operation of operations) {
    for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) it(`${operation}: ${role}`, async () => {
      const f = await fixture(), contract = contracts[operation], response = await request(app(f, staff(f, role)), operation, f);
      // The matrix request is a custom-amount one-off, which also needs payments.custom.
      const capability = operation === 'createOneOffInvoice' ? 'payments.custom' : contract.permission.capability;
      expect(response.status, await response.clone().text()).toBe(canStaff([role], capability) ? contract.successStatus : 403);
      const awaitValue = response.ok ? await response.json() : null;
      if (response.ok) expect(() => contract.response.parse(awaitValue)).not.toThrow();
    });
    if (operation === 'createOneOffInvoice') for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) it(`${operation} from the catalog: ${role}`, async () => {
      const f = await fixture(), charge = await factory('chargeTypes', f.gymId, { amountCents: 1000, name: 'Mat fee', currency: 'USD' });
      const body = { source: 'charge_type', householdId: f.home.id, chargeTypeId: charge.id, dueOn: '2026-10-25' };
      const response = await request(app(f, staff(f, role)), operation, f, body);
      expect(response.status, await response.clone().text()).toBe(canStaff([role], contracts[operation].permission.capability) ? 201 : 403);
    });
    it(`${operation}: denies anonymous, kiosk and signed-link principals`, async () => {
      const f = await fixture();
      const principals: Principal[] = [{ kind: 'anonymous' }, { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
        { kind: 'member', userId: f.user.id, scope: { gymId: f.gymId, householdId: f.home.id, role: 'payer' } },
        { kind: 'signed_link', gymId: f.gymId, linkId: uuidv7(), householdId: f.home.id, link: { purpose: 'pay_invoice', invoiceId: f.invoice.id } }];
      for (const principal of principals) expect((await request(app(f, principal), operation, f)).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
    });
    it(`${operation}: a different gym cannot reach the resource`, async () => {
      const own = await fixture(), other = await fixture(), server = app(own, staff(own, 'owner'));
      if (operation === 'listInvoices') {
        expect((await server.request(origin + '/api/billing/invoices?householdId=' + other.home.id)).status).toBe(404);
      } else if (operation === 'listPayments') {
        expect((await server.request(origin + '/api/billing/payments?invoiceId=' + other.invoice.id)).status).toBe(404);
      } else if (operation === 'listRefunds') {
        expect((await server.request(origin + '/api/billing/refunds?paymentId=' + other.payment.id)).status).toBe(404);
      } else expect((await request(server, operation, other)).status).toBe(404);
    });
  }
  it('front desk records cash through the real area registrations and cannot refund it', async () => {
    const f = await fixture(), server = app(f, staff(f, 'front_desk'), true);
    const response = await request(server, 'recordManualPayment', f);
    expect(response.status).toBe(201); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('paid');
    expect((await request(server, 'createRefund', f)).status).toBe(403);
  });
  it('documents the custom-amount rule on the one-off route', async () => {
    const f = await fixture();
    const document = app(f, staff(f, 'owner')).getOpenAPIDocument({ openapi: '3.0.0', info: { title: 'test', version: '1' } });
    const operation = document.paths['/api/billing/invoices/one-off']?.post as { description?: string } | undefined;
    // The document says what the contract says, and the contract is where the rule is written.
    expect(billingContracts.createOneOffInvoice.description).toContain('payments.custom');
    expect(operation?.description).toBe(billingContracts.createOneOffInvoice.description);
    expect(operation?.description).toContain('payments.record');
    // No other route's description came along.
    const otherOperation = document.paths['/api/billing/invoices/{invoiceId}/charge']?.post as { description?: string } | undefined;
    expect(otherOperation?.description).toBeUndefined();
  });
  it('refuses any custom body from staff without payments.custom with 403, valid or not, and validates it for those with it', async () => {
    const f = await fixture();
    const post = (server: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) => server.request(origin + '/api/billing/invoices/one-off', { method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const bodies = [{ source: 'custom' }, { source: 'custom', householdId: 'not-an-id', amountCents: -5 }, { source: 'custom', householdId: f.home.id, extra: true },
      { source: 'custom', householdId: f.home.id, dueOn: '2026-10-25', description: '', amountCents: 100, currency: 'USD' }];
    const before = (await f.service.listInvoices(f.gymId, { limit: 100, offset: 0 })).pagination.total;
    for (const role of ['front_desk', 'coach'] as const) for (const body of bodies)
      expect((await post(app(f, staff(f, role)), body)).status, `${role} ${JSON.stringify(body)}`).toBe(403);
    // Owners and admins hold the capability, so the same bodies reach validation.
    for (const role of ['owner', 'admin'] as const) for (const body of bodies)
      expect((await post(app(f, staff(f, role)), body)).status, `${role} ${JSON.stringify(body)}`).toBe(400);
    expect(await f.service.listInvoices(f.gymId, { limit: 100, offset: 0 }).then(page => page.pagination.total)).toBe(before);
    // A body that names no custom amount is not the guard's business: front desk gets the validation answer.
    const desk = app(f, staff(f, 'front_desk'));
    for (const body of [{ source: 'charge_type' }, { source: 'nope' }, {}, [], 'not json']) expect((await post(desk, body)).status, JSON.stringify(body)).toBe(400);
    // The body is still whole for the route after the guard has read it, and a body over the limit is not read by it.
    const f2 = await factory('chargeTypes', f.gymId, { amountCents: 1000, name: 'Mat fee', currency: 'USD' });
    expect((await post(desk, { source: 'charge_type', householdId: f.home.id, chargeTypeId: f2.id, dueOn: '2026-10-25' })).status).toBe(201);
    const oversized = await post(desk, { source: 'custom', note: 'x'.repeat(70_000) });
    expect(oversized.status).toBe(400);
    // Anonymous callers are asked to sign in before the body is looked at.
    expect((await post(app(f, { kind: 'anonymous' }), bodies[0])).status).toBe(401);
  });
  it('limits front desk to catalog charge types and existing invoices, while owner and admin may bill a custom amount', async () => {
    const f = await fixture(), charge = await factory('chargeTypes', f.gymId, { amountCents: 1000, name: 'Mat fee', currency: 'USD' });
    const post = (server: ReturnType<typeof app>, path: string, body: unknown) => server.request(origin + path, { method: 'POST',
      headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    const custom = { source: 'custom', householdId: f.home.id, dueOn: '2026-10-25', description: 'Any amount', amountCents: 2_000_000, currency: 'USD' };
    const catalog = { source: 'charge_type', householdId: f.home.id, chargeTypeId: charge.id, dueOn: '2026-10-25' };
    const count = async () => (await f.service.listInvoices(f.gymId, { limit: 100, offset: 0 })).pagination.total;
    const before = await count(), desk = app(f, staff(f, 'front_desk'));
    const refused = await post(desk, '/api/billing/invoices/one-off', custom);
    expect(refused.status).toBe(403);
    expect(await count()).toBe(before);
    const catalogInvoice = await post(desk, '/api/billing/invoices/one-off', catalog);
    expect(catalogInvoice.status).toBe(201);
    expect((await catalogInvoice.json()).data).toMatchObject({ amountCents: 1000 });
    // Charging an existing invoice stays with front desk.
    expect((await post(desk, `/api/billing/invoices/${f.invoice.id}/charge`, {})).status).toBe(200);
    for (const role of ['owner', 'admin'] as const) {
      const created = await post(app(f, staff(f, role)), '/api/billing/invoices/one-off', custom);
      expect(created.status, role).toBe(201);
      expect((await created.json()).data).toMatchObject({ amountCents: 2_000_000 });
    }
    expect((await post(app(f, staff(f, 'coach')), '/api/billing/invoices/one-off', catalog)).status).toBe(403);
  });
});

describe('one-off collection and payment durability', () => {
  it.each(['billing_disabled', 'not_payable', 'needs_review', 'pending_attempt', 'no_saved_card', 'already_attempted',
    'outside_retry_window', 'not_auto_collectable', 'not_due', 'checkout_changed', 'reservation_lost', 'action_required', 'collection_changed',
    'below_minimum', 'off_step'] as const)(
    'preserves the runner skip reason: %s', async reason => {
      const f = await fixture(), charge = vi.fn(async (): Promise<ChargeResult> => ({ status: 'skipped', reason }));
      const service = createPaymentService({ ...f.options, runner: { charge } });
      await expect(service.charge(f.context, f.invoice.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: [reason] } });
      expect(charge).toHaveBeenCalledWith(f.gymId, f.invoice.id, { mode: 'staff', context: f.context });
    });
  it('requires the injected runner, refuses zero invoices, and resolves ownership first', async () => {
    const f = await fixture(), service = createPaymentService(f.options);
    await expect(service.charge(f.context, f.invoice.id)).rejects.toMatchObject({ code: 'unavailable', details: { reason: ['runner_unavailable'] } });
    await expect(service.charge(f.context, uuidv7())).rejects.toMatchObject({ code: 'not_found' });
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ amountCents: 0 }).where(eq(invoices.id, f.invoice.id)));
    await expect(f.service.charge(f.context, f.invoice.id)).rejects.toMatchObject({ details: { reason: ['zero_invoice'] } });
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('open');
  });
  it.each(['owner', 'admin'] as const)('lets %s release a hold once without charging', async role => {
    const f = await fixture(), server = app(f, staff(f, role)), charge = vi.spyOn(f.provider, 'createCharge');
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ needsReview: true }).where(eq(invoices.id, f.invoice.id)));
    await expect(f.service.charge(f.context, f.invoice.id)).rejects.toMatchObject({ details: { reason: ['needs_review'] } });
    for (let n = 0; n < 2; n++) expect((await request(server, 'releaseInvoiceHold', f)).status).toBe(200);
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.needsReview).toBe(false);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.invoice.review_released')));
    expect(audits).toHaveLength(1); expect(audits[0]?.actorUserId).toBe(f.user.id); expect(charge).not.toHaveBeenCalled();
  });
  it('lets front desk record cash on a held invoice and audits the payment as confirmation', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ needsReview: true }).where(eq(invoices.id, f.invoice.id)));
    expect((await request(app(f, staff(f, 'front_desk')), 'recordManualPayment', f)).status).toBe(201);
    const detail = await f.service.getInvoice(f.gymId, f.invoice.id);
    expect(detail.invoice).toMatchObject({ status: 'paid', needsReview: false });
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.invoice.review_cleared_by_payment')));
    expect(audits).toHaveLength(1); expect(audits[0]?.after).toMatchObject({ needsReview: false, paymentId: detail.payments[0]!.id });
  });
  it.each(['cancel', 'success'] as const)('resolves an action-needed intent before accepting cash: %s', async outcome => {
    const f = await fixture(); f.provider.respondNextConfirmation('authentication_required');
    await f.service.charge(f.context, f.invoice.id);
    const attempt = (await db.forGym(f.gymId, tx => tx.select().from(paymentAttempts)))[0]!;
    if (outcome === 'success') await f.provider.confirmCharge(attempt.paymentIntentId!, { idempotencyKey: 'payer_authenticated' });
    const cancel = vi.spyOn(f.provider, 'cancelCharge');
    const cash = () => f.service.manualPayment(f.context, f.invoice.id, { amountCents: 2500, currency: 'USD', method: 'cash', paidAt: f.clock.now().toISOString() });
    if (outcome === 'success') await expect(cash()).rejects.toMatchObject({ details: { reason: ['already_paid'] } });
    else await cash();
    expect(cancel).toHaveBeenCalledWith(attempt.paymentIntentId);
    const detail = await f.service.getInvoice(f.gymId, f.invoice.id);
    expect(detail.invoice.status).toBe('paid'); expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]?.method).toBe(outcome === 'success' ? 'card' : 'cash');
  });
  it.each([false, true])('expires and reconciles Checkout before accepting a check (completed: %s)', async completed => {
    const f = await fixture();
    const session = await f.provider.createCheckout({ mode: 'payment', customerId: 'cus_fixture', amount: 2500, currency: 'usd', invoiceId: f.invoice.id,
      successUrl: origin + '/success', cancelUrl: origin + '/cancel', saveForOffSession: true, idempotencyKey: f.invoice.id + ':checkout' });
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ checkoutSessionId: session.id }).where(eq(invoices.id, f.invoice.id)));
    if (completed) f.provider.completeCheckout(session.id);
    const expire = vi.spyOn(f.provider, 'expireCheckout');
    const cash = () => f.service.manualPayment(f.context, f.invoice.id, { amountCents: 2500, currency: 'USD', method: 'check', paidAt: f.clock.now().toISOString() });
    if (completed) await expect(cash()).rejects.toMatchObject({ details: { reason: ['already_paid'] } });
    else await cash();
    expect(expire).toHaveBeenCalledWith(session.id);
    const detail = await f.service.getInvoice(f.gymId, f.invoice.id);
    expect(detail.invoice.status).toBe('paid'); expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]?.method).toBe(completed ? 'card' : 'check');
    if (!completed) expect((await db.forGym(f.gymId, tx => tx.select().from(invoices).where(eq(invoices.id, f.invoice.id))))[0]?.checkoutSessionId).toBeNull();
  });
  it('blocks pending cash without provider I/O and reports unavailable when an action-needed release cannot reach Stripe', async () => {
    const f = await fixture(); f.provider.respondNextConfirmation('pending'); await f.service.charge(f.context, f.invoice.id);
    const cancel = vi.spyOn(f.provider, 'cancelCharge');
    await expect(f.service.manualPayment(f.context, f.invoice.id, { amountCents: 2500, currency: 'USD', method: 'cash', paidAt: f.clock.now().toISOString() }))
      .rejects.toMatchObject({ details: { reason: ['pending_attempt'] } });
    expect(cancel).not.toHaveBeenCalled();
    const next = await f.create(); f.provider.respondNextConfirmation('authentication_required'); await f.service.charge(f.context, next.id);
    const unavailable = createPaymentService({ ...f.options, paymentsFor: async () => null });
    await expect(unavailable.manualPayment(f.context, next.id, { amountCents: 2500, currency: 'USD', method: 'cash', paidAt: f.clock.now().toISOString() }))
      .rejects.toMatchObject({ code: 'unavailable', details: { reason: ['payments_unavailable'] } });
    expect((await f.service.getInvoice(f.gymId, next.id)).payments).toHaveLength(0);
  });
  it('recovers the pending refund when a crash left its reason null', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!, refundId = uuidv7();
    await f.options.transitions.refund(f.context, { invoiceId: f.invoice.id, paymentId: payment.id, refundId, amountCents: 500, currency: 'USD', status: 'pending' });
    const refund = vi.spyOn(f.provider, 'refund');
    expect(await f.service.refund(f.context, payment.id, { amountCents: 500, currency: 'USD', reason: 'Returned item' }))
      .toMatchObject({ id: refundId, status: 'succeeded', reason: 'Returned item' });
    expect(refund).toHaveBeenCalledTimes(1);
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).refunds).toHaveLength(1);
  });
  it('retries a reservation from before the marker with its original request, and leaves it unmarked', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!, refundId = uuidv7();
    await f.options.transitions.refund(f.context, { invoiceId: f.invoice.id, paymentId: payment.id, refundId, amountCents: 500, currency: 'USD', status: 'pending' });
    const refund = vi.spyOn(f.provider, 'refund');
    await f.service.refund(f.context, payment.id, { amountCents: 500, currency: 'USD', reason: 'Returned item' });
    expect(refund.mock.calls).toEqual([[{ chargeId: (await paymentRow(payment.id, f)).paymentIntentId, amount: 500, idempotencyKey: `refund:${refundId}` }]]);
    expect(await refundRows(payment.id, f)).toMatchObject([{ id: refundId, status: 'succeeded', taggedAt: null }]);
  });
  it('tags a new card reservation and repeats the same request when a lost response is retried', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!;
    const input = { amountCents: 1000, currency: 'USD', reason: 'Returned item' }, refund = vi.spyOn(f.provider, 'refund');
    f.provider.loseNextResponse('refund'); await expect(f.service.refund(f.context, payment.id, input)).rejects.toThrow();
    const [row] = await refundRows(payment.id, f);
    expect(row).toMatchObject({ status: 'pending', processorId: null, taggedAt: f.clock.now() });
    f.clock.set(new Date(f.clock.now().getTime() + 60_000).toISOString());
    expect(await f.service.refund(f.context, payment.id, input)).toMatchObject({ id: row!.id, status: 'succeeded' });
    const sent = { chargeId: (await paymentRow(payment.id, f)).paymentIntentId, amount: 1000, idempotencyKey: `refund:${row!.id}`, reservationId: row!.id };
    expect(refund.mock.calls).toEqual([[sent], [sent]]);
    expect(await refundRows(payment.id, f)).toMatchObject([{ id: row!.id, taggedAt: row!.taggedAt }]);
  });
  it('leaves a reservation to the app’s own refund when a same-amount dashboard refund lands first', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!, paid = await paymentRow(payment.id, f);
    const dashboard = dashboardRefund(f, paid, 1000), input = { amountCents: 1000, currency: 'USD', reason: 'Returned item' };
    const own = await f.service.refund(f.context, payment.id, input);
    expect(own).toMatchObject({ status: 'succeeded', amountCents: 1000 });
    const rows = await refundRows(payment.id, f), external = rows.find(row => row.id !== own.id)!, reservation = rows.find(row => row.id === own.id)!;
    expect(rows).toHaveLength(2);
    expect(external).toMatchObject({ id: processorRefundId(f.gymId, dashboard.id!), processorId: dashboard.id, status: 'succeeded', taggedAt: null });
    expect(reservation.processorId).not.toBe(dashboard.id);
    expect(reservation).toMatchObject({ status: 'succeeded', reason: 'Returned item' });
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('partially_refunded');
  });
  it('releases a reservation when a dashboard refund of the whole payment leaves it no room', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!, paid = await paymentRow(payment.id, f);
    const dashboard = dashboardRefund(f, paid, 2500), input = { amountCents: 2500, currency: 'USD', reason: 'Returned item' };
    await expect(f.service.refund(f.context, payment.id, input)).rejects.toThrow('Refund exceeds charge');
    const rows = await refundRows(payment.id, f);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.processorId === dashboard.id)).toMatchObject({ status: 'succeeded', amountCents: 2500 });
    expect(rows.find(row => row.processorId === null)).toMatchObject({ status: 'failed', amountCents: 2500, reason: 'Returned item' });
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('refunded');
    await expect(f.service.refund(f.context, payment.id, input)).rejects.toMatchObject({ code: 'conflict' });
  });
  /** A staff reservation committed 23 hours ago whose request never left, on a charged invoice of 25.00. */
  async function lapsedReservation(f: Fixture, amountCents = 1000, tagged = true) {
    await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!, refundId = uuidv7();
    await f.options.transitions.refund(f.context, { invoiceId: f.invoice.id, paymentId: payment.id, refundId, amountCents,
      currency: 'USD', status: 'pending', ...(tagged ? { tagged } : {}) });
    f.clock.advance(23 * 3600_000);
    return { payment, paid: await paymentRow(payment.id, f), refundId };
  }
  const staffRefund = { currency: 'USD', reason: 'Returned item' };
  function scheduleLapsed(f: Fixture) {
    createServerRegistry({ jobs: createLapsedRefundJobs({ scope: db.forGym, clock: f.clock, transitions: f.options.transitions,
      payments: async gymId => { expect(gymId).toBe(f.gymId); return f.provider; } }) }).registerJobs(f.jobs, new Set());
    expect(f.jobs.schedules.get(lapsedRefundJob)).toBe('43 * * * *');
    return async () => {
      await f.jobs.enqueue(lapsedRefundJob, {}, { gymId: f.gymId, timezone: 'UTC' });
      while (await f.jobs.runNext()) { /* settle and deliver currently due jobs */ }
    };
  }
  it('the scheduled job settles only lapsed tagged reservations, repeats safely and respects gym isolation', async () => {
    const f = await fixture(), other = await fixture();
    const { payment, refundId } = await lapsedReservation(f, 500);
    const createReservation = async (amountCents: number, tagged: boolean, processorId?: string) => {
      const id = uuidv7();
      await f.options.transitions.refund(f.context, { invoiceId: f.invoice.id, paymentId: payment.id, refundId: id,
        amountCents, currency: 'USD', status: 'pending', ...(tagged ? { tagged } : {}), ...(processorId ? { processorId } : {}) });
      return id;
    };
    const recent = await createReservation(500, true), unmarked = await createReservation(500, false), atStripe = await createReservation(500, true, 're_at_stripe');
    await db.forGym(f.gymId, tx => tx.update(refunds).set({ createdAt: new Date(f.clock.now().getTime() - 23 * 3600_000) })
      .where(eq(refunds.id, atStripe)));
    await db.forGym(f.gymId, tx => tx.update(refunds).set({ createdAt: new Date(f.clock.now().getTime() - 23 * 3600_000) })
      .where(eq(refunds.id, unmarked)));
    const otherRow = await lapsedReservation(other);
    const sent = vi.spyOn(f.provider, 'refund'), listed = vi.spyOn(f.provider, 'listRefunds'), otherListed = vi.spyOn(other.provider, 'listRefunds');
    const run = scheduleLapsed(f); await run(); await run();
    expect(sent).not.toHaveBeenCalled(); expect(listed).toHaveBeenCalledTimes(1); expect(otherListed).not.toHaveBeenCalled();
    expect(await refundRows(payment.id, f)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: refundId, status: 'failed', processorId: null }),
      ...[recent, unmarked, atStripe].map(id => expect.objectContaining({ id, status: 'pending' })),
    ]));
    expect(await refundRows(otherRow.payment.id, other)).toMatchObject([{ id: otherRow.refundId, status: 'pending' }]);
    expect((await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).filter(row => row.action === 'billing.refund.recorded'
      && row.targetId === refundId && (row.after as { status?: string }).status === 'failed')).toHaveLength(1);
  });
  it.each([false, true])('the scheduled job clears the go-live and restore blockers with a naming refund: %s', async sent => {
    const f = await fixture(), { payment, paid, refundId } = await lapsedReservation(f);
    await db.forGym(f.gymId, tx => tx.update(gyms).set({ billingEnabled: false }).where(eq(gyms.id, f.gymId)));
    await factory('auditEvents', f.gymId, { action: 'restore.completed', targetType: 'restore', targetId: uuidv7(), occurredAt: f.clock.now() });
    expect(await readiness(f)).toBe('needs_attention');
    expect((await f.runner.postRestore(f.gymId, f.clock.now())).readyForOwnerReview).toBe(false);
    const goLive = createGoLiveService({ scope: db.forGym, clock: f.clock, smtpConfigured: async () => true });
    await expect(goLive.update(f.context, { revision: (await goLive.checklist(f.gymId)).revision, billingEnabled: true }))
      .rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('after 23 hours') });
    const own = sent ? await f.provider.refund({ chargeId: paid.paymentIntentId!, amount: 1000, idempotencyKey: 'lost', reservationId: refundId }) : undefined;
    const refund = vi.spyOn(f.provider, 'refund');
    const run = scheduleLapsed(f); await run(); await run();
    expect(refund).not.toHaveBeenCalled();
    expect(await refundRows(payment.id, f)).toMatchObject([{ id: refundId, status: sent ? 'succeeded' : 'failed', processorId: own?.id ?? null }]);
    expect((await f.runner.postRestore(f.gymId, f.clock.now())).readyForOwnerReview).toBe(true);
    expect(await readiness(f)).not.toBe('needs_attention');
    expect(await goLive.update(f.context, { revision: (await goLive.checklist(f.gymId)).revision, billingEnabled: true }))
      .toMatchObject({ billingEnabled: true });
  });
  it('the scheduled job stops for an ambiguous matching refund and sends nothing', async () => {
    const f = await fixture(), { payment, paid, refundId } = await lapsedReservation(f);
    const own = await f.provider.refund({ chargeId: paid.paymentIntentId!, amount: 1000, idempotencyKey: 'lost', reservationId: refundId });
    vi.spyOn(f.provider, 'listRefunds').mockResolvedValue([own, { ...own, id: 're_ambiguous' }]);
    const refund = vi.spyOn(f.provider, 'refund');
    const [job] = createLapsedRefundJobs({ scope: db.forGym, clock: f.clock, transitions: f.options.transitions, payments: async () => f.provider });
    await expect(job!.handler({}, { jobId: uuidv7(), gymId: f.gymId, timezone: 'UTC', attempt: 1, clock: f.clock })).rejects.toThrow('Ambiguous');
    expect(refund).not.toHaveBeenCalled(); expect(await refundRows(payment.id, f)).toMatchObject([{ status: 'pending' }]);
  });
  it('settles the rest of the batch when the oldest reservation is ambiguous, and still ends failed', async () => {
    const f = await fixture(), { payment, paid, refundId } = await lapsedReservation(f, 500), later = uuidv7();
    await f.options.transitions.refund(f.context, { invoiceId: f.invoice.id, paymentId: payment.id, refundId: later,
      amountCents: 500, currency: 'USD', status: 'pending', tagged: true });
    await db.forGym(f.gymId, tx => tx.update(refunds).set({ createdAt: new Date(f.clock.now().getTime() - 23 * 3600_000) })
      .where(eq(refunds.id, later)));
    const own = await f.provider.refund({ chargeId: paid.paymentIntentId!, amount: 500, idempotencyKey: 'lost', reservationId: refundId });
    vi.spyOn(f.provider, 'listRefunds').mockResolvedValue([own, { ...own, id: 're_ambiguous' }]);
    const [job] = createLapsedRefundJobs({ scope: db.forGym, clock: f.clock, transitions: f.options.transitions, payments: async () => f.provider });
    await expect(job!.handler({}, { jobId: uuidv7(), gymId: f.gymId, timezone: 'UTC', attempt: 1, clock: f.clock })).rejects.toThrow('Ambiguous');
    expect(await refundRows(payment.id, f)).toEqual(expect.arrayContaining([expect.objectContaining({ id: refundId, status: 'pending' }),
      expect.objectContaining({ id: later, status: 'failed', processorId: null })]));
  });
  it('answers a staff refund on an ambiguous reservation with a conflict and sends nothing', async () => {
    const f = await fixture(), { payment, paid, refundId } = await lapsedReservation(f);
    const own = await f.provider.refund({ chargeId: paid.paymentIntentId!, amount: 1000, idempotencyKey: 'lost', reservationId: refundId });
    vi.spyOn(f.provider, 'listRefunds').mockResolvedValue([own, { ...own, id: 're_ambiguous' }]);
    const refund = vi.spyOn(f.provider, 'refund');
    await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents: 1000 }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: ['refund_reconciliation'] } });
    expect(refund).not.toHaveBeenCalled(); expect(await refundRows(payment.id, f)).toMatchObject([{ status: 'pending' }]);
  });
  it('does not need a provider for an empty scheduled run and leaves reservations pending when Stripe cannot be read', async () => {
    const f = await fixture(), provider = vi.fn(async () => { throw new Error('Stripe unavailable'); });
    const [job] = createLapsedRefundJobs({ scope: db.forGym, clock: f.clock, transitions: f.options.transitions, payments: provider });
    const context = { jobId: uuidv7(), gymId: f.gymId, timezone: 'UTC', attempt: 1, clock: f.clock };
    await job!.handler({}, context); expect(provider).not.toHaveBeenCalled();
    const { payment } = await lapsedReservation(f);
    await expect(job!.handler({}, context)).rejects.toThrow('Stripe unavailable');
    expect(await refundRows(payment.id, f)).toMatchObject([{ status: 'pending' }]);
  });
  it('waits for an ordinary refund worker of the gym before settling, across PostgreSQL workers', async () => {
    const f = await fixture(), { payment } = await lapsedReservation(f);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const listed = vi.spyOn(f.provider, 'listRefunds');
    const worker = () => {
      const queue = new PostgresJobs({ database: db, clock: f.clock });
      createServerRegistry({ jobs: createLapsedRefundJobs({ scope: db.forGym, clock: f.clock, transitions: f.options.transitions,
        payments: async () => f.provider }) }).registerJobs(queue, new Set());
      queue.handle('billing.transitions.effect', async () => { started(); await held; });
      return queue;
    };
    const first = worker(), second = worker(), options = { gymId: f.gymId, timezone: 'UTC' };
    await first.enqueue('billing.transitions.effect', {}, options);
    const running = first.runNext();
    try {
      await Promise.race([entered, running.then(() => { throw new Error('Refund worker never started'); })]);
      await second.enqueue(lapsedRefundJob, {}, options);
      expect(await second.runNext()).toBe(false); expect(listed).not.toHaveBeenCalled();
      expect(await refundRows(payment.id, f)).toMatchObject([{ status: 'pending' }]);
    } finally { release(); await running; }
    expect(await second.runNext()).toBe(true); expect(listed).toHaveBeenCalledTimes(1);
    expect(await refundRows(payment.id, f)).toMatchObject([{ status: 'failed' }]);
  });
  const readiness = async (f: Fixture) => (await createGoLiveService({ scope: db.forGym, clock: f.clock, smtpConfigured: async () => true })
    .checklist(f.gymId)).items.find(item => item.id === 'reconciliation_complete')?.status;
  it.each([1000, 500])('releases a tagged reservation that never reached Stripe once its window has passed, for a request of %i, moving no money', async amountCents => {
    const f = await fixture(), { payment, paid, refundId } = await lapsedReservation(f);
    const dashboard = await f.provider.refund({ chargeId: paid.paymentIntentId!, amount: 1000, idempotencyKey: 'dashboard' });
    await createDisputeRefundWriter({ scope: db.forGym, clock: f.clock, transitions: f.options.transitions }).refund(f.gymId, paid, dashboard);
    expect(await refundRows(payment.id, f)).toHaveLength(2);
    expect(await readiness(f)).toBe('needs_attention');
    const refund = vi.spyOn(f.provider, 'refund');
    await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: ['refund_reconciled'] } });
    expect(refund).not.toHaveBeenCalled();
    const rows = await refundRows(payment.id, f);
    expect(rows.find(row => row.id === refundId)).toMatchObject({ status: 'failed', processorId: null });
    expect(rows.find(row => row.processorId === dashboard.id)).toMatchObject({ status: 'succeeded', amountCents: 1000 });
    expect(await readiness(f)).not.toBe('needs_attention');
    // The next request is a new decision, with a new reservation and key.
    expect(await f.service.refund(f.context, payment.id, { ...staffRefund, amountCents })).toMatchObject({ status: 'succeeded', amountCents });
    expect(refund.mock.calls[0]![0].idempotencyKey).not.toBe(`refund:${refundId}`);
  });
  it('records the refund that names a tagged reservation past its window, and sends nothing', async () => {
    const f = await fixture(), { payment, paid, refundId } = await lapsedReservation(f);
    const own = await f.provider.refund({ chargeId: paid.paymentIntentId!, amount: 1000, idempotencyKey: `refund:${refundId}`, reservationId: refundId });
    const refund = vi.spyOn(f.provider, 'refund');
    await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents: 1000 }))
      .rejects.toMatchObject({ details: { reason: ['refund_reconciled'] } });
    expect(refund).not.toHaveBeenCalled();
    expect(await refundRows(payment.id, f)).toMatchObject([{ id: refundId, status: 'succeeded', processorId: own.id }]);
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('partially_refunded');
  });
  it('releases a tagged reservation past its window when the refund naming it has another amount', async () => {
    const f = await fixture(), { payment, paid, refundId } = await lapsedReservation(f);
    await f.provider.refund({ chargeId: paid.paymentIntentId!, amount: 700, idempotencyKey: 'edited', reservationId: refundId });
    await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents: 1000 }))
      .rejects.toMatchObject({ details: { reason: ['refund_reconciled'] } });
    expect(await refundRows(payment.id, f)).toMatchObject([{ id: refundId, status: 'failed', processorId: null }]);
  });
  it('keeps refusing a reservation past its window that is unmarked or already at Stripe, without reading Stripe', async () => {
    const unmarked = await fixture(), old = await lapsedReservation(unmarked, 1000, false);
    const atStripe = await fixture(), sent = await lapsedReservation(atStripe);
    await atStripe.options.transitions.refund(atStripe.context, { invoiceId: atStripe.invoice.id, paymentId: sent.payment.id, refundId: sent.refundId,
      processorId: 're_at_stripe', amountCents: 1000, currency: 'USD', status: 'pending' });
    for (const [f, { payment, refundId }] of [[unmarked, old], [atStripe, sent]] as const) {
      const listed = vi.spyOn(f.provider, 'listRefunds'), refund = vi.spyOn(f.provider, 'refund');
      await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents: 1000 })).rejects.toMatchObject({ code: 'conflict' });
      await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents: 500 }))
        .rejects.toMatchObject({ details: { reason: ['pending_refund'] } });
      expect(listed).not.toHaveBeenCalled(); expect(refund).not.toHaveBeenCalled();
      expect(await refundRows(payment.id, f)).toMatchObject([{ id: refundId, status: 'pending' }]);
    }
  });
  it('leaves a tagged reservation inside its window alone, and another gym’s staff can’t reach one past it', async () => {
    const f = await fixture(), other = await fixture(), { payment, refundId } = await lapsedReservation(f);
    await db.forGym(f.gymId, tx => tx.update(refunds).set({ createdAt: new Date(f.clock.now().getTime() - 3600_000) }).where(eq(refunds.id, refundId)));
    const listed = vi.spyOn(f.provider, 'listRefunds');
    await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents: 500 }))
      .rejects.toMatchObject({ details: { reason: ['pending_refund'] } });
    expect(listed).not.toHaveBeenCalled();
    await db.forGym(f.gymId, tx => tx.update(refunds).set({ createdAt: new Date(f.clock.now().getTime() - 24 * 3600_000) }).where(eq(refunds.id, refundId)));
    await expect(other.service.refund(other.context, payment.id, { ...staffRefund, amountCents: 1000 })).rejects.toMatchObject({ code: 'not_found' });
    expect(listed).not.toHaveBeenCalled();
    expect(await refundRows(payment.id, f)).toMatchObject([{ id: refundId, status: 'pending' }]);
  });
  it('sends nothing when a webhook releases the reservation between the two steps of a staff refund', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!;
    const transition = f.options.transitions.refund.bind(f.options.transitions);
    vi.spyOn(f.options.transitions, 'refund').mockImplementationOnce(async (context, request) => {
      await transition(context, request);
      return transition(context, { ...request, status: 'failed' });
    });
    const refund = vi.spyOn(f.provider, 'refund');
    await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents: 1000 }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: ['refund_released'] } });
    expect(refund).not.toHaveBeenCalled();
    expect(await refundRows(payment.id, f)).toMatchObject([{ status: 'failed', processorId: null, reason: null }]);
  });
  it('sends nothing when a staff retry crosses the 23-hour window after reading its reservation', async () => {
    const f = await fixture(), { payment, refundId } = await lapsedReservation(f);
    await db.forGym(f.gymId, tx => tx.update(refunds).set({ createdAt: f.clock.now() }).where(eq(refunds.id, refundId)));
    const transition = f.options.transitions.refund.bind(f.options.transitions);
    vi.spyOn(f.options.transitions, 'refund').mockImplementationOnce(async (context, request) => {
      const result = await transition(context, request); f.clock.advance(23 * 3600_000); return result;
    });
    const sent = vi.spyOn(f.provider, 'refund');
    await expect(f.service.refund(f.context, payment.id, { ...staffRefund, amountCents: 1000 }))
      .rejects.toMatchObject({ details: { reason: ['refund_reconciliation'] } });
    expect(sent).not.toHaveBeenCalled(); expect(await refundRows(payment.id, f)).toMatchObject([{ status: 'pending' }]);
  });
  it('refuses to refund a card payment a switch to live marked as test, without calling Stripe', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!;
    await db.forGym(f.gymId, tx => tx.update(payments).set({ reference: stripeTestPaymentReference }).where(eq(payments.id, payment.id)));
    const refund = vi.spyOn(f.provider, 'refund');
    await expect(f.service.refund(f.context, payment.id, { amountCents: 500, currency: 'USD', reason: 'Returned item' }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: ['test_payment'] } });
    expect(refund).not.toHaveBeenCalled();
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).refunds).toHaveLength(0);
  });
  it('refuses a refund reserved while a switch to live holds the gym row once the switch marks its payment, without calling Stripe', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!;
    const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    let saving: Promise<void> | undefined;
    const transition = f.options.transitions.refund.bind(f.options.transitions);
    vi.spyOn(f.options.transitions, 'refund').mockImplementationOnce(async (context, request) => {
      const reserved = await transition(context, request);
      // The switch's save, after its in-flight check missed this reservation: it holds the gym row and marks the payment.
      saving = db.forGym(f.gymId, async tx => {
        // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
        const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
        await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, f.gymId)).for('update');
        await tx.update(payments).set({ reference: stripeTestPaymentReference }).where(eq(payments.id, payment.id));
        locked.resolve(pid); await release.promise;
      });
      await locked.promise;
      return reserved;
    });
    const refund = vi.spyOn(f.provider, 'refund');
    const refunding = f.service.refund(f.context, payment.id, { amountCents: 500, currency: 'USD', reason: 'Returned item' });
    let finished = false;
    void refunding.then(() => { finished = true; }, () => { finished = true; });
    try {
      const pid = await locked.promise;
      let sawWait = false;
      // From the system connection: the switch and the waiting refund hold both of the gym pool's connections.
      for (let tries = 0; tries < 5_000 && !sawWait && !finished; tries++)
        // eslint-disable-next-line database/system-tables -- The lock-wait probe.
        sawWait = (await db.system.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
      expect(sawWait).toBe(true);
      expect(finished).toBe(false);
    } finally { release.resolve(); await saving; }
    await expect(refunding).rejects.toMatchObject({ code: 'conflict', details: { reason: ['test_payment'] } });
    expect(refund).not.toHaveBeenCalled();
    // The reservation is released: it never reached Stripe.
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).refunds).toMatchObject([{ status: 'failed', amountCents: 500 }]);
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.refund.requested')));
    expect(audits).toEqual([]);
  });
  it.each(['declined', 'authentication_required'] as const)('keeps a %s one-off open with no dunning or retry effects', async outcome => {
    const f = await fixture(); f.provider.respondNextConfirmation(outcome);
    const attempt = await f.service.charge(f.context, f.invoice.id);
    expect(attempt.status).toBe(outcome === 'declined' ? 'failed' : 'requires_action');
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('open');
    const effects = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.transition.effect.created')));
    expect(effects.some(e => ['dunning', 'retry'].includes((e.after as { kind: string }).kind))).toBe(false);
    expect(f.jobs.jobs).toHaveLength(0);
  });
  it('snapshots charge type, inclusive/exclusive taxes, and custom cents on separate invoices', async () => {
    const f = await fixture(), tax = await factory('taxRates', f.gymId, { rateMillionths: 100_000, inclusive: false });
    const charge = await factory('chargeTypes', f.gymId, { amountCents: 1000, name: 'Mat fee' });
    await factory('chargeTypeTaxRates', f.gymId, { chargeTypeId: charge.id, taxRateId: tax.id });
    const invoice = await f.service.createOneOff(f.context, { source: 'charge_type', householdId: f.home.id, chargeTypeId: charge.id, dueOn: '2026-10-25' });
    expect(invoice).toMatchObject({ kind: 'one_off', status: 'open', amountCents: 1100 });
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ needsReview: true }).where(eq(invoices.id, f.invoice.id)));
    const detail = await f.service.getInvoice(f.gymId, invoice.id);
    expect(detail.lineItems.map(l => l.description)).toEqual(['Mat fee', tax.name]);
    const inclusive = await factory('taxRates', f.gymId, { rateMillionths: 100_000, inclusive: true });
    const custom = await f.service.createOneOff(f.context, { source: 'custom', householdId: f.home.id, amountCents: 1100, description: 'Custom', currency: 'USD', dueOn: '2026-10-25', taxRateIds: [inclusive.id] });
    expect(custom.amountCents).toBe(1100); expect(custom.id).not.toBe(invoice.id);
    expect(new Set([invoice.number, custom.number, f.invoice.number, f.paid.number]).size).toBe(4);
  });
  it('uses the Stripe adapter with synthetic API fixtures for a declined one-off', async () => {
    const f = await fixture(), transport = new StripeFixtures(f.gymId), provider = new StripePayments(f.gymId, { clock: f.clock, transport, webhookSecret: 'whsec_SYNTHETIC' });
    await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ processorId: 'pm_0341' }).where(eq(paymentMethods.id, f.card.id)));
    const service = createPaymentService({ ...f.options, paymentsFor: async () => provider,
      runner: createChargeRunner({ ...f.options, payments: async () => provider }) });
    expect((await service.charge(f.context, f.invoice.id)).status).toBe('failed');
    expect((await service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('open');
    expect(transport.requests.filter(r => r.path.endsWith('/confirm'))).toHaveLength(1);
    const stored = await db.forGym(f.gymId, tx => tx.select().from(paymentAttempts));
    expect(stored).toHaveLength(1); expect(stored[0]?.paymentIntentId).toBeTruthy();
  });
  it('deduplicates concurrent staff card charges and leaves lost confirmations pending until lookup', async () => {
    const f = await fixture();
    await Promise.allSettled([f.service.charge(f.context, f.invoice.id), f.service.charge(f.context, f.invoice.id)]);
    const detail = await f.service.getInvoice(f.gymId, f.invoice.id);
    expect(detail.payments).toHaveLength(1); expect(detail.invoice.status).toBe('paid');
    const next = await f.create(); f.provider.loseNextResponse('confirmCharge');
    await expect(f.service.charge(f.context, next.id)).rejects.toThrow();
    expect((await f.service.getInvoice(f.gymId, next.id)).payments).toHaveLength(0);
    await expect(f.service.charge(f.context, next.id)).rejects.toMatchObject({ details: { reason: ['pending_attempt'] } });
    f.clock.advance(16 * 60_000); await f.runner.reconcile(f.gymId);
    expect((await f.service.getInvoice(f.gymId, next.id)).payments).toHaveLength(1);
  });
  it('leaves lost create responses to reconciliation and never adopts another caller’s pending attempt', async () => {
    const f = await fixture(); f.provider.loseNextResponse('createCharge');
    await expect(f.service.charge(f.context, f.invoice.id)).rejects.toThrow();
    const createCharge = vi.spyOn(f.provider, 'createCharge');
    await expect(f.service.charge(f.context, f.invoice.id)).rejects.toMatchObject({ details: { reason: ['pending_attempt'] } });
    expect(createCharge).not.toHaveBeenCalled();
    f.clock.advance(16 * 60_000); await f.runner.reconcile(f.gymId);
    expect((await f.service.charge(f.context, f.invoice.id)).status).toBe('succeeded');
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).payments).toHaveLength(1);
    const next = await f.create(); f.provider.loseNextResponse('createCharge');
    await expect(f.service.charge(f.context, next.id)).rejects.toThrow();
    f.clock.advance(24 * 3600_000);
    const create = vi.spyOn(f.provider, 'createCharge').mockClear();
    await expect(f.service.charge(f.context, next.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(create).not.toHaveBeenCalled();
  });
  it('records a check reference and a manual partial refund through the transitions', async () => {
    const f = await fixture();
    const payment = await f.service.manualPayment(f.context, f.invoice.id, { amountCents: 2500, currency: 'USD', method: 'check', reference: '204', paidAt: f.clock.now().toISOString() });
    expect(payment).toMatchObject({ method: 'check', reference: '204' });
    const refund = await f.service.refund(f.context, payment.id, { amountCents: 500, currency: 'USD', reason: 'Returned cash' });
    expect(refund).toMatchObject({ status: 'succeeded', reason: 'Returned cash' });
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('partially_refunded');
    // No processor refund will ever name it.
    expect(await refundRows(payment.id, f)).toMatchObject([{ id: refund.id, taggedAt: null }]);
  });
  it('records the actual success time when looking up a delayed lost response', async () => {
    const f = await fixture(), paidAt = f.clock.now(); f.provider.loseNextResponse('confirmCharge');
    await expect(f.service.charge(f.context, f.invoice.id)).rejects.toThrow(); f.clock.advance(3 * 86400_000);
    await f.runner.reconcile(f.gymId);
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]?.paidAt).toBe(paidAt.toISOString());
  });
  it('refuses mismatched manual money, duplicate cash, and unresolved card payments', async () => {
    const f = await fixture();
    await expect(f.service.manualPayment(f.context, f.invoice.id, { amountCents: 1, currency: 'USD', method: 'cash', paidAt: f.clock.now().toISOString() })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.manualPayment(f.context, f.paid.id, { amountCents: 2500, currency: 'USD', method: 'cash', paidAt: f.clock.now().toISOString() })).rejects.toMatchObject({ code: 'conflict' });
    f.provider.respondNextConfirmation('pending'); await f.service.charge(f.context, f.invoice.id);
    await expect(f.service.manualPayment(f.context, f.invoice.id, { amountCents: 2500, currency: 'USD', method: 'check', paidAt: f.clock.now().toISOString() })).rejects.toMatchObject({ code: 'conflict' });
    const other = await fixture();
    await expect(f.service.createOneOff(f.context, { source: 'custom', householdId: f.home.id, dueOn: '2026-10-25', description: 'Invalid', amountCents: 100, currency: 'CAD' })).rejects.toMatchObject({ code: 'conflict' });
    const tax = await factory('taxRates', other.gymId);
    await expect(f.service.createOneOff(f.context, { source: 'custom', householdId: f.home.id, dueOn: '2026-10-25', description: 'Invalid', amountCents: 100, currency: 'USD', taxRateIds: [tax.id] })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('reserves refunds, reuses a lost-response reservation and prevents over-refunding', async () => {
    const f = await fixture(); await f.service.charge(f.context, f.invoice.id);
    const payment = (await f.service.getInvoice(f.gymId, f.invoice.id)).payments[0]!;
    const input = { amountCents: 1000, currency: 'USD', reason: 'Returned item' };
    f.provider.loseNextResponse('refund'); await expect(f.service.refund(f.context, payment.id, input)).rejects.toThrow();
    expect((await f.service.listRefunds(f.gymId, { paymentId: payment.id })).data[0]?.status).toBe('pending');
    expect((await f.service.refund(f.context, payment.id, input)).status).toBe('succeeded');
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('partially_refunded');
    await expect(f.service.refund(f.context, payment.id, { ...input, amountCents: 2000 })).rejects.toMatchObject({ code: 'conflict' });
    await f.service.refund(f.context, payment.id, { ...input, amountCents: 1500 });
    expect((await f.service.getInvoice(f.gymId, f.invoice.id)).invoice.status).toBe('refunded');
  });
  it('revokes locally before detaching outside a transaction, retries an outage, and never charges the removed card', async () => {
    const f = await fixture(); f.detachCard.mockRejectedValueOnce(new Error('Stripe unavailable'));
    await expect(f.service.revokeCard(f.context, f.home.id, f.card.id)).rejects.toThrow('Stripe unavailable');
    const card = (await f.service.listPaymentMethods(f.gymId, f.home.id, {})).data[0]!;
    expect(card).toMatchObject({ isDefault: false, revokedAt: f.clock.now().toISOString() });
    expect(JSON.stringify(card)).not.toContain('pm_4242');
    await expect(f.service.charge(f.context, f.invoice.id)).rejects.toMatchObject({ code: 'conflict' });
    await f.jobs.runNext(); expect(f.detachCard).toHaveBeenLastCalledWith(f.gymId, 'pm_4242');
    const sibling = await factory('households', f.gymId);
    await expect(f.service.revokeCard(f.context, sibling.id, f.card.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('detaches with the billing-details flag only when the job asks for it (an erasure), never for a staff removal', async () => {
    const f = await fixture();
    await f.service.revokeCard(f.context, f.home.id, f.card.id);
    expect(f.detachCard).toHaveBeenLastCalledWith(f.gymId, 'pm_4242');
    await f.jobs.runNext(); expect(f.detachCard).toHaveBeenLastCalledWith(f.gymId, 'pm_4242');
    await f.jobs.enqueue(detachJob, { paymentMethodId: f.card.id, redactBillingDetails: true },
      { gymId: f.gymId, timezone: 'UTC', idempotencyKey: 'detach:erased:' + f.card.id });
    await f.jobs.runNext(); expect(f.detachCard).toHaveBeenLastCalledWith(f.gymId, 'pm_4242', { redactBillingDetails: true });
    // Anything but true is ignored.
    await f.jobs.enqueue(detachJob, { paymentMethodId: f.card.id, redactBillingDetails: 'yes' },
      { gymId: f.gymId, timezone: 'UTC', idempotencyKey: 'detach:other:' + f.card.id });
    await f.jobs.runNext(); expect(f.detachCard).toHaveBeenLastCalledWith(f.gymId, 'pm_4242');
  });
  it('queues a receipt and sends it using the shared notification delivery, respecting the email switch', async () => {
    const f = await fixture();
    expect(await f.service.resendReceipt(f.context, f.paid.id)).toEqual({ queued: true });
    await f.jobs.runNext(); expect(f.email.messages).toHaveLength(1); expect(f.email.messages[0]?.to).toBe('payer@example.invalid');
    await expect(f.service.resendReceipt(f.context, f.invoice.id)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('creates and sends invoice-specific signed links without requiring the redemption page', async () => {
    const f = await fixture(), server = app(f, staff(f, 'front_desk'));
    const input = { purpose: 'pay_invoice' as const, householdId: f.home.id, invoiceId: f.invoice.id, expiresAt: '2026-11-01T12:00:00Z' };
    const response = await server.request(origin + linksContracts.createLink.path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    const result = linksContracts.createLink.response.parse(await response.json()).data;
    expect(await f.links.resolve(f.gymId, result.token)).toMatchObject({ status: 'active', principal: { householdId: f.home.id, link: { purpose: 'pay_invoice', invoiceId: f.invoice.id } } });
    expect(JSON.stringify(await db.forGym(f.gymId, tx => tx.select().from(signedLinks)))).not.toContain(result.token);
    await f.links.send(f.context, { ...input, sendGeneration: uuidv7() }); expect(f.email.messages[0]?.text).toContain(origin + '/l/');
    const sibling = await factory('households', f.gymId);
    await expect(f.links.create(f.context, { ...input, householdId: sibling.id })).rejects.toMatchObject({ code: 'not_found' });
  });
});
