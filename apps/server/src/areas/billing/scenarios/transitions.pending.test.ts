// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { TestClock } from '../../../core/clock.js';
import { FakeInvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import type { CardFailure, CardSuccess, InvoiceSnapshot, InvoiceTransitions, RefundTransition } from '../../../core/interfaces/invoice-transitions.js';

const id = (n: number) => '00000000-0000-7000-8000-' + String(n).padStart(12, '0');

/**
 * Contract rehearsal only, deliberately skipped until C1.6 merges. Replace this factory with a real
 * PostgreSQL fixture before enabling; assertions on effects must then read durable jobs/audits.
 * The fake is the frozen reference, not evidence that invoice transitions are implemented.
 */
function fixture(kind: InvoiceSnapshot['kind'] = 'cycle') {
  const clock = new TestClock('2028-03-01T20:00:00Z');
  const context = { gymId: id(1), actor: { kind: 'system' as const } };
  const invoice: InvoiceSnapshot = { id: id(2), householdId: id(3), number: 1, kind,
    status: 'open', amountCents: 10_000, currency: 'CAD', paidAt: null };
  const fake = new FakeInvoiceTransitions([{ gymId: context.gymId, invoice }], [
    { gymId: context.gymId, invoiceId: invoice.id, id: id(4), number: 1, paymentIntentId: 'pi_first', status: 'pending' },
  ]);
  const transitions: InvoiceTransitions = fake;
  const success: CardSuccess = { invoiceId: invoice.id, attemptId: id(4), paymentId: id(5),
    paymentIntentId: 'pi_first', chargeId: 'ch_first', paidAt: clock.now().toISOString(), amountCents: 10_000, currency: 'CAD' };
  const failure: CardFailure = { invoiceId: invoice.id, attemptId: id(4), paymentIntentId: 'pi_first', outcome: 'failed' };
  return { clock, context, invoice, fake, transitions, success, failure };
}

describe.skip('C1.6 pending: invoice transition scenarios (replace frozen fake with PostgreSQL before enabling)', () => {
  it.each(['webhook first', 'runner first'] as const)('records one payment and one receipt when success is replayed: %s', async order => {
    const f = fixture();
    const deliveries = order === 'webhook first' ? ['webhook', 'runner'] : ['runner', 'webhook'];
    for (const [index] of deliveries.entries()) {
      expect((await f.transitions.cardSucceeded(f.context, f.success)).outcome).toBe(index === 0 ? 'applied' : 'ignored');
    }
    expect(f.fake.payments).toHaveLength(1);
    expect(f.fake.effects.filter(effect => effect.kind === 'receipt')).toHaveLength(1);
    expect(f.fake.effects.filter(effect => effect.kind === 'activate_memberships')).toHaveLength(1);
    expect(f.fake.read(f.context.gymId, f.invoice.id)).toMatchObject({ status: 'paid', paidAt: f.success.paidAt });
  });

  it.each(['failed', 'requires_action'] as const)('deduplicates a cycle %s result and requests dunning once', async outcome => {
    const f = fixture(), failure: CardFailure = { ...f.failure, outcome };
    expect(await f.transitions.cardFailed(f.context, failure)).toMatchObject({ outcome: 'applied', invoice: { status: 'past_due' } });
    expect(await f.transitions.cardFailed(f.context, failure)).toMatchObject({ outcome: 'ignored' });
    expect(f.fake.effects.filter(effect => effect.kind === 'dunning')).toHaveLength(1);
    expect(f.fake.payments).toHaveLength(0);
  });

  it.each(['failed', 'requires_action'] as const)('leaves a one-off %s open and never requests dunning', async outcome => {
    const f = fixture('one_off');
    await f.transitions.cardFailed(f.context, { ...f.failure, outcome });
    f.clock.set('2028-03-15T20:00:00Z');
    await f.transitions.cardFailed(f.context, { ...f.failure, outcome });
    expect(f.fake.read(f.context.gymId, f.invoice.id).status).toBe('open');
    expect(f.fake.effects).toEqual([]);
  });

  it.each(['failed', 'requires_action', 'canceled'] as const)('never un-pays a paid invoice after a late %s for the same attempt', async outcome => {
    const f = fixture();
    await f.transitions.cardSucceeded(f.context, f.success);
    f.clock.set('2028-03-15T19:00:00Z');
    expect(await f.transitions.cardFailed(f.context, { ...f.failure, outcome })).toMatchObject({ outcome: 'ignored', invoice: { status: 'paid', paidAt: f.success.paidAt } });
    expect(f.fake.effects.some(effect => effect.kind === 'dunning')).toBe(false);
  });

  it('ignores an older attempt failure after a retry succeeds', async () => {
    const f = fixture();
    await f.transitions.cardFailed(f.context, f.failure);
    f.clock.set('2028-03-04T20:00:00Z');
    f.fake.seedAttempt({ gymId: f.context.gymId, invoiceId: f.invoice.id, id: id(6), number: 2,
      paymentIntentId: 'pi_retry', status: 'pending' });
    await f.transitions.cardSucceeded(f.context, { ...f.success, attemptId: id(6), paymentId: id(7),
      paymentIntentId: 'pi_retry', chargeId: 'ch_retry', paidAt: f.clock.now().toISOString() });
    const effects = f.fake.effects;
    await f.transitions.cardFailed(f.context, f.failure);
    expect(f.fake.read(f.context.gymId, f.invoice.id).status).toBe('paid');
    expect(f.fake.effects).toEqual(effects);
  });

  it('applies a success after a failure without allowing failure replay to downgrade it', async () => {
    const f = fixture();
    await f.transitions.cardFailed(f.context, f.failure);
    await f.transitions.cardSucceeded(f.context, f.success);
    await f.transitions.cardFailed(f.context, f.failure);
    expect(f.fake.read(f.context.gymId, f.invoice.id).status).toBe('paid');
    expect(f.fake.payments).toHaveLength(1);
  });

  it('never resurrects an intent cancelled by reconciliation', async () => {
    const f = fixture();
    await f.transitions.cardFailed(f.context, { ...f.failure, outcome: 'canceled' });
    expect(await f.transitions.cardSucceeded(f.context, f.success)).toMatchObject({ outcome: 'ignored', invoice: { status: 'past_due' } });
    expect(f.fake.payments).toHaveLength(0);
  });

  it.each(['cash', 'check'] as const)('records %s once and refunds a late Checkout payment without paying twice', async method => {
    const f = fixture();
    const manual = { invoiceId: f.invoice.id, paymentId: id(8), amountCents: 10_000, currency: 'CAD',
      paidAt: f.clock.now().toISOString(), method };
    await f.transitions.manualPayment(f.context, manual);
    expect((await f.transitions.manualPayment(f.context, manual)).outcome).toBe('ignored');
    const checkoutSuccess: CardSuccess = { invoiceId: f.invoice.id, paymentId: f.success.paymentId,
      paymentIntentId: f.success.paymentIntentId, chargeId: f.success.chargeId, paidAt: f.success.paidAt,
      amountCents: f.success.amountCents, currency: f.success.currency };
    expect(await f.transitions.cardSucceeded(f.context, checkoutSuccess)).toMatchObject({ outcome: 'duplicate_payment', invoice: { status: 'paid' } });
    await f.transitions.cardSucceeded(f.context, checkoutSuccess);
    expect(f.fake.payments.filter(payment => payment.accepted)).toHaveLength(1);
    expect(f.fake.effects.filter(effect => effect.kind === 'refund_duplicate')).toHaveLength(1);
    expect(f.fake.effects.filter(effect => effect.kind === 'staff_notice')).toHaveLength(1);
  });

  it('reserves a pending refund, applies partial then full success once, and ignores late failure snapshots', async () => {
    const f = fixture();
    await f.transitions.cardSucceeded(f.context, f.success);
    const partial: RefundTransition = { invoiceId: f.invoice.id, paymentId: f.success.paymentId,
      refundId: id(9), processorId: 're_partial', amountCents: 3000, currency: 'CAD', status: 'pending' };
    expect((await f.transitions.refund(f.context, partial)).invoice.status).toBe('paid');
    expect((await f.transitions.refund(f.context, { ...partial, status: 'succeeded' })).invoice.status).toBe('partially_refunded');
    expect((await f.transitions.refund(f.context, { ...partial, status: 'succeeded' })).outcome).toBe('ignored');
    const rest: RefundTransition = { ...partial, refundId: id(10), processorId: 're_rest', amountCents: 7000, status: 'succeeded' };
    expect((await f.transitions.refund(f.context, rest)).invoice.status).toBe('refunded');
    await f.transitions.refund(f.context, { ...rest, status: 'failed' });
    await f.transitions.cardFailed(f.context, f.failure);
    expect(f.fake.read(f.context.gymId, f.invoice.id).status).toBe('refunded');
  });

  it('a failed refund leaves a paid invoice paid and releases the amount for another refund', async () => {
    const f = fixture();
    await f.transitions.cardSucceeded(f.context, f.success);
    const request: RefundTransition = { invoiceId: f.invoice.id, paymentId: f.success.paymentId,
      refundId: id(9), amountCents: 10_000, currency: 'CAD', status: 'pending' };
    await f.transitions.refund(f.context, request);
    await expect(f.transitions.refund(f.context, { ...request, refundId: id(10), amountCents: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.transitions.refund(f.context, { ...request, status: 'failed' })).invoice.status).toBe('paid');
    expect((await f.transitions.refund(f.context, { ...request, refundId: id(10), status: 'succeeded' })).invoice.status).toBe('refunded');
  });
});

// These paths have no frozen orchestration entry point yet. TODO(CCR): use the real runner, inbox,
// handlers and observable jobs after the dependency merges; do not implement them in this test suite.
describe('pending billing workflows: dependency and acceptance recorded in each title', () => {
  it.todo('[C1.6/C2.2] completed payment Checkout activates only its pending invoice memberships once; setup or abandoned Checkout never activates');
  it.todo('[C1.5/C2.2/C2.1] deliver a signed success webhook before confirm returns; replay event ID and runner result leave one durable payment, receipt and activation');
  it.todo('[C1.5/C2.2/C2.1] deliver success after the runner result; replay through the durable inbox leaves one payment and one receipt');
  it.todo('[C1.5/C2.2] reject invalid signatures before inbox insertion; repeated event ID enqueues one processor job');
  it.todo('[C1.6/C2.1] decline on March 1 schedules retries on March 4 and 8 (days 3 and 7), never 3/7 days after the previous retry');
  it.todo('[C1.6/C2.1] advance clock just before and at each retry deadline: no early attempt, exactly one due attempt, replay creates none');
  it.todo('[C1.6/C2.1] both retries decline: each failure sends one dunning mail, invoice remains past_due after day 7 and no third retry is scheduled');
  it.todo('[C1.6/C2.1] day-3 retry succeeds: day-7 job is a no-op, invoice stays paid and late failure never reopens it');
  it.todo('[C1.6/C2.1/C2.4] authentication_required (thrown, last_payment_error or requires_action) sends a signed action link and follows the same retry calendar');
  it.todo('[C2.1/C2.3] one-off decline or SCA stays open; clock advances beyond day 7 without a retry job or dunning email');
  it.todo('[C2.1/C2.4] expire an open pay session before retry; already-completed or uncertain expiration reconciles instead of charging again');
  it.todo('[C2.1/C2.4] pay link succeeds during the retry window, cancels later charging and produces one receipt');
  it.todo('[C2.1] persist pending attempt before create and compare-and-set the intent ID before confirm; delayed create loses to reconciliation and is cancelled');
  it.todo('[C2.1] delayed confirm races cancellation; reconcile by ID to at most one charge and the final processor state');
  it.todo('[C2.1] crash after processor success before local record; after 24 hours reconcile saved intent, never create a second charge');
  it.todo('[C2.1] concurrent or repeated daily runs issue one invoice per household/due date and advance each membership once');
  it.todo('[C2.1] downtime catches up exact due dates oldest first; seven-day-old periods charge and eight-day-old periods wait for staff review');
  it.todo('[C2.1] billing disabled prevents every create/confirm, retry and catch-up charge');
  it.todo('[C1.8/C2.1] persisted imported Feb-29 anniversary differing from startsOn survives Feb-28 renewals and returns to Feb-29 in 2032');
  it.todo('[C2.5/C2.1] imported annual renewal and monthly due dates survive first run, adopting the imported customer before charging');
  it.todo('[C2.2/C2.3] a dashboard refund without invoice metadata resolves through its payment; pending/failed refund never marks paid invoice refunded');
  it.todo('[C2.1/C2.2] restore keeps billing disabled while post-snapshot success, refund and dispute are reconciled through their payment IDs');
  it.todo('[C2.3] front desk records cash but cannot refund; foreign gym and foreign household cannot read or mutate the invoice');
});
