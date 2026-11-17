// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, classCreditEntries, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- Each test owns this isolated database's queue rows.
import { jobs } from '@plaingym/db';
import { isInTransaction } from '@plaingym/shared/transaction';
import { FakeJobs, PostgresJobs, PostgresJobStatsQuery, type JobContext } from '../../../infra/jobs/index.js';
import { FakeEmail } from '../../../infra/email/index.js';
import { setLogSink } from '../../../core/log.js';
import { createMembershipService } from '../memberships.js';
import { useRunnerFixture } from '../runner/runner.fixture.test-helper.js';
import { createWebhookInbox } from '../webhooks/inbox.js';
import { composeBillingWebhooks } from '../webhooks/handlers/composition.js';
import { createTransitionEffects, effectJob, effectRecoveryDelayMs, effectRecoveryExhausted,
  effectRecoveryLimit, effectRetried } from './effects.js';
import { createTransitionJobs } from './transitions.jobs.js';
import { effectCompleted, effectCreated, effectPublished, type TransitionEffect } from './store.js';

const { db, factory, fixture: runnerFixture, invoice } = useRunnerFixture();
beforeEach(async () => { await db.forSystem(tx => tx.delete(jobs)); });
async function fixture(acknowledgementFails = false) {
  const f = await runnerFixture({ timezone: 'UTC', status: 'pending', now: '2028-03-01T09:00:00Z' });
  const bill = await invoice(f), queue = new PostgresJobs({ database: db, clock: f.clock });
  await factory('invoiceLineItems', f.gymId, { invoiceId: bill.id, householdId: f.home.id,
    kind: 'membership', membershipId: f.membership.id });
  const lifecycle = createMembershipService(f.serviceOptions), afterInvoicePaid = vi.fn(async () => {});
  const retry = vi.fn(async (id: string, context: JobContext) => f.runner.retry(id, context));
  const options = { ...f.serviceOptions, jobs: queue, recovery: queue, transitions: f.transitions, memberships: lifecycle,
    payments: async () => f.provider, notifications: { receipt: vi.fn(async () => {}), dunning: vi.fn(async () => {}),
      staffNotice: vi.fn(async () => {}) }, retry, afterInvoicePaid };
  const build = () => createTransitionEffects(options), effects = build();
  for (const job of createTransitionJobs(() => effects)) queue.handle(job.id, async (payload, context) => {
    await job.handler(payload, context);
    if (acknowledgementFails && job.id === effectJob) throw new Error('Acknowledgement unavailable');
  });
  const audits = (action: string) => db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));
  const work = async (kind: TransitionEffect['kind']) => (await audits(effectCreated))
    .filter(row => (row.after as TransitionEffect).kind === kind);
  const drain = async () => {
    for (let n = 0; n < 50; n++) if (!await queue.runNext()) return;
    throw new Error('Queue did not drain');
  };
  // Exercise all twelve real queue attempts and its exponential backoff, without sleeping.
  const exhaust = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await drain();
      if (attempt < 11) f.clock.advance(1000 * 2 ** attempt);
    }
  };
  const pay = async () => {
    await f.transitions.manualPayment({ gymId: f.gymId, actor: { kind: 'system' } }, { invoiceId: bill.id,
      paymentId: uuidv7(), amountCents: bill.amountCents, currency: bill.currency, method: 'cash', paidAt: f.clock.now().toISOString() });
    await effects.publish(f.gymId);
  };
  const sweep = () => createTransitionJobs(build).find(job => job.id === 'billing.transitions.publish')!.handler({}, f.context);
  return { ...f, bill, queue, lifecycle, options, build, effects, work, audits, drain, exhaust, pay, sweep, afterInvoicePaid };
}

it.each(['activation', 'paid hook'] as const)('recovers twelve failed attempts at %s, activating and granting credits once', async stage => {
  const f = await fixture(), pack = await factory('classPacks', f.gymId);
  await factory('classPackSales', f.gymId, { invoiceId: f.bill.id, householdId: f.home.id,
    memberId: f.member.id, packId: pack.id, credits: 10 });
  const activate = vi.spyOn(f.lifecycle, 'activate');
  if (stage === 'activation') activate.mockRejectedValue(new Error('Membership service unavailable'));
  else f.afterInvoicePaid.mockRejectedValue(new Error('Paid hook unavailable'));
  await f.pay(); await f.exhaust();
  const [work] = await f.work('activate_memberships');
  const [failed] = await f.queue.failedJobs(effectJob, [work!.targetId], { gymId: f.gymId });
  expect(failed).toBeDefined(); expect(await f.audits(effectCompleted)).toHaveLength(1); // Receipt only.
  expect((await f.read()).memberships[0]!.status).toBe(stage === 'activation' ? 'pending' : 'active');
  if (stage === 'activation') activate.mockRestore();
  f.afterInvoicePaid.mockResolvedValue();
  f.clock.advance(effectRecoveryDelayMs - 1);
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  f.clock.advance(1);
  const resets = await Promise.all([f.build().recoverFailed(f.gymId), f.build().recoverFailed(f.gymId)]);
  expect(resets.reduce((sum, result) => sum + result.recovered, 0)).toBe(1);
  const enqueue = vi.spyOn(f.queue, 'enqueue');
  await f.drain(); await f.sweep(); await f.effects.run(work!.targetId, f.context);
  expect(enqueue).not.toHaveBeenCalled();
  expect((await f.read()).memberships[0]!.status).toBe('active');
  expect(await f.audits('billing.membership.activated')).toHaveLength(1);
  const credits = await db.forGym(f.gymId, tx => tx.select().from(classCreditEntries));
  expect(credits).toMatchObject([{ kind: 'grant', credits: 10 }]);
  expect(await f.audits(effectRetried)).toMatchObject([{ after: { jobId: failed!.jobId, delayMs: effectRecoveryDelayMs } }]);
  expect(await new PostgresJobStatsQuery(db).get(f.gymId)).toMatchObject({ failed: 0, succeeded: 2 });
});

