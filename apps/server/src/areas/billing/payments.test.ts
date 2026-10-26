// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, invoices, paymentAttempts, paymentMethods, signedLinks, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { canStaff, createTranslator, type StaffRole } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { billingContracts, linksContracts, releaseInvoiceHoldContract, type BillingEndpoint } from '@plaingym/shared/contracts';
import { locales } from '@plaingym/shared/locales';
import { createApp } from '../../app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { areaContributions } from '../../core/registry-areas.js';
import { FakePayments } from '../../infra/payments/index.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeEmail } from '../../infra/email/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createSignedLinksService } from '../links/service.js';
import { createSignedLinksRoutes } from '../links/service.routes.js';
import { createInvoiceTransitions } from './transitions/index.js';
import { createTransitionNotifications } from './transitions/notifications.js';
import { createPaymentService } from './payments.js';
import { createChargeRunner, type ChargeResult } from './runner/index.js';
import { configurePayments, createPaymentRoutes } from './payments.routes.js';
import { createPaymentJobs } from './payments.jobs.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-25T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true, memberEmailsEnabled: true });
  const user = await factory('authUser', gymId), home = await factory('households', gymId, { stripeCustomerId: 'cus_fixture', email: 'payer@example.invalid' });
  const card = await factory('paymentMethods', gymId, { householdId: home.id, processorId: 'pm_4242', isDefault: true });
  const provider = new FakePayments(gymId, clock); provider.seedCustomer({ id: 'cus_fixture', email: 'payer@example.invalid' });
  const jobs = new FakeJobs(clock), email = new FakeEmail(), settings = createGymSettingsAccessor({ scope: db.forGym });
  const detachCard = vi.fn(async (_gym: string, _id: string) => { assertNoTransaction('detachCard'); });
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
function request(server: ReturnType<typeof app>, operation: Operation, f: Fixture) {
  const contract = contracts[operation];
  const path = contract.path.replace('{invoiceId}', operation === 'resendReceipt' ? f.paid.id : f.invoice.id)
    .replace('{householdId}', f.home.id).replace('{paymentMethodId}', f.card.id).replace('{paymentId}', f.payment.id);
  const body = operation === 'createOneOffInvoice' ? { source: 'custom', householdId: f.home.id, dueOn: '2026-10-25', description: 'Drop-in', amountCents: 2500, currency: 'USD' }
    : operation === 'recordManualPayment' ? { amountCents: 2500, currency: 'USD', method: 'cash', paidAt: f.clock.now().toISOString() }
      : operation === 'createRefund' ? { amountCents: 2500, currency: 'USD', reason: null } : {};
  return server.request(origin + path, { method: contract.method.toUpperCase(),
    ...(contract.method === 'get' ? {} : { headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }) });
}

describe('payment route permissions and tenant isolation', () => {
  for (const operation of operations) {
    for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) it(`${operation}: ${role}`, async () => {
      const f = await fixture(), contract = contracts[operation], response = await request(app(f, staff(f, role)), operation, f);
      expect(response.status, await response.clone().text()).toBe(canStaff([role], contract.permission.capability) ? contract.successStatus : 403);
      const awaitValue = response.ok ? await response.json() : null;
      if (response.ok) expect(() => contract.response.parse(awaitValue)).not.toThrow();
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
});

describe('one-off collection and payment durability', () => {
  it.each(['billing_disabled', 'not_payable', 'needs_review', 'pending_attempt', 'no_saved_card', 'already_attempted',
    'outside_retry_window', 'not_auto_collectable', 'not_due', 'checkout_changed', 'reservation_lost', 'action_required', 'collection_changed'] as const)(
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
    await f.links.send(f.context, input); expect(f.email.messages[0]?.text).toContain(origin + '/l/');
    const sibling = await factory('households', f.gymId);
    await expect(f.links.create(f.context, { ...input, householdId: sibling.id })).rejects.toMatchObject({ code: 'not_found' });
  });
});
