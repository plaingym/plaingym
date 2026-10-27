// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { uuidv7 } from '@plaingym/db';
import { zonedInstant } from '@plaingym/shared/time';
import { createSettingsService } from '../../settings/settings.js';
import { clearJobs, workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();
beforeEach(() => clearJobs(db));

describe('billing workflows through services, signed webhooks and PostgreSQL jobs', () => {
  it('completed first Checkout activates only its invoice memberships once, then charge, fail, retry and pay link succeed', async () => {
    const f = await workflowFixture(db, { empty: true });
    const assigned = await f.lifecycle.assign(f.context, { id: uuidv7(), householdId: f.home.id, memberId: f.member.id,
      planId: f.plan.id, startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' });
    const sibling = await f.factory('members', f.gymId, { householdId: f.home.id });
    const unrelated = await f.factory('memberships', f.gymId, { householdId: f.home.id, memberId: sibling.id,
      planId: f.plan.id, status: 'pending', startsOn: '2028-03-01', nextDueOn: '2028-04-01' });
    const bill = (await f.read()).invoices[0]!, pay = await f.payLink(bill.id);
    await f.drain();
    expect((await f.lifecycle.get(f.gymId, assigned.id)).status).toBe('pending'); // Abandoned Checkout cannot activate.
    const setup = await f.links.create(f.context, { purpose: 'update_card', householdId: f.home.id, expiresAt: '2029-01-01T00:00:00Z' });
    const setupSession = await f.checkout.start(f.gymId, setup.link.id);
    f.transport.completeCheckout(setupSession.session.id);
    await f.deliver('checkout.session.completed', setupSession.session.id); await f.drain();
    expect((await f.lifecycle.get(f.gymId, assigned.id)).status).toBe('pending');
    f.transport.completeCheckout(pay.session.id);
    const event = await f.deliver('checkout.session.completed', pay.session.id); await f.drain();
    await f.deliver('checkout.session.completed', pay.session.id, event); await f.drain();
    expect((await f.lifecycle.get(f.gymId, assigned.id)).status).toBe('active');
    expect((await f.lifecycle.get(f.gymId, unrelated.id)).status).toBe('pending');
    expect((await f.read()).audits.filter(a => a.action === 'billing.membership.activated')).toHaveLength(1);
    f.clock.set('2028-04-01T16:00:00Z'); await f.runJob('billing.runner.daily');
    expect((await f.read()).payments).toHaveLength(2);
    await f.setCard('pm_0341'); f.clock.set('2028-05-01T16:00:00Z'); await f.runJob('billing.runner.daily');
    f.clock.set('2028-05-04T16:00:00Z'); await f.drain();
    const due = (await f.read()).invoices.find(i => i.dueOn === '2028-05-01')!;
    expect((await f.read()).attempts.filter(a => a.invoiceId === due.id)).toHaveLength(2);
    const recovery = await f.payLink(due.id); f.transport.completeCheckout(recovery.session.id);
    await f.deliver('checkout.session.completed', recovery.session.id); await f.drain();
    const emailsAfterSuccess = f.email.messages.length;
    const day7 = zonedInstant('2028-05-08', '09:00', f.timezone, { gap: 'shift' })!;
    const beforeRetry = await f.read();
    const effect = beforeRetry.audits.find(a => a.action === 'billing.transition.effect.created'
      && (a.after as { kind?: string; invoiceId?: string; retryDay?: number })?.kind === 'retry'
      && (a.after as { invoiceId?: string })?.invoiceId === due.id
      && (a.after as { retryDay?: number })?.retryDay === 7);
    expect(effect).toBeDefined();
    const retry = beforeRetry.jobs.filter(j => j.name === 'billing.transitions.effect'
      && (j.payload as { value: { effectId?: string } }).value.effectId === effect!.targetId);
    expect(retry).toMatchObject([{ status: 'pending', attempts: 0, runAt: day7,
      payload: { value: { effectId: effect!.targetId } } }]);
    f.clock.set('2028-05-08T16:00:00Z'); await f.drain();
    const afterRetry = await f.read();
    expect(afterRetry.attempts.filter(a => a.invoiceId === due.id)).toHaveLength(2);
    expect(f.email.messages.slice(emailsAfterSuccess), 'No dunning email after pay-link success').toEqual([]);
    expect(afterRetry.jobs.find(j => j.id === retry[0]!.id)).toMatchObject({ status: 'succeeded', attempts: 1, lastError: null });
    expect((await f.service.getInvoice(f.gymId, due.id)).invoice.status).toBe('paid');
    expect((await f.read()).payments).toHaveLength(3);
    expect(f.email.messages.filter(m => m.subject.startsWith('Receipt'))).toHaveLength(3);
  });

  it.each(['before', 'after'] as const)('signed success webhook %s the runner result and replay leave one payment and receipt', async order => {
    const f = await workflowFixture(db, { empty: true }), confirm = f.provider.confirmCharge.bind(f.provider);
    const assigned = await f.lifecycle.assign(f.context, { id: uuidv7(), householdId: f.home.id, memberId: f.member.id,
      planId: f.plan.id, startsOn: '2028-03-01', nextDueOn: '2028-04-01', firstPeriod: 'prorate_now' });
    let event = '', intent = '';
    vi.spyOn(f.provider, 'confirmCharge').mockImplementationOnce(async (id, options) => {
      intent = id;
      const result = await confirm(id, options);
      if (order === 'before') { event = await f.deliver('payment_intent.succeeded', id); await f.drain(); }
      return result;
    });
    await f.runner.collectAssigned(f.gymId, f.home.id); await f.drain();
    if (order === 'after') { event = await f.deliver('payment_intent.succeeded', intent); await f.drain(); }
    await f.deliver('payment_intent.succeeded', intent, event); await f.drain();
    await f.inbox.replay(f.gymId, event); await f.drain();
    const state = await f.read();
    expect(state.payments).toHaveLength(1); expect(state.attempts).toMatchObject([{ status: 'succeeded' }]);
    expect(state.events).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
    expect(state.audits.filter(a => a.action === 'billing.invoice.paid')).toHaveLength(1);
    expect((await f.lifecycle.get(f.gymId, assigned.id)).status).toBe('active');
    expect(state.audits.filter(a => a.action === 'billing.membership.activated')).toHaveLength(1);
  });

  it('March 1 decline retries exactly March 4 and 8 at 09:00, never early, on replay, or after exhaustion', async () => {
    const f = await workflowFixture(db, { card: 'pm_0341' }); await f.runJob('billing.runner.daily');
    const bill = (await f.read()).invoices[0]!;
    const day3 = zonedInstant('2028-03-04', '09:00', f.timezone, { gap: 'shift' })!;
    const day7 = zonedInstant('2028-03-08', '09:00', f.timezone, { gap: 'shift' })!;
    expect((await f.read()).jobs.filter(j => j.status === 'pending').map(j => j.runAt.toISOString()).sort())
      .toEqual([day3.toISOString(), day7.toISOString()]);
    for (const [time, attempts] of [[new Date(day3.getTime() - 1), 1], [day3, 2],
      [new Date(day7.getTime() - 1), 2], [day7, 3], [new Date('2028-03-15T16:00:00Z'), 3]] as const) {
      f.clock.set(time); await f.drain();
      await f.runJob('billing.runner.retry', { invoiceId: bill.id });
      expect((await f.read()).attempts).toHaveLength(attempts);
      expect(f.email.messages).toHaveLength(attempts);
    }
    expect((await f.read()).invoices[0]!.status).toBe('past_due');
    expect((await f.read()).jobs.every(j => j.status === 'succeeded')).toBe(true);
  });

  it('day-3 success cancels day-7 charging and a late failure webhook cannot reopen the invoice', async () => {
    const f = await workflowFixture(db, { card: 'pm_0341' }); await f.runJob('billing.runner.daily');
    const old = (await f.read()).attempts[0]!.paymentIntentId!;
    await f.setCard('pm_4242'); f.clock.set('2028-03-04T17:00:00Z'); await f.drain();
    await f.deliver('payment_intent.payment_failed', old); await f.drain();
    f.clock.set('2028-03-08T17:00:00Z'); await f.drain();
    const state = await f.read();
    expect(state.invoices[0]!.status).toBe('paid'); expect(state.attempts).toHaveLength(2);
    expect(state.payments).toHaveLength(1); expect(f.email.messages).toHaveLength(2);
  });

  it('edited retry schedule preserves existing dunning and applies only to the next first failure', async () => {
    const f = await workflowFixture(db, { card: 'pm_0341' }); await f.runJob('billing.runner.daily');
    const settings = createSettingsService(f.common), gym = await settings.get(f.gymId);
    await settings.update(f.context, 'billing', { revision: gym.revision, retryDays: [2, 5] });
    f.clock.set('2028-03-03T17:00:00Z'); await f.drain(); expect((await f.read()).attempts).toHaveLength(1);
    f.clock.set('2028-03-04T17:00:00Z'); await f.drain(); expect((await f.read()).attempts).toHaveLength(2);
    f.clock.set('2028-03-08T17:00:00Z'); await f.drain(); expect((await f.read()).attempts).toHaveLength(3);
    f.clock.set('2028-04-01T16:00:00Z'); await f.runJob('billing.runner.daily');
    expect((await f.read()).jobs.filter(j => j.status === 'pending').map(j => j.runAt.toISOString()).sort())
      .toEqual(['2028-04-03T16:00:00.000Z', '2028-04-06T16:00:00.000Z']);
  });

  it.each(['thrown', 'last_payment_error', 'requires_action'])('SCA %s creates a signed action link and uses the retry calendar', async shape => {
    const f = await workflowFixture(db, { card: 'pm_3184' });
    if (shape !== 'thrown') {
      const request = f.transport.request.bind(f.transport);
      vi.spyOn(f.transport, 'request').mockImplementation(async input => {
        if (!input.path.endsWith('/confirm')) return request(input);
        const id = input.path.split('/')[3]!, object = f.transport.objects.get(id)!;
        Object.assign(object, shape === 'requires_action' ? { status: 'requires_action' }
          : { status: 'requires_payment_method', last_payment_error: { code: 'authentication_required' } });
        return structuredClone(object);
      });
    }
    await f.runJob('billing.runner.daily');
    const state = await f.read(); expect(state.attempts[0]!.status).toBe('requires_action');
    expect(f.email.messages[0]!.subject).toContain('Authentication needed');
    const token = f.email.messages[0]!.text.match(/\/l\/([\w-]+)/)![1]!;
    expect(await f.links.resolve(f.gymId, token)).toMatchObject({ status: 'active', principal: { householdId: f.home.id } });
    expect(state.jobs.filter(j => j.status === 'pending').map(j => j.runAt.toISOString()).sort())
      .toEqual(['2028-03-04', '2028-03-08'].map(date => zonedInstant(date, '09:00', f.timezone, { gap: 'shift' })!.toISOString()));
    const link = state.links[0]!, checkout = await f.checkout.start(f.gymId, link.id);
    f.transport.completeCheckout(checkout.session.id); await f.deliver('checkout.session.completed', checkout.session.id); await f.drain();
    f.clock.set('2028-03-08T17:00:00Z'); await f.drain();
    expect((await f.read()).invoices[0]!.status).toBe('paid'); expect((await f.read()).attempts).toHaveLength(1);
  });

  it.each(['pm_0341', 'pm_3184'])('one-off %s remains open without dunning or retries after day 7', async card => {
    const f = await workflowFixture(db, { empty: true, card });
    const bill = await f.service.createOneOff(f.context, { source: 'custom', householdId: f.home.id, dueOn: '2028-03-01',
      description: 'Private lesson', amountCents: 10000, currency: 'USD' });
    await f.service.charge(f.context, bill.id); await f.drain();
    f.clock.set('2028-03-15T16:00:00Z'); await f.runJob('billing.runner.daily');
    expect((await f.read()).invoices[0]!.status).toBe('open'); expect((await f.read()).attempts).toHaveLength(1);
    expect(f.email.messages).toEqual([]); expect((await f.read()).jobs.filter(j => j.status === 'pending')).toEqual([]);
  });

  it('one-off card collection succeeds once and webhook replay does not duplicate its receipt', async () => {
    const f = await workflowFixture(db, { empty: true });
    const bill = await f.service.createOneOff(f.context, { source: 'custom', householdId: f.home.id, dueOn: '2028-03-01',
      description: 'Private lesson', amountCents: 2500, currency: 'USD' });
    await f.service.charge(f.context, bill.id); await f.drain();
    const intent = (await f.read()).attempts[0]!.paymentIntentId!;
    await f.deliver('payment_intent.succeeded', intent); await f.drain();
    expect((await f.read()).invoices).toMatchObject([{ kind: 'one_off', status: 'paid', amountCents: 2500 }]);
    expect((await f.read()).payments).toHaveLength(1); expect(f.email.messages).toHaveLength(1);
  });

  it.each(['open', 'completed', 'uncertain'] as const)('retry resolves an %s pay session before creating another charge', async state => {
    const f = await workflowFixture(db, { card: 'pm_0341' }); await f.runJob('billing.runner.daily');
    const pay = await f.payLink((await f.read()).invoices[0]!.id);
    if (state === 'completed') f.transport.completeCheckout(pay.session.id);
    const expire = vi.spyOn(f.provider, 'expireCheckout');
    if (state === 'uncertain') expire.mockResolvedValue({ status: 'uncertain' });
    await f.setCard('pm_4242'); f.clock.set('2028-03-04T17:00:00Z');
    const create = vi.spyOn(f.provider, 'createCharge');
    if (state === 'uncertain') {
      await expect(f.runner.charge(f.gymId, pay.link.invoiceId!, { mode: 'retry' }))
        .rejects.toThrow('Checkout must be reconciled before collecting payment');
      expect(create).not.toHaveBeenCalled(); expect((await f.read()).payments).toEqual([]);
      expire.mockRestore(); f.transport.completeCheckout(pay.session.id);
      await f.deliver('checkout.session.completed', pay.session.id); await f.drain();
      expect(create).not.toHaveBeenCalled(); expect((await f.read()).payments).toHaveLength(1);
      return;
    }
    await f.drain();
    expect(create).toHaveBeenCalledTimes(state === 'open' ? 1 : 0);
    expect(f.transport.objects.get(pay.session.id)!.status).toBe(state === 'open' ? 'expired' : 'complete');
    expect((await f.read()).payments).toHaveLength(1);
    expect(f.email.messages.filter(m => m.subject.startsWith('Receipt'))).toHaveLength(1);
  });
});
