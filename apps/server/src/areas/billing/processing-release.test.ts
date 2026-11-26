// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, invoices, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { type StaffRole } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { createApp } from '../../app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import type { ChargeOutcome, Payments } from '../../infra/payments/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createCheckoutDebitReviewProvider } from './alerts/checkout-debits.js';
import { createPaymentService } from './payments.js';
import { createPaymentRoutes } from './payments.routes.js';
import { checkoutReviewAction } from './runner/reconciliation.js';
import { createInvoiceTransitions, processingReleased } from './transitions/index.js';
import { retriesStopped } from './transitions/bank.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
type Answer = ChargeOutcome | Error;

/** A processing invoice whose latest processing intent is `pi_1`, with the sweep's finding for `findingFor`. */
async function fixture(options: { kind?: 'one_off' | 'cycle'; reason?: string; findingFor?: string; older?: boolean } = {}) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-20T12:00:00Z');
  await factory('gyms', gymId, { currency: 'USD', billingEnabled: true });
  const user = await factory('authUser', gymId), home = await factory('households', gymId, { stripeCustomerId: 'cus_1' });
  const bill = await factory('invoices', gymId, { householdId: home.id, number: 7, status: 'open', currency: 'USD', amountCents: 2500,
    ...(options.kind === 'cycle' ? { kind: 'cycle', periodStartsOn: '2026-11-01', periodEndsOn: '2026-12-01' } : {}) });
  const system = { gymId, actor: { kind: 'system' as const } };
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  if (options.older) {
    await transitions.paymentProcessing(system, { invoiceId: bill.id, paymentIntentId: 'pi_0' });
    await transitions.processingFailed(system, { invoiceId: bill.id, paymentIntentId: 'pi_0', code: 'declined' });
  }
  await transitions.paymentProcessing(system, { invoiceId: bill.id, paymentIntentId: 'pi_1' });
  await db.forGym(gymId, tx => tx.update(invoices).set({ checkoutSessionId: 'cs_1', checkoutExpiresAt: clock.now() }).where(eq(invoices.id, bill.id)));
  await factory('auditEvents', gymId, { action: checkoutReviewAction, targetType: 'invoice', targetId: bill.id,
    after: { reason: options.reason ?? 'customer_mismatch', paymentIntentId: options.findingFor ?? 'pi_1' } });
  const answers: Answer[] = [];
  const identity = { id: 'pi_1', amount: 2500, currency: 'usd', customerId: 'cus_other', metadata: { gymId, invoiceId: bill.id } };
  const findCharge = vi.fn(async (): Promise<ChargeOutcome> => {
    assertNoTransaction('findCharge');
    const answer = answers.length > 1 ? answers.shift()! : answers[0] ?? { ...identity, status: 'failed', code: 'canceled' };
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const provider = { findCharge } as unknown as Payments;
  const service = createPaymentService({ scope: db.forGym, clock, transitions, paymentsFor: async () => provider });
  const row = async () => (await db.forGym(gymId, tx => tx.select().from(invoices).where(eq(invoices.id, bill.id))))[0]!;
  const audits = (action?: string) => db.forGym(gymId, tx => tx.select().from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), action ? eq(auditEvents.action, action) : undefined)));
  /** The audits written after `known` was taken. */
  const since = async (known: { id: string }[]) => (await audits()).filter(event => !known.some(old => old.id === event.id));
  return { gymId, clock, user, home, bill, context, system, transitions, service, findCharge, answers, identity, row, audits, since };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const refused = (reason: string, code = 'conflict') => ({ code, details: { reason: [reason] } });

