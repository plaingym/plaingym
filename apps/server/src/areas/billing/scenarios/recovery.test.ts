// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { clearJobs, workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

describe('runner recovery and collection exclusion', () => {
  it('commits the pending request before create and saves the intent before confirm', async () => {
    const f = await workflowFixture(db), create = f.provider.createCharge.bind(f.provider), confirm = f.provider.confirmCharge.bind(f.provider);
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
      expect((await f.read()).attempts).toMatchObject([{ status: 'pending', paymentIntentId: null,
        amountCents: request.amount, savedPaymentMethod: request.paymentMethodId, stripeCustomerId: request.customerId }]);
      return create(request);
    });
    vi.spyOn(f.provider, 'confirmCharge').mockImplementationOnce(async (id, options) => {
      expect((await f.read()).attempts).toMatchObject([{ paymentIntentId: id, status: 'pending' }]);
      return confirm(id, options);
    });
    await f.runJob('billing.runner.daily'); expect((await f.read()).payments).toHaveLength(1);
  });

  it('a delayed create loses its compare-and-set to reconciliation and cancels without confirming', async () => {
    const f = await workflowFixture(db), create = f.provider.createCharge.bind(f.provider), confirm = vi.spyOn(f.provider, 'confirmCharge');
    let lateIntent = '';
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
      f.clock.advance(16 * 60_000); await f.runJob('billing.runner.reconcile');
      const result = await create(request); lateIntent = result.id; return result;
    });
    await f.runner.daily(f.gymId); await f.drain();
    expect(confirm).not.toHaveBeenCalled(); expect(f.transport.objects.get(lateIntent)!.status).toBe('canceled');
    expect((await f.read()).attempts[0]!.declineCode).toBe('create_abandoned');
    await f.runJob('billing.runner.daily'); expect((await f.read()).payments).toHaveLength(1);
  });

  it.each(['cancel', 'confirm'] as const)('delayed confirm races reconciliation: %s wins with at most one charge', async winner => {
    const f = await workflowFixture(db), confirm = f.provider.confirmCharge.bind(f.provider);
    vi.spyOn(f.provider, 'confirmCharge').mockImplementationOnce(async (id, options) => {
      const result = winner === 'confirm' ? await confirm(id, options) : undefined;
      f.clock.advance(16 * 60_000); await f.runJob('billing.runner.reconcile');
      return result ?? confirm(id, options);
    });
    await f.runner.daily(f.gymId); await f.drain();
    const state = await f.read();
    expect(state.attempts).toHaveLength(1); expect(state.payments).toHaveLength(winner === 'confirm' ? 1 : 0);
    expect(state.attempts[0]!.status).toBe(winner === 'confirm' ? 'succeeded' : 'failed');
    expect(f.email.messages).toHaveLength(1);
  });

  it.each([false, true])('crash after processor success reconciles by saved ID after 25 hours (unknown first: %s)', async unknown => {
    const f = await workflowFixture(db), confirm = f.provider.confirmCharge.bind(f.provider);
    vi.spyOn(f.provider, 'confirmCharge').mockImplementationOnce(async (id, options) => {
      await confirm(id, options); throw new Error('Process lost the confirmation response');
    });
    expect((await f.runner.daily(f.gymId)).errors).toHaveLength(1);
    const attempt = (await f.read()).attempts[0]!;
    expect(attempt).toMatchObject({ status: 'pending' }); expect(attempt.paymentIntentId).toBeTruthy();
    f.clock.advance(25 * 60 * 60_000);
    const create = vi.spyOn(f.provider, 'createCharge'), find = vi.spyOn(f.provider, 'findCharge');
    if (unknown) {
      find.mockResolvedValueOnce({ status: 'unknown', reference: { kind: 'charge', id: attempt.paymentIntentId! } });
      expect((await f.runner.reconcile(f.gymId)).issues).toHaveLength(1);
      await f.runner.daily(f.gymId); expect((await f.read()).payments).toEqual([]);
    }
    await f.runJob('billing.runner.reconcile'); await f.runJob('billing.runner.daily');
    const state = await f.read();
    expect(create).not.toHaveBeenCalled(); expect(state.payments).toHaveLength(1); expect(state.attempts).toHaveLength(1);
    expect(state.payments[0]!.paidAt.toISOString()).toBe('2028-03-01T17:00:00.000Z');
    expect(find).toHaveBeenCalledWith({ kind: 'charge', id: attempt.paymentIntentId }, { includeSuccessTime: true });
    expect(f.email.messages).toHaveLength(1);
  });

  it('concurrent and repeated daily runs issue one invoice per due date and advance once', async () => {
    const f = await workflowFixture(db);
    const results = await Promise.all([f.runner.daily(f.gymId), f.runner.daily(f.gymId)]);
    expect(results.flatMap(r => r.errors)).toEqual([]); await f.drain(); await f.runJob('billing.runner.daily');
    const state = await f.read();
    expect(state.invoices).toHaveLength(1); expect(state.attempts).toHaveLength(1); expect(state.payments).toHaveLength(1);
    expect(state.memberships[0]!.nextDueOn).toBe('2028-04-01'); expect(f.email.messages).toHaveLength(1);
  });

  it.each([7, 8])('missed-run catch-up orders exact periods oldest first and holds periods %s days old correctly', async days => {
    const f = await workflowFixture(db, { now: `2028-03-0${days + 1}T17:00:00Z`, dueOn: '2028-01-01' });
    await f.runJob('billing.runner.daily');
    const state = await f.read();
    // createdAt uses the frozen TestClock; UUIDv7 is random within a millisecond.
    // Numbers are allocated transactionally when each invoice is issued, independently of dueOn.
    expect(state.invoices.map(i => i.createdAt)).toEqual([f.clock.now(), f.clock.now(), f.clock.now()]);
    expect(state.invoices.toSorted((a, b) => a.number! - b.number!).map(i => i.dueOn))
      .toEqual(['2028-01-01', '2028-02-01', '2028-03-01']);
    expect(state.invoices.map(i => i.dueOn)).toEqual(['2028-01-01', '2028-02-01', '2028-03-01']);
    expect(state.invoices.map(i => i.needsReview)).toEqual([true, true, days === 8]);
    expect(state.payments).toHaveLength(days === 7 ? 1 : 0);
    expect(state.memberships[0]!.nextDueOn).toBe('2028-04-01');
    await f.runJob('billing.runner.daily'); expect((await f.read()).invoices).toHaveLength(3);
  });

  it('billing disabled prevents daily, catch-up, retry and staff create/confirm calls', async () => {
    const f = await workflowFixture(db, { card: 'pm_0341' }); await f.runJob('billing.runner.daily');
    const bill = (await f.read()).invoices[0]!; await f.enable(false);
    const create = vi.spyOn(f.provider, 'createCharge'), confirm = vi.spyOn(f.provider, 'confirmCharge');
    f.clock.set('2028-04-09T16:00:00Z'); await f.drain(); await f.runJob('billing.runner.daily');
    await f.runJob('billing.runner.retry', { invoiceId: bill.id });
    await expect(f.service.charge(f.context, bill.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(create).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect((await f.read()).invoices).toHaveLength(1); expect((await f.read()).attempts).toHaveLength(1);
  });
});