it('a recovered retry still respects a retry window already consumed while its job was down', async () => {
  const f = await fixture();
  f.provider.respondNextConfirmation('declined');
  await f.runner.charge(f.gymId, f.bill.id, { mode: 'automatic' });
  f.options.retry.mockRejectedValue(new Error('Runner unavailable'));
  await f.effects.publish(f.gymId); await f.drain();
  f.clock.set('2028-03-04T09:00:00Z'); await f.exhaust();
  // Both day-three and day-seven effects exist; database row order does not identify the due one.
  const work = (await f.work('retry')).find(row => (row.after as TransitionEffect).retryDay === 3);
  const later = (await f.work('retry')).find(row => (row.after as TransitionEffect).retryDay === 7);
  expect(work).toBeDefined(); expect(later).toBeDefined();
  expect(await f.queue.failedJobs(effectJob, [work!.targetId], { gymId: f.gymId })).toHaveLength(1);
  expect(await f.queue.failedJobs(effectJob, [later!.targetId], { gymId: f.gymId })).toHaveLength(0);
  // Another collection consumed day three. Recovered work must not charge a second time in that window.
  f.provider.respondNextConfirmation('declined'); await f.runner.retry(f.bill.id, f.context);
  expect((await f.read()).attempts).toHaveLength(2);
  f.options.retry.mockImplementation(async (id, context) => f.runner.retry(id, context));
  f.clock.advance(effectRecoveryDelayMs); await f.sweep(); await f.drain();
  expect((await f.read()).attempts).toHaveLength(2);
  expect((await f.read()).invoices[0]!.status).toBe('past_due');
  expect((await f.audits(effectCompleted)).some(row => row.targetId === work!.targetId)).toBe(true);
});

it('backs off across restarts, stops at its limit, and leaves the failure visible to Health', async () => {
  const f = await fixture();
  f.options.notifications.receipt.mockRejectedValue(new Error('Delivery unavailable'));
  await f.pay(); await f.exhaust();
  const [work] = await f.work('receipt');
  const [original] = await f.queue.failedJobs(effectJob, [work!.targetId], { gymId: f.gymId });
  for (let reset = 0; reset < effectRecoveryLimit; reset++) {
    const delay = effectRecoveryDelayMs * 2 ** reset;
    f.clock.advance(delay - 1);
    expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
    f.clock.advance(1); await f.sweep(); await f.exhaust();
    expect(await f.queue.failedJobs(effectJob, [work!.targetId], { gymId: f.gymId })).toMatchObject([{ jobId: original!.jobId }]);
  }
  f.clock.advance(31 * 86_400_000); // Recovery must still inspect work beyond the publication window.
  await Promise.all([f.sweep(), f.sweep()]);
  expect(await f.audits(effectRetried)).toHaveLength(effectRecoveryLimit);
  expect(await f.audits(effectRecoveryExhausted)).toMatchObject([{ targetId: work!.targetId,
    after: { kind: 'receipt', jobId: original!.jobId, resets: effectRecoveryLimit } }]);
  const lookup = vi.spyOn(f.queue, 'failedJobs');
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(lookup).not.toHaveBeenCalled();
  expect(await new PostgresJobStatsQuery(db).get(f.gymId)).toMatchObject({ failed: 1, succeeded: 1, pending: 0 });
});

it('leaves a completed effect alone even when its queue acknowledgement failed twelve times', async () => {
  const f = await fixture(true);
  await f.pay(); await f.exhaust(); f.clock.advance(effectRecoveryDelayMs);
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 0, exhausted: 0 });
  expect(f.afterInvoicePaid).toHaveBeenCalledTimes(1);
  expect(f.options.notifications.receipt).toHaveBeenCalledTimes(1);
  expect(await f.audits(effectRetried)).toEqual([]);
});