describe('releasing an invoice stuck on a flagged Checkout bank debit', () => {
  it('makes a one-off invoice open once Stripe reports the debit cancelled, without dunning, and cash then pays it', async () => {
    const f = await fixture();
    const before = await f.audits();
    const released = await f.service.releaseProcessing(f.context, f.bill.id);
    expect(released).toMatchObject({ id: f.bill.id, status: 'open' });
    expect(f.findCharge).toHaveBeenCalledExactlyOnceWith({ kind: 'charge', id: 'pi_1' });
    expect(await f.row()).toMatchObject({ status: 'open', checkoutSessionId: null, checkoutExpiresAt: null });
    const added = await f.since(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: processingReleased, actorKind: 'user', actorUserId: f.user.id, targetId: f.bill.id,
      after: { status: 'open', paymentIntentId: 'pi_1', code: 'canceled' }, before: { status: 'processing' } });
    expect(await f.audits('billing.invoice.payment_failed')).toEqual([]);
    const payment = await f.service.manualPayment(f.context, f.bill.id, { amountCents: 2500, currency: 'USD', method: 'cash',
      paidAt: f.clock.now().toISOString() });
    expect(payment).toMatchObject({ method: 'cash', amountCents: 2500 });
    expect((await f.row()).status).toBe('paid');
  });

  it('makes a cycle invoice past due without starting dunning', async () => {
    const f = await fixture({ kind: 'cycle', reason: 'attempt_resolved' });
    f.answers.push({ ...f.identity, status: 'failed', code: 'insufficient_funds' });
    const before = await f.audits();
    expect(await f.service.releaseProcessing(f.context, f.bill.id)).toMatchObject({ status: 'past_due' });
    expect((await f.row()).status).toBe('past_due');
    expect((await f.since(before)).map(event => event.action)).toEqual([processingReleased]);
    expect(await f.audits('billing.invoice.dunning_started')).toEqual([]);
  });

  it('refuses while Stripe reports the debit open, paid, processing, mismatched or unknown', async () => {
    const f = await fixture();
    const cases: [Answer, ReturnType<typeof refused>][] = [
      [{ ...f.identity, status: 'pending' }, refused('debit_open')],
      [{ ...f.identity, status: 'action_required', code: 'authentication_required' }, refused('debit_open')],
      [{ ...f.identity, status: 'succeeded' }, refused('debit_paid')],
      [{ ...f.identity, status: 'processing' }, refused('debit_processing')],
      [{ ...f.identity, status: 'failed', code: 'canceled', metadata: { gymId: f.gymId, invoiceId: uuidv7() } }, refused('debit_mismatch')],
      [{ ...f.identity, status: 'failed', code: 'canceled', metadata: { gymId: uuidv7(), invoiceId: f.bill.id } }, refused('debit_mismatch')],
      [{ ...f.identity, id: 'pi_other', status: 'failed', code: 'canceled' }, refused('debit_mismatch')],
      [{ status: 'unknown', reference: { kind: 'charge', id: 'pi_1' } }, refused('debit_unknown')],
      [new Error('Stripe timed out'), refused('payments_unavailable', 'unavailable')],
    ];
    const before = (await f.audits()).length;
    for (const [answer, expected] of cases) {
      f.answers.splice(0, f.answers.length, answer);
      await expect(f.service.releaseProcessing(f.context, f.bill.id)).rejects.toMatchObject(expected);
      expect((await f.row()).status).toBe('processing');
    }
    expect(f.findCharge).toHaveBeenCalledTimes(cases.length);
    expect((await f.audits()).length).toBe(before);
  });

  it('answers payments_unavailable when the gym has no readable Stripe provider', async () => {
    const f = await fixture();
    for (const paymentsFor of [async () => { throw new Error('Stripe settings unreadable'); }, async () => null]) {
      const service = createPaymentService({ scope: db.forGym, clock: f.clock, transitions: f.transitions, paymentsFor });
      await expect(service.releaseProcessing(f.context, f.bill.id)).rejects.toMatchObject(refused('payments_unavailable', 'unavailable'));
    }
    expect((await f.row()).status).toBe('processing');
  });

  it('releases a debit whose metadata names no invoice', async () => {
    const f = await fixture({ reason: 'pending' });
    f.answers.push({ ...f.identity, status: 'failed', code: 'declined', metadata: { gymId: f.gymId } });
    expect(await f.service.releaseProcessing(f.context, f.bill.id)).toMatchObject({ status: 'open' });
  });

  it('refuses without calling Stripe when only an older debit was flagged, or the invoice is not processing', async () => {
    const f = await fixture({ older: true, findingFor: 'pi_0' });
    await expect(f.service.releaseProcessing(f.context, f.bill.id)).rejects.toMatchObject(refused('debit_not_stuck'));
    expect(f.findCharge).not.toHaveBeenCalled();
    expect((await f.row()).status).toBe('processing');
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ status: 'open' }).where(eq(invoices.id, f.bill.id)));
    await expect(f.service.releaseProcessing(f.context, f.bill.id)).rejects.toMatchObject(refused('not_processing'));
    expect(f.findCharge).not.toHaveBeenCalled();
  });

  it('applies two concurrent releases once', async () => {
    const f = await fixture();
    const settled = await Promise.allSettled([f.service.releaseProcessing(f.context, f.bill.id), f.service.releaseProcessing(f.context, f.bill.id)]);
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter(item => item.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject(refused('not_processing'));
    expect(await f.audits(processingReleased)).toHaveLength(1);
  });

  it('leaves a later failure for the released intent ignored and drops the invoice from the dashboard count', async () => {
    const f = await fixture();
    const widget = createCheckoutDebitReviewProvider({ scope: db.forGym });
    const read = () => widget.read({ gymId: f.gymId, roles: ['owner'], clock: f.clock });
    expect(await read()).toHaveProperty('count', 1);
    await f.service.releaseProcessing(f.context, f.bill.id);
    expect(await f.transitions.processingFailed(f.system, { invoiceId: f.bill.id, paymentIntentId: 'pi_1', code: 'canceled' }))
      .toMatchObject({ outcome: 'ignored' });
    expect(await f.transitions.releaseProcessing(f.system, { invoiceId: f.bill.id, paymentIntentId: 'pi_1', code: 'canceled' }))
      .toMatchObject({ outcome: 'ignored' });
    expect((await f.row()).status).toBe('open');
    expect(await f.audits(processingReleased)).toHaveLength(1);
    expect(await read()).toBeNull();
  });
});

