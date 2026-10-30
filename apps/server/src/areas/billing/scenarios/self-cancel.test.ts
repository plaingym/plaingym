// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { paymentMethods } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createBillingStanding } from '../kiosk-standing.js';
import { effectCreated, type TransitionEffect } from '../transitions/store.js';
import { clearJobs, workflowFixture, type Workflow } from './workflow-fixture.js';

const db = useTestDatabase(), standing = createBillingStanding(db.forGym);
beforeEach(() => clearJobs(db));

type Path = 'card removed after create' | 'billing paused mid-charge' | 'confirm never reached Stripe';
/** Starts the March 1 daily run and makes the runner (or the hourly reconcile) cancel its own unconfirmed intent. */
async function selfCancel(f: Workflow, path: Path) {
  const create = f.provider.createCharge.bind(f.provider);
  if (path === 'card removed after create') vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
    const intent = await create(request);
    await f.db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ revokedAt: f.clock.now(), isDefault: false })
      .where(eq(paymentMethods.householdId, f.home.id)));
    return intent;
  });
  if (path === 'billing paused mid-charge') vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
    const intent = await create(request);
    await f.enable(false);
    return intent;
  });
  if (path === 'confirm never reached Stripe') vi.spyOn(f.provider, 'confirmCharge')
    .mockRejectedValueOnce(new Error('Network error before the request was sent'));
  const run = await f.runner.daily(f.gymId);
  if (path === 'confirm never reached Stripe') {
    expect(run.errors).toHaveLength(1);
    expect((await f.read()).attempts).toMatchObject([{ status: 'pending' }]);
    f.clock.advance(16 * 60_000); await f.runJob('billing.runner.reconcile');
  } else expect(run).toMatchObject({ attempted: 0, errors: [] });
  await f.drain();
  const intentId = (await f.read()).attempts[0]!.paymentIntentId!;
  expect(f.transport.objects.get(intentId)!.status).toBe('canceled');
  return intentId;
}
const effects = (state: Awaited<ReturnType<Workflow['read']>>) =>
  state.audits.filter(row => row.action === effectCreated).map(row => (row.after as TransitionEffect).kind);

describe('the runner cancelling its own unconfirmed charge', () => {
  it.each(['card removed after create', 'billing paused mid-charge', 'confirm never reached Stripe'] as const)(
    '%s: the invoice stays open without dunning, and the next daily run charges it', async path => {
      const f = await workflowFixture(db);
      const intentId = await selfCancel(f, path);
      const state = await f.read();
      expect(state.invoices).toMatchObject([{ kind: 'cycle', status: 'open', dueOn: '2028-03-01' }]);
      expect(state.attempts).toMatchObject([{ status: 'failed', declineCode: 'confirm_abandoned', paymentIntentId: intentId }]);
      expect(state.audits.some(row => row.action === 'billing.invoice.dunning_started' || row.action === 'billing.invoice.payment_failed'))
        .toBe(false);
      expect(effects(state)).toEqual([]);
      expect(state.jobs.filter(job => job.status === 'pending')).toEqual([]);
      expect(f.email.messages).toEqual([]);
      expect(await standing.check({ gymId: f.gymId, memberId: f.member.id, clock: f.clock })).toEqual({ status: 'ok' });

      if (path === 'card removed after create') await f.setCard('pm_3155');
      if (path === 'billing paused mid-charge') await f.enable(true);
      f.clock.set('2028-03-02T17:00:00Z'); await f.runJob('billing.runner.daily');
      const after = await f.read();
      expect(after.invoices).toMatchObject([{ status: 'paid' }]);
      expect(after.attempts.map(row => row.status)).toEqual(['failed', 'succeeded']);
      expect(after.payments).toHaveLength(1);
      expect(effects(after).sort()).toEqual(['activate_memberships', 'receipt']);
      expect(f.email.messages).toMatchObject([{ to: 'payer@example.invalid', subject: expect.stringContaining('Receipt') }]);
      expect(await standing.check({ gymId: f.gymId, memberId: f.member.id, clock: f.clock })).toEqual({ status: 'ok' });
    });

  it('a cancelled retry leaves the schedule alone, and the next retry day collects the invoice', async () => {
    const f = await workflowFixture(db, { card: 'pm_0341' }); await f.runJob('billing.runner.daily');
    expect((await f.read()).invoices[0]!.status).toBe('past_due');
    await f.setCard('pm_4242');
    const create = f.provider.createCharge.bind(f.provider);
    vi.spyOn(f.provider, 'createCharge').mockImplementationOnce(async request => {
      const intent = await create(request);
      await f.db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ revokedAt: f.clock.now(), isDefault: false })
        .where(eq(paymentMethods.processorId, 'pm_4242')));
      return intent;
    });
    f.clock.set('2028-03-04T17:00:00Z'); await f.drain();
    let state = await f.read();
    expect(state.attempts.map(row => row.declineCode)).toEqual([null, 'confirm_abandoned']);
    expect(state.invoices[0]!.status).toBe('past_due');
    expect(f.email.messages).toHaveLength(1);
    await f.setCard('pm_3155');
    f.clock.set('2028-03-08T17:00:00Z'); await f.drain();
    state = await f.read();
    expect(state.invoices[0]!.status).toBe('paid');
    expect(state.attempts.map(row => row.status)).toEqual(['failed', 'failed', 'succeeded']);
    expect(effects(state).filter(kind => kind === 'dunning')).toHaveLength(1);
  });

  it('cancelling an action-needed charge before a retry is still a decline, and daily runs leave it to the retry days', async () => {
    const f = await workflowFixture(db, { card: 'pm_3184' }); await f.runJob('billing.runner.daily');
    const [first] = (await f.read()).attempts;
    expect(first).toMatchObject({ status: 'requires_action', declineCode: 'authentication_required' });
    expect(effects(await f.read()).filter(kind => kind === 'dunning')).toHaveLength(1);
    const charges = vi.spyOn(f.provider, 'createCharge');
    f.clock.set('2028-03-02T17:00:00Z'); await f.runJob('billing.runner.daily');
    expect(charges).not.toHaveBeenCalled();
    // The day 3 retry cancels the action-needed intent before charging again.
    f.clock.set('2028-03-04T17:00:00Z'); await f.drain();
    const state = await f.read();
    expect(f.transport.objects.get(first!.paymentIntentId!)!.status).toBe('canceled');
    expect(state.attempts).toMatchObject([{ id: first!.id, status: 'failed', declineCode: 'intent_canceled' },
      { attemptNumber: 2, status: 'requires_action' }]);
    expect(state.invoices[0]!.status).toBe('past_due');
    // The cancellation records a failure of its own (its email is suppressed for the newer attempt).
    expect(state.audits.filter(row => row.action === 'billing.attempt.resolved' && row.targetId === first!.id)
      .map(row => row.after)).toContainEqual({ status: 'failed', declineCode: 'intent_canceled' });
    expect(effects(state).filter(kind => kind === 'dunning')).toHaveLength(3);
    expect(effects(state).filter(kind => kind === 'retry')).toHaveLength(2);
  });
});