it('logs one effect recovery failure and continues with the other failed effects', async () => {
  const f = await fixture();
  f.options.notifications.receipt.mockRejectedValue(new Error('Delivery unavailable'));
  f.afterInvoicePaid.mockRejectedValue(new Error('Paid hook unavailable'));
  await f.pay(); await f.exhaust(); f.clock.advance(effectRecoveryDelayMs);
  const reset = f.queue.retryFailed.bind(f.queue);
  const retry = vi.spyOn(f.queue, 'retryFailed').mockRejectedValueOnce(new Error('Private lock timeout details'))
    .mockImplementationOnce(reset);
  const lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try {
    expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
  } finally { setLogSink(previous); }
  expect(retry).toHaveBeenCalledTimes(2);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'billing.transition.effect.recovery_failed', gymId: f.gymId });
  expect(lines[0]).not.toContain('Private lock timeout details');
  retry.mockRestore();
  expect(await f.build().recoverFailed(f.gymId)).toEqual({ recovered: 1, exhausted: 0 });
});

it('pages old work, keeps gym scope, and ignores unpublished, missing, pending and completed jobs', async () => {
  const f = await fixture(), foreign = await fixture(), queue = new FakeJobs(f.clock);
  const old = new Date(f.clock.now().getTime() - 31 * 86_400_000), ids: string[] = [];
  for (let n = 0; n < 105; n++) {
    const id = uuidv7(); ids.push(id);
    await factory('auditEvents', f.gymId, { action: effectCreated, targetId: id, occurredAt: old,
      after: { kind: 'receipt', invoiceId: f.bill.id } });
    if (n !== 0) await factory('auditEvents', f.gymId, { action: effectPublished, targetId: id, occurredAt: old });
  }
  await factory('auditEvents', f.gymId, { action: effectCompleted, targetId: ids[1]! });
  const foreignId = uuidv7();
  await factory('auditEvents', foreign.gymId, { action: effectCreated, targetId: foreignId, occurredAt: old,
    after: { kind: 'receipt', invoiceId: foreign.bill.id } });
  await factory('auditEvents', foreign.gymId, { action: effectPublished, targetId: foreignId, occurredAt: old });
  queue.handle(effectJob, async () => { throw new Error('Unavailable'); });
  for (const [gymId, id] of [[f.gymId, ids[0]!], [f.gymId, ids[1]!], [f.gymId, ids[104]!], [foreign.gymId, foreignId]] as const)
    await queue.enqueue(effectJob, { effectId: id }, { gymId, timezone: 'UTC', idempotencyKey: id, maxAttempts: 1 });
  for (let n = 0; n < 4; n++) expect(await queue.runNext()).toBe(true);
  await queue.enqueue(effectJob, { effectId: ids[2] }, { gymId: f.gymId, timezone: 'UTC', idempotencyKey: ids[2]! });
  f.clock.advance(effectRecoveryDelayMs);
  const failedJobs = queue.failedJobs.bind(queue), retryFailed = queue.retryFailed.bind(queue);
  const lookup = vi.spyOn(queue, 'failedJobs').mockImplementation(async (...args) => {
    expect(isInTransaction()).toBe(false); return failedJobs(...args);
  });
  vi.spyOn(queue, 'retryFailed').mockImplementation(async (...args) => {
    expect(isInTransaction()).toBe(false); return retryFailed(...args);
  });
  expect(await createTransitionEffects({ ...f.options, jobs: queue, recovery: queue }).recoverFailed(f.gymId))
    .toEqual({ recovered: 1, exhausted: 0 });
  expect(lookup.mock.calls.map(call => call[1].length)).toEqual([100, 3]);
  expect(queue.jobs.filter(job => job.status === 'queued')).toHaveLength(2);
  expect(queue.jobs).toHaveLength(5);
  expect(await foreign.audits(effectRetried)).toEqual([]);
});

it('recovers failed jobs even if zero settlement and publication both fail', async () => {
  const f = await fixture();
  f.options.notifications.receipt.mockRejectedValue(new Error('Delivery unavailable'));
  await f.pay(); await f.exhaust(); f.clock.advance(effectRecoveryDelayMs);
  const paymentsFor = async () => f.provider;
  const inbox = createWebhookInbox({ ...f.serviceOptions, paymentsFor, gymSettings: f.settings, system: db.forSystem });
  // Use the production billing composition to check that it forwards recovery to its effects service.
  const { effects } = composeBillingWebhooks({ ...f.options, inbox, paymentsFor,
    prepare: async () => ({ email: new FakeEmail(), origin: 'https://gym.example.invalid' }), staffRecipients: async () => [] });
  vi.spyOn(effects, 'settleZeroInvoices').mockRejectedValue(new Error('Settlement unavailable'));
  vi.spyOn(effects, 'publish').mockRejectedValue(new Error('Publication unavailable'));
  await expect(createTransitionJobs(() => effects)[0]!.handler({}, f.context)).rejects.toThrow('Publication unavailable');
  expect(await f.audits(effectRetried)).toHaveLength(1);
});