describe('releasing a flagged bank debit that failed on an unusable account', () => {
  /** The household's default bank method `pm_bank` and a non-default unexpired card. */
  async function withMethods(f: Fixture) {
    const bank = await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_bank', type: 'us_bank_account',
      bankName: 'Test Bank', brand: null, last4: '6789', expiryMonth: null, expiryYear: null, isDefault: true });
    const card = await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_card', type: 'card',
      expiryYear: 2030, expiryMonth: 12, isDefault: false });
    return { bank, card };
  }
  const method = (f: Fixture, id: string) => db.forGym(f.gymId, async tx =>
    (await tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)))[0]!);
  const revoked = 'billing.payment_method.revoked', unsavedRevoked = 'billing.payment_method.unsaved_revoked';

  it('revokes the bank method once, promotes the card, and starts no notice, dunning or retries', async () => {
    const f = await fixture();
    const { bank, card } = await withMethods(f);
    f.answers.push({ ...f.identity, status: 'failed', code: 'payment_method_unusable', paymentMethodId: 'pm_bank' });
    const before = await f.audits();
    expect(await f.service.releaseProcessing(f.context, f.bill.id)).toMatchObject({ status: 'open' });
    expect(await method(f, bank.id)).toMatchObject({ revokedAt: f.clock.now(), isDefault: false });
    expect(await method(f, card.id)).toMatchObject({ revokedAt: null, isDefault: true });
    const added = await f.since(before);
    expect(added.filter(event => event.action === processingReleased)).toEqual([
      expect.objectContaining({ targetId: f.bill.id, after: expect.objectContaining({ code: 'payment_method_unusable' }) })]);
    expect(added.filter(event => event.action === revoked)).toEqual([
      expect.objectContaining({ targetType: 'payment_method', targetId: bank.id, after: { invoiceId: f.bill.id } })]);
    for (const action of ['billing.invoice.payment_failed', 'billing.invoice.dunning_started', retriesStopped])
      expect(await f.audits(action)).toEqual([]);
    expect(await f.transitions.releaseProcessing(f.system, { invoiceId: f.bill.id, paymentIntentId: 'pi_1',
      code: 'payment_method_unusable', paymentMethodId: 'pm_bank' })).toMatchObject({ outcome: 'ignored' });
    expect(await f.audits(revoked)).toHaveLength(1);
  });

  it.each(['insufficient_funds', 'declined', 'canceled'] as const)('leaves the bank method saved for %s', async code => {
    const f = await fixture();
    const { bank } = await withMethods(f);
    f.answers.push({ ...f.identity, status: 'failed', code, paymentMethodId: 'pm_bank' });
    expect(await f.service.releaseProcessing(f.context, f.bill.id)).toMatchObject({ status: 'open' });
    expect(await method(f, bank.id)).toMatchObject({ revokedAt: null, isDefault: true });
    expect(await f.audits(revoked)).toEqual([]);
  });

  it('changes no method without a payment method ID', async () => {
    const f = await fixture();
    const { bank, card } = await withMethods(f);
    f.answers.push({ ...f.identity, status: 'failed', code: 'payment_method_unusable' });
    expect(await f.service.releaseProcessing(f.context, f.bill.id)).toMatchObject({ status: 'open' });
    expect(await method(f, bank.id)).toMatchObject({ revokedAt: null, isDefault: true });
    expect(await method(f, card.id)).toMatchObject({ revokedAt: null, isDefault: false });
    expect(await f.audits(revoked)).toEqual([]);
    expect(await f.audits(unsavedRevoked)).toEqual([]);
  });

  // A processor ID is unique within a gym, so the other household holds the ID this household has no row for.
  it("records an unsaved method's revocation and leaves another household's method with that ID saved", async () => {
    const f = await fixture();
    const { bank } = await withMethods(f);
    const neighbour = await factory('households', f.gymId);
    const theirs = await factory('paymentMethods', f.gymId, { householdId: neighbour.id, processorId: 'pm_gone', type: 'us_bank_account',
      bankName: 'Test Bank', brand: null, last4: '1111', expiryMonth: null, expiryYear: null, isDefault: true });
    f.answers.push({ ...f.identity, status: 'failed', code: 'payment_method_unusable', paymentMethodId: 'pm_gone' });
    expect(await f.service.releaseProcessing(f.context, f.bill.id)).toMatchObject({ status: 'open' });
    expect(await f.audits(unsavedRevoked)).toEqual([expect.objectContaining({ targetType: 'household', targetId: f.home.id,
      after: { invoiceId: f.bill.id, paymentMethodId: 'pm_gone' } })]);
    expect(await f.audits(revoked)).toEqual([]);
    expect(await method(f, bank.id)).toMatchObject({ revokedAt: null, isDefault: true });
    expect(await method(f, theirs.id)).toMatchObject({ revokedAt: null, isDefault: true });
  });

  it('applies two concurrent releases once and revokes once', async () => {
    const f = await fixture();
    await withMethods(f);
    f.answers.push({ ...f.identity, status: 'failed', code: 'payment_method_unusable', paymentMethodId: 'pm_bank' });
    const settled = await Promise.allSettled([f.service.releaseProcessing(f.context, f.bill.id), f.service.releaseProcessing(f.context, f.bill.id)]);
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter(item => item.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject(refused('not_processing'));
    expect(await f.audits(revoked)).toHaveLength(1);
  });
});

