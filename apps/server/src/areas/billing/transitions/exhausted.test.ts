// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { countExhaustedEffects, createTransitionEffects, effectDismissed, effectJob, effectRecoveryDelayMs, effectRecoveryExhausted,
  effectRecoveryLimit, effectRetried, effectStaffRetried } from './effects.js';
import * as store from './store.js';
import { effectCompleted, effectCreated, type TransitionEffect } from './store.js';
import { useExhaustedFixture } from './exhausted.fixture.test-helper.js';

const { db, factory, fixture } = useExhaustedFixture();
it('lists exhausted work oldest first after queue retention, without exposing another gym', async () => {
  const f = await fixture(), foreign = await fixture(), first = await f.create();
  await foreign.create(); f.clock.advance(1000);
  const second = await f.create('staff_notice');
  await f.removeJobs();
  expect(await f.effects.exhaustedEffects(f.gymId)).toEqual([
    { effectId: first, invoiceId: f.bill.id, number: f.bill.number, kind: 'receipt', refund: null, exhaustedAt: '2028-03-01T17:00:00.000Z' },
    { effectId: second, invoiceId: f.bill.id, number: f.bill.number, kind: 'staff_notice', refund: null, exhaustedAt: '2028-03-01T17:00:01.000Z' },
  ]);
});
it.each([false, true])('retries old work once when its original job was deleted: %s', async deleted => {
  const f = await fixture(), id = await f.create(), [original] = await f.rows();
  if (deleted) await f.removeJobs();
  f.clock.advance(120 * 86_400_000);
  expect(await f.effects.retryEffect(f.context, id)).toEqual({ changed: true });
  expect(await f.effects.retryEffect(f.context, id)).toEqual({ changed: false });
  const rows = await f.rows();
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
  if (!deleted) expect(rows[0]!.id).toBe(original!.id);
  expect(await f.effects.exhaustedEffects(f.gymId)).toEqual([]);
  await f.drain();
  expect(f.options.notifications.receipt).toHaveBeenCalledTimes(1);
  await f.effects.run(id, f.jobContext);
  expect(f.options.notifications.receipt).toHaveBeenCalledTimes(1);
  await expect(f.effects.retryEffect(f.context, id)).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.audits(effectStaffRetried, id)).toMatchObject([{ actorKind: 'user', actorUserId: f.user.id }]);
});
it.each([false, true])('serializes two concurrent staff retries into one job and one audit, deleted: %s', async deleted => {
  const f = await fixture(), id = await f.create();
  if (deleted) await f.removeJobs();
  const results = await Promise.all([f.effects.retryEffect(f.context, id), f.effects.retryEffect(f.context, id)]);
  expect(results.filter(row => row.changed)).toHaveLength(1);
  expect(await f.rows()).toHaveLength(1); expect(await f.audits(effectStaffRetried, id)).toHaveLength(1);
  await f.drain(); expect(f.options.notifications.receipt).toHaveBeenCalledTimes(1);
});
it('starts a new five-reset budget after each staff retry, then lists a new exhaustion', async () => {
  const f = await fixture(), id = await f.create();
  f.options.notifications.receipt.mockRejectedValue(new Error('Mail unavailable'));
  // Earlier recovery resets must not spend the staff retry's new budget.
  for (let n = 0; n < effectRecoveryLimit; n++) await f.audit(effectRetried, id);
  await f.effects.retryEffect(f.context, id); await f.drain();
  for (let n = 0; n < effectRecoveryLimit; n++) {
    f.clock.advance(effectRecoveryDelayMs * 2 ** n);
    expect(await createTransitionEffects(f.options).recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
    await f.drain();
  }
  expect(await f.effects.exhaustedEffects(f.gymId)).toEqual([]);
  expect(await f.effects.recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 1 });
  expect(await f.audits(effectRecoveryExhausted, id)).toHaveLength(2);
  expect(await f.effects.exhaustedEffects(f.gymId)).toMatchObject([{ effectId: id, exhaustedAt: f.clock.now().toISOString() }]);
  await f.effects.retryEffect(f.context, id); f.options.notifications.receipt.mockResolvedValue(); await f.drain();
  expect(await f.effects.exhaustedEffects(f.gymId)).toEqual([]);
});
it('closes the referenced exhaustion and counts resets even when the audit IDs sort out of order', async () => {
  const f = await fixture(), id = await f.create('receipt', {}, false);
  const exhaustedId = uuidv7(4_000_000_000_000);
  for (let n = 0; n < effectRecoveryLimit; n++)
    await factory('auditEvents', f.gymId, { id: uuidv7(4_000_000_000_000), action: effectRetried,
      targetId: id, occurredAt: f.clock.now() });
  await factory('auditEvents', f.gymId, { id: exhaustedId, action: effectRecoveryExhausted,
    targetId: id, occurredAt: f.clock.now() });
  expect(await countExhaustedEffects(f.gymId, db.forGym)).toBe(1);

  f.clock.advance(1);
  expect(await f.effects.retryEffect(f.context, id)).toEqual({ changed: true });
  const [staffRetry] = await f.audits(effectStaffRetried, id);
  expect(staffRetry!.id < exhaustedId).toBe(true);
  expect(staffRetry!.after).toMatchObject({ exhaustedId });
  expect(await f.effects.exhaustedEffects(f.gymId)).toEqual([]);
  expect(await countExhaustedEffects(f.gymId, db.forGym)).toBe(0);
  expect(await f.effects.retryEffect(f.context, id)).toEqual({ changed: false });
  await expect(f.effects.dismissEffect(f.context, id)).rejects.toMatchObject({ code: 'conflict' });

  f.clock.advance(effectRecoveryDelayMs);
  // Simulate the first reset from a worker whose UUID clock lags even the staff process.
  const earlierId = uuidv7(1_000_000_000_000);
  expect(earlierId < staffRetry!.id).toBe(true);
  await factory('auditEvents', f.gymId, { id: earlierId, action: effectRetried, targetId: id, occurredAt: f.clock.now() });
  f.options.notifications.receipt.mockRejectedValue(new Error('Mail unavailable'));
  await f.drain();
  const delayMs = effectRecoveryDelayMs * 2;
  f.clock.advance(delayMs - 1);
  expect(await f.effects.recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  f.clock.advance(1);
  expect(await f.effects.recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
  const resets = await f.audits(effectRetried, id);
  expect(resets).toHaveLength(effectRecoveryLimit + 2);
  expect(resets).toContainEqual(expect.objectContaining({ after: expect.objectContaining({ delayMs }) }));
  f.options.notifications.receipt.mockResolvedValue();
  await f.drain();
});
it('skips a failed job still inside its minimum backoff without locking or rereading it', async () => {
  const f = await fixture(), id = await f.create('receipt', {}, false);
  const lock = vi.spyOn(store, 'lockInvoice'), lookup = vi.spyOn(f.queue, 'failedJobs');
  try {
    f.clock.advance(effectRecoveryDelayMs - 1);
    expect(await f.effects.recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
    expect(lock).not.toHaveBeenCalled();
    expect(lookup.mock.calls).toEqual([[effectJob, [id], { gymId: f.gymId }]]);
    f.clock.advance(1);
    expect(await f.effects.recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls.filter(call => call[3])).toHaveLength(1);
  } finally {
    lock.mockRestore(); lookup.mockRestore();
  }
  await f.drain();
});
it('dismisses durably and only acknowledges the retained failed job', async () => {
  const f = await fixture(), id = await f.create(), before = await f.rows();
  f.clock.advance(1000);
  const acknowledged = [{ ...before[0]!, acknowledgedAt: f.clock.now() }];
  expect(await f.effects.dismissEffect(f.context, id)).toEqual({ changed: true });
  expect(await f.effects.exhaustedEffects(f.gymId)).toEqual([]);
  expect(await f.effects.recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(await f.rows()).toEqual(acknowledged);
  f.clock.advance(1000);
  await expect(f.effects.retryEffect(f.context, id)).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.effects.dismissEffect(f.context, id)).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.rows()).toEqual(acknowledged);
  expect(await f.audits(effectDismissed, id)).toMatchObject([{ actorKind: 'user', actorUserId: f.user.id,
    after: { invoiceId: f.bill.id, kind: 'receipt', reason: 'handled_by_hand' } }]);
  await f.effects.run(id, { gymId: f.gymId, timezone: 'UTC', clock: f.clock, jobId: before[0]!.id, attempt: 1 });
  expect(f.options.notifications.receipt).not.toHaveBeenCalled();
});
it('records dismissal after retention has removed the failed job', async () => {
  const f = await fixture(), id = await f.create();
  await f.removeJobs();
  expect(await f.effects.dismissEffect(f.context, id)).toEqual({ changed: true });
  expect(await f.rows()).toEqual([]);
  expect(await f.audits(effectDismissed, id)).toHaveLength(1);
});
it.each([false, true])('records dismissal without acknowledgment support, with recovery: %s', async hasRecovery => {
  const f = await fixture(), id = await f.create(), before = await f.rows();
  const { recovery: queue, ...options } = f.options;
  const recovery = hasRecovery ? {
    failedJobs: vi.fn(queue.failedJobs.bind(queue)),
    retryFailed: queue.retryFailed.bind(queue),
  } : undefined;
  const effects = createTransitionEffects(recovery ? { ...options, recovery } : options);
  expect(await effects.dismissEffect(f.context, id)).toEqual({ changed: true });
  if (recovery) expect(recovery.failedJobs).not.toHaveBeenCalled();
  expect(await f.rows()).toEqual(before);
  expect(await f.audits(effectDismissed, id)).toHaveLength(1);
});
it('rolls acknowledgment and the dismissal audit back together on a write failure', async () => {
  const f = await fixture(), id = await f.create(), before = await f.rows();
  const scope: typeof f.options.scope = (gymId, work) => f.options.scope(gymId, async tx => { await work(tx); throw new Error('Commit failed'); });
  await expect(createTransitionEffects({ ...f.options, scope }).dismissEffect(f.context, id)).rejects.toThrow('Commit failed');
  expect(await f.rows()).toEqual(before);
  expect(await f.audits(effectDismissed, id)).toEqual([]);
  expect(await f.effects.exhaustedEffects(f.gymId)).toHaveLength(1);
});
it('rolls the queue reset and the staff audit back together on a write failure', async () => {
  const f = await fixture(), id = await f.create(), before = await f.rows();
  const scope: typeof f.options.scope = (gymId, work) => f.options.scope(gymId, async tx => { await work(tx); throw new Error('Commit failed'); });
  await expect(createTransitionEffects({ ...f.options, scope }).retryEffect(f.context, id)).rejects.toThrow('Commit failed');
  expect(await f.rows()).toEqual(before);
  expect(await f.audits(effectStaffRetried, id)).toEqual([]);
  expect(await f.effects.exhaustedEffects(f.gymId)).toHaveLength(1);
});
it('does not retry completed effects even when their jobs are gone', async () => {
  const f = await fixture(), id = await f.create();
  await f.audit(effectCompleted, id); await f.removeJobs();
  await expect(f.effects.retryEffect(f.context, id)).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.rows()).toEqual([]);
});
it('queues one duplicate refund under concurrent staff retries, and reconciles rather than refunding twice', async () => {
  const f = await fixture();
  await f.transitions.manualPayment(f.context, { invoiceId: f.bill.id, paymentId: uuidv7(), method: 'cash',
    amountCents: f.bill.amountCents, currency: f.bill.currency, paidAt: f.clock.now().toISOString() });
  const intent = await f.provider.createCharge({ amount: f.bill.amountCents, currency: f.bill.currency.toLowerCase(),
    customerId: 'cus_test', paymentMethodId: 'pm_test', invoiceId: f.bill.id, attemptId: uuidv7(), idempotencyKey: 'duplicate-create' });
  await f.provider.confirmCharge(intent.id, { idempotencyKey: 'duplicate-confirm' });
  await f.transitions.cardSucceeded(f.context, { method: 'card', invoiceId: f.bill.id, paymentId: uuidv7(), paymentIntentId: intent.id,
    chargeId: 'ch_' + intent.id, amountCents: f.bill.amountCents, currency: f.bill.currency, paidAt: f.clock.now().toISOString() });
  const original = (await f.read()).audits.find(row => row.action === effectCreated && (row.after as TransitionEffect).kind === 'refund_duplicate')!;
  const id = await f.create('refund_duplicate', original.after as TransitionEffect);
  expect(await f.effects.exhaustedEffects(f.gymId)).toMatchObject([{ effectId: id, refund: { amountCents: f.bill.amountCents, currency: f.bill.currency } }]);
  const refund = vi.spyOn(f.provider, 'refund');
  await Promise.all([f.effects.retryEffect(f.context, id), f.effects.retryEffect(f.context, id)]);
  await f.drain(); await f.effects.run(original.targetId, f.jobContext);
  expect(refund).toHaveBeenCalledTimes(1);
  expect((await f.read()).refunds).toMatchObject([{ status: 'succeeded', amountCents: f.bill.amountCents }]);
  expect(await f.audits(effectStaffRetried, id)).toHaveLength(1);
});