describe('release-processing route', () => {
  function app(f: Fixture, principal: Principal) {
    return createApp({ clock: f.clock, origin, authorize, contributions: { routes: createPaymentRoutes(f.service) },
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); },
    });
  }
  const staff = (f: Fixture, role: StaffRole): Principal => ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
  const post = (f: Fixture, principal: Principal, invoiceId: string) => app(f, principal).request(
    `${origin}/api/billing/invoices/${invoiceId}/release-processing`,
    { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });

  it.each(['owner', 'admin'] as const)('lets an %s release the invoice', async role => {
    const f = await fixture();
    const response = await post(f, staff(f, role), f.bill.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: f.bill.id, status: 'open' } });
  });

  it.each(['coach', 'front_desk'] as const)('refuses a %s', async role => {
    const f = await fixture();
    expect((await post(f, staff(f, role), f.bill.id)).status).toBe(403);
    expect(f.findCharge).not.toHaveBeenCalled();
    expect((await f.row()).status).toBe('processing');
  });

  it("answers 404 for another gym's invoice and leaves it processing", async () => {
    const f = await fixture(), other = await fixture();
    expect((await post(f, staff(f, 'owner'), other.bill.id)).status).toBe(404);
    expect((await other.row()).status).toBe('processing');
    expect(other.findCharge).not.toHaveBeenCalled();
  });

  it('answers a refusal with its reason', async () => {
    const f = await fixture();
    f.answers.push({ ...f.identity, status: 'pending' });
    const response = await post(f, staff(f, 'owner'), f.bill.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: ['debit_open'] } } });
  });
});
