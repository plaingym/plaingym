// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
// eslint-disable-next-line database/system-tables -- The lock-order test reads backend PIDs to see one transaction wait on another's household lock.
import { and, asc, eq, sql } from 'drizzle-orm';
import { auditEvents, households, paymentMethods, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { FakeJobs, type Jobs } from '../../infra/jobs/index.js';
import { billingEmailDigest, billingEmailKeyId, type ClearedCustomerEmail } from '../../infra/payments/index.js';
import { setLogSink } from '../../core/log.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import type { PaymentTransport } from '../../infra/payments/transport.js';
import { createPaymentService } from '../billing/payments.js';
import { createPaymentJobs } from '../billing/payments.jobs.js';
import { detachJob } from '../billing/payments.mutations.js';
import { eligibility } from '../billing/runner/eligibility.js';
import { useRunnerFixture } from '../billing/runner/runner.fixture.test-helper.js';
import { billingEmailClearedAction, clearErasedBillingEmail, type ClearBillingEmail } from './erasure-redaction.js';
import { billingEmailErasuresToRetry, billingEmailNoMatchAction, billingEmailQueuedAction, billingEmailSkippedAction } from './erasure-redaction.query.js';

const { db, factory, fixture, invoice } = useRunnerFixture();
const secret = 'fixture-retire-erasure-secret';
const outcomeActions = [billingEmailClearedAction, billingEmailNoMatchAction];

/**
 * A surviving household of two members: a default debit account `pm_pad` with its mandate, a non-default card
 * `pm_card`, and an open invoice due now. The payer email clear is a stub returning `cleared` unless a run gives its own.
 */
async function household(cleared: ClearedCustomerEmail, erasureId?: string, keyed = true) {
  const f = await fixture();
  await factory('members', f.gymId, { householdId: f.home.id });
  const [pad] = await db.forGym(f.gymId, tx => tx.update(paymentMethods).set({ processorId: 'pm_pad', type: 'acss_debit',
    mandateId: 'mandate_saved', brand: null, bankName: 'STRIPE TEST BANK', last4: '6789', expiryMonth: null, expiryYear: null }).where(eq(paymentMethods.householdId, f.home.id)).returning());
  const card = await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_card', isDefault: false });
  const bill = await invoice(f);
  const jobs = new FakeJobs(f.clock);
  const clear = vi.fn<ClearBillingEmail>(async () => cleared);
  const payload = { householdId: f.home.id, customerId: 'cus_test', emailDigest: billingEmailDigest('payer@example.invalid', secret),
    paymentMethodIds: ['pm_pad', 'pm_card'], ...(erasureId ? { erasureId } : {}), ...(keyed ? { keyId: billingEmailKeyId(secret) } : {}) };
  const run = (config: { clear?: ClearBillingEmail; jobs?: Pick<Jobs, 'enqueue'>; scope?: typeof db.forGym; secret?: string } = {}) =>
    clearErasedBillingEmail(payload, f.gymId, config.clear ?? clear,
      { secret: config.secret ?? secret, clock: f.clock, timezone: f.context.timezone, jobs: config.jobs ?? jobs, scope: config.scope ?? db.forGym });
  const state = () => db.forGym(f.gymId, async tx => ({
    methods: await tx.select().from(paymentMethods).orderBy(asc(paymentMethods.processorId)),
    audits: await tx.select().from(auditEvents).orderBy(asc(auditEvents.id)),
    revoked: await tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.card.revoked')),
    outcomes: await tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.home.id)).orderBy(asc(auditEvents.id)).then(rows => rows.filter(row => outcomeActions.includes(row.action))),
    cleared: await tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailClearedAction), eq(auditEvents.targetId, f.home.id))),
  }));
  return { f, pad: pad!, card, bill, jobs, clear, run, state };
}
type Household = Awaited<ReturnType<typeof household>>['f'];

/** The marker the erasure itself writes when it queues the clear, so recovery lists the erasure until its outcome. */
function marker(f: Household, erasureId: string) {
  return db.forGym(f.gymId, tx => writeAudit(tx, { gymId: f.gymId, actorKind: 'system', action: billingEmailQueuedAction, targetType: 'household',
    targetId: f.home.id, after: { stripeCustomerId: 'cus_test', erasure: erasureId }, occurredAt: f.clock.now() }));
}

/**
 * A stateful provider: real `StripePayments` over `StripeFixtures`, with the household's customer and the erased payer's
 * address on the customer and the debit account (`padEmail`); the card holds `cardEmail`, another address by default.
 */
function provider(f: Household, padEmail: string, cardEmail = 'other@example.invalid') {
  const transport = new StripeFixtures(f.gymId);
  transport.objects.set('cus_test', { id: 'cus_test', object: 'customer', name: 'Household', email: 'payer@example.invalid',
    metadata: { gym_id: f.gymId, household_id: f.home.id } });
  transport.objects.set('pm_pad', { id: 'pm_pad', object: 'payment_method', type: 'acss_debit', acss_debit: { last4: '6789' }, customer: 'cus_test',
    metadata: { gym_id: f.gymId }, billing_details: { email: padEmail, name: 'Account holder' } });
  transport.objects.set('pm_card', { id: 'pm_card', object: 'payment_method', type: 'card', customer: 'cus_test', metadata: { gym_id: f.gymId },
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, billing_details: { email: cardEmail, name: 'Card holder' } });
  const stripe = new StripePayments(f.gymId, { transport, webhookSecret: 'fixture-secret' });
  const clear = vi.fn<ClearBillingEmail>((_gymId, customerId, options) => stripe.clearCustomerEmail(customerId, options));
  return { transport, clear };
}

/** A scope that holds its `hold`-th transaction open after its work, before commit, until released. */
function holding(hold: number) {
  let calls = 0;
  const locked = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
  const scope = (async (gymId: string, fn: (tx: Transaction) => Promise<unknown>) => {
    const mine = ++calls === hold;
    return db.forGym(gymId, async tx => {
      const result = await fn(tx);
      if (mine) {
        // eslint-disable-next-line database/system-tables -- The holder's backend PID, for the lock-wait probe.
        const { pid } = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!;
        locked.resolve(pid); await release.promise;
      }
      return result;
    });
  }) as typeof db.forGym;
  return { scope, locked: locked.promise, release: () => release.resolve() };
}
/** Polls from the system connection until another backend waits on a lock the holder `pid` has. */
async function blockedBy(pid: number) {
  for (let tries = 0; tries < 5_000; tries++)
    // eslint-disable-next-line database/system-tables -- The lock-wait probe.
    if ((await db.system.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0) return true;
  return false;
}

it('retires a method left with the placeholder email: revoked, audited and queued for a plain detach, once', async () => {
  const { f, pad, card, bill, jobs, clear, run, state } = await household({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: [] });
  const gym = await f.settings.get(f.gymId);
  expect(await db.forGym(f.gymId, tx => eligibility(tx, gym, f.clock, bill.id, 'automatic')))
    .toMatchObject({ status: 'eligible', payment: { methodId: 'pm_pad', mandateId: 'mandate_saved' } });
  await run();
  expect(clear).toHaveBeenCalledOnce();
  const after = await state();
  expect(after.methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: f.clock.now(), isDefault: false, mandateId: 'mandate_saved' });
  expect(after.methods.find(row => row.id === card.id)).toEqual(card);
  expect(after.revoked).toHaveLength(1);
  expect(after.revoked[0]).toMatchObject({ actorKind: 'system', targetType: 'payment_method', targetId: pad.id, after: { reason: 'notice_email_erased' } });
  expect(after.cleared).toHaveLength(1);
  expect(jobs.jobs.map(job => ({ name: job.name, payload: job.payload, key: job.options.idempotencyKey })))
    .toEqual([{ name: detachJob, payload: { paymentMethodId: pad.id }, key: `detach:${pad.id}` }]);

  // A legacy payload (no erasure ID) retried, answered as the provider answers one (nothing left to clear but the
  // placeholder), finds the row revoked: no row change and no second detach. Of every audit, it adds only its own
  // cleared outcome, since the debit account holds no erased address.
  clear.mockResolvedValueOnce({ matched: false, placeholderMethods: ['pm_pad'], failedMethods: [] });
  await run();
  const again = await state();
  expect(again.methods).toEqual(after.methods);
  expect(again.audits.slice(0, after.audits.length)).toEqual(after.audits);
  expect(again.audits.slice(after.audits.length)).toMatchObject([{ action: billingEmailClearedAction, targetId: f.home.id }]);
  expect(jobs.jobs).toHaveLength(1);

  // The household now has no saved method: the runner skips the invoice and reserves no attempt.
  expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'no_saved_card' });
  expect((await f.read()).attempts).toEqual([]);
});

it('retires the debit account even when another method failed, then completes once on retry', async () => {
  const { f, pad, bill, jobs, clear, run, state } = await household({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: ['pm_other'] });
  await expect(run()).rejects.toThrow('Billing email erasure incomplete');
  const after = await state();
  expect(after.methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: f.clock.now(), isDefault: false });
  expect(after.revoked).toHaveLength(1);
  expect(after.outcomes).toEqual([]);
  expect(jobs.jobs.map(job => job.options.idempotencyKey)).toEqual([`detach:${pad.id}`]);
  expect(await f.runner.charge(f.gymId, bill.id)).toEqual({ status: 'skipped', reason: 'no_saved_card' });
  expect((await f.read()).attempts).toEqual([]);

  clear.mockResolvedValueOnce({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: [] });
  await run();
  const done = await state();
  expect(done.cleared).toHaveLength(1);
  expect(done.outcomes).toHaveLength(1);
  expect(done.revoked).toEqual(after.revoked);
  expect(jobs.jobs).toHaveLength(1);
});

it('commits nothing when the detach enqueue fails, keeps the erasure for recovery, then commits it all once', async () => {
  const erasureId = uuidv7();
  const { f, pad, jobs, run, state } = await household({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: [] }, erasureId);
  await marker(f, erasureId);
  // One stateful provider for both runs: the first clears the customer's email and writes the debit account's placeholder
  // before its enqueue fails, so the recovery run finds nothing left to match.
  const { transport, clear } = provider(f, 'payer@example.invalid');
  const retry = () => db.forGym(f.gymId, tx => billingEmailErasuresToRetry(tx, f.gymId, 10));
  let failing = true;
  const flaky: Pick<Jobs, 'enqueue'> = { async enqueue(...args) {
    if (failing) { failing = false; throw new Error('Queue unavailable'); }
    return jobs.enqueue(...args);
  } };
  const before = await state();
  // The job's last ordinary attempt: it fails inside the retirement transaction.
  await expect(run({ clear, jobs: flaky })).rejects.toThrow('Queue unavailable');
  expect(await clear.mock.results[0]!.value).toEqual({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: [] });
  expect(transport.objects.get('cus_test')!.email).toBeNull();
  expect(transport.objects.get('pm_pad')!.billing_details).toMatchObject({ email: 'erased-member@example.com' });
  const failed = await state();
  expect(failed.methods).toEqual(before.methods);
  expect(failed.audits).toEqual(before.audits);
  expect(jobs.jobs).toEqual([]);
  expect(await retry()).toMatchObject([{ erasureId, householdId: f.home.id }]);

  // The recovery run: the provider has nothing left to match, but the debit account holds the placeholder.
  await run({ clear, jobs: flaky });
  expect(await clear.mock.results[1]!.value).toEqual({ matched: false, placeholderMethods: ['pm_pad'], failedMethods: [] });
  const recovered = await state();
  expect(recovered.methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: f.clock.now(), isDefault: false });
  expect(recovered.audits.slice(0, before.audits.length)).toEqual(before.audits);
  expect(recovered.audits.slice(before.audits.length).map(row => [row.action, row.targetId]))
    .toEqual([['billing.card.revoked', pad.id], [billingEmailClearedAction, f.home.id]]);
  expect(recovered.cleared[0]!.after).toMatchObject({ erasure: erasureId });
  expect(recovered.audits.some(row => row.action === billingEmailNoMatchAction)).toBe(false);
  expect(jobs.jobs.map(job => job.options.idempotencyKey)).toEqual([`detach:${pad.id}`]);
  expect(await retry()).toEqual([]);
});

it('certifies nothing under a changed install secret, then clears every method once the earlier secret is back', async () => {
  const erasureId = uuidv7();
  const { f, pad, card, jobs, run, state } = await household({ matched: false, placeholderMethods: [], failedMethods: [] }, erasureId);
  await marker(f, erasureId);
  // An earlier attempt cleared the customer and left the debit account the placeholder; the card still holds the erased
  // address. The payload's digest and key ID were made under `secret`; the install now has another.
  const { transport, clear } = provider(f, 'erased-member@example.com', 'payer@example.invalid');
  transport.objects.get('cus_test')!.email = null;
  const retry = () => db.forGym(f.gymId, tx => billingEmailErasuresToRetry(tx, f.gymId, 10));
  const before = await state();
  const lines: string[] = [];
  const previous = setLogSink(line => lines.push(line));
  try {
    await expect(run({ clear, secret: 'fixture-retire-rotated-secret' })).rejects.toThrow('Billing email erasure key changed');
  } finally { setLogSink(previous); }
  expect(clear).not.toHaveBeenCalled();
  expect(transport.requests).toEqual([]);
  const after = await state();
  expect(after.audits).toEqual(before.audits);
  expect(after.methods).toEqual(before.methods);
  expect(after.audits.filter(row => [billingEmailClearedAction, billingEmailNoMatchAction, 'billing.card.revoked'].includes(row.action))).toEqual([]);
  expect(jobs.jobs).toEqual([]);
  expect(await retry()).toMatchObject([{ erasureId, householdId: f.home.id }]);
  const logged = lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'members.erasure.billing_email_key_changed');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toEqual({ time: expect.any(String), level: 'error', event: 'members.erasure.billing_email_key_changed', gymId: f.gymId, householdId: f.home.id, erasureId });
  const line = lines.find(entry => entry.includes('billing_email_key_changed'))!;
  expect(line).not.toContain('payer@example.invalid');
  expect(line).not.toContain(billingEmailDigest('payer@example.invalid', secret).slice(3));

  // The same job after the owner restores the earlier secret: the card matches and is cleared, the debit account retired.
  await run({ clear });
  expect(clear).toHaveBeenCalledOnce();
  expect(transport.objects.get('pm_card')!.billing_details).toMatchObject({ email: null });
  const done = await state();
  expect(done.cleared).toHaveLength(1);
  expect(done.cleared[0]!.after).toMatchObject({ erasure: erasureId });
  expect(done.outcomes).toHaveLength(1);
  expect(done.revoked.map(row => row.targetId)).toEqual([pad.id]);
  expect(done.methods.find(row => row.id === card.id)).toMatchObject({ revokedAt: null });
  expect(jobs.jobs.map(job => job.options.idempotencyKey)).toEqual([`detach:${pad.id}`]);
  expect(await retry()).toEqual([]);
});

it('runs a payload queued without a key ID as before, under whatever secret the install has', async () => {
  const erasureId = uuidv7();
  const { f, clear, run, state } = await household({ matched: true, placeholderMethods: [], failedMethods: [] }, erasureId, false);
  await marker(f, erasureId);
  await run({ secret: 'fixture-retire-rotated-secret' });
  expect(clear).toHaveBeenCalledOnce();
  expect(clear.mock.calls[0]![2]).toMatchObject({ secret: 'fixture-retire-rotated-secret' });
  expect(clear.mock.calls[0]![2]).not.toHaveProperty('keyId');
  expect((await state()).cleared).toHaveLength(1);
  expect(await db.forGym(f.gymId, tx => billingEmailErasuresToRetry(tx, f.gymId, 10))).toEqual([]);
});

it('records an erasure once: a replay of the same erasure writes no audit, revokes nothing and queues no job', async () => {
  const erasureId = uuidv7();
  const { f, pad, jobs, run, state } = await household({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: [] }, erasureId);
  await marker(f, erasureId);
  const { transport, clear } = provider(f, 'payer@example.invalid');
  await run({ clear });
  const first = await state(), firstJobs = jobs.jobs;
  expect(first.revoked.map(row => [row.targetId, row.after])).toEqual([[pad.id, { reason: 'notice_email_erased', erasure: erasureId }]]);
  expect(first.cleared).toHaveLength(1);
  expect(first.outcomes).toHaveLength(1);
  expect(firstJobs.map(job => job.options.idempotencyKey)).toEqual([`detach:${pad.id}`]);
  const requests = transport.requests.length;

  // The same payload again, as when the job runs again after committing: nothing changes, and no provider call goes out.
  await run({ clear });
  const again = await state();
  expect(again.audits).toEqual(first.audits);
  expect(again.methods).toEqual(first.methods);
  expect(jobs.jobs).toEqual(firstJobs);
  expect(clear).toHaveBeenCalledOnce();
  expect(transport.requests).toHaveLength(requests);
  expect(await db.forGym(f.gymId, tx => billingEmailErasuresToRetry(tx, f.gymId, 10))).toEqual([]);
});

it('records a no-match once per erasure and still clears it on a later match', async () => {
  const erasureId = uuidv7();
  const { f, clear, run, state } = await household({ matched: false, placeholderMethods: [], failedMethods: [] }, erasureId);
  await marker(f, erasureId);
  await run();
  await run();
  expect((await state()).outcomes.map(row => [row.action, row.after])).toEqual([[billingEmailNoMatchAction, { stripeCustomerId: 'cus_test', erasure: erasureId }]]);
  expect(await db.forGym(f.gymId, tx => billingEmailErasuresToRetry(tx, f.gymId, 10))).toMatchObject([{ erasureId }]);
  clear.mockResolvedValueOnce({ matched: true, placeholderMethods: [], failedMethods: [] });
  await run();
  expect((await state()).outcomes.map(row => row.action)).toEqual([billingEmailNoMatchAction, billingEmailClearedAction]);
  expect(await db.forGym(f.gymId, tx => billingEmailErasuresToRetry(tx, f.gymId, 10))).toEqual([]);
});

it('records the clear once when the retired debit account is detached before the retry', async () => {
  const erasureId = uuidv7();
  const { f, pad, jobs, run, state } = await household({ matched: false, placeholderMethods: [], failedMethods: [] }, erasureId);
  await marker(f, erasureId);
  const transport = new StripeFixtures(f.gymId);
  transport.objects.set('cus_test', { id: 'cus_test', object: 'customer', name: 'Household', email: 'payer@example.invalid',
    metadata: { gym_id: f.gymId, household_id: f.home.id } });
  transport.objects.set('pm_pad', { id: 'pm_pad', object: 'payment_method', type: 'acss_debit', acss_debit: { last4: '6789' }, customer: 'cus_test',
    metadata: { gym_id: f.gymId }, billing_details: { email: 'payer@example.invalid', name: 'Account holder' } });
  transport.objects.set('pm_card', { id: 'pm_card', object: 'payment_method', type: 'card', customer: 'cus_test', metadata: { gym_id: f.gymId },
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, billing_details: { email: 'payer@example.invalid', name: 'Card holder' } });
  // Stripe applies the card's write, but its answer is lost.
  const lossy: PaymentTransport = { async request(request) {
    const response = await transport.request(request);
    if (request.method === 'POST' && request.path === '/v1/payment_methods/pm_card') throw Object.assign(new Error('Stripe unavailable'), { statusCode: 500 });
    return response;
  } };
  const stripe = new StripePayments(f.gymId, { transport: lossy, webhookSecret: 'fixture-secret' });
  const clear = vi.fn<ClearBillingEmail>((_gymId, customerId, options) => stripe.clearCustomerEmail(customerId, options));
  const retry = () => db.forGym(f.gymId, tx => billingEmailErasuresToRetry(tx, f.gymId, 10));

  await expect(run({ clear })).rejects.toThrow('Billing email erasure incomplete');
  expect(await clear.mock.results[0]!.value).toEqual({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: ['pm_card'] });
  const failed = await state();
  expect(failed.methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: f.clock.now(), isDefault: false });
  expect(failed.revoked.map(row => [row.targetId, row.after])).toEqual([[pad.id, { reason: 'notice_email_erased', erasure: erasureId }]]);
  expect(failed.outcomes).toEqual([]);
  expect(jobs.jobs.map(job => job.name)).toEqual([detachJob]);

  // The real detach job runs before the email job's retry: the provider no longer lists the debit account.
  const detach = createPaymentJobs({ scope: db.forGym, notifications: {} as never,
    detachCard: (_gymId, processorId, options) => stripe.detachPaymentMethod(processorId, options) }).find(job => job.id === detachJob)!;
  await detach.handler(jobs.jobs[0]!.payload, { jobId: uuidv7(), gymId: f.gymId, timezone: f.context.timezone, attempt: 1, clock: f.clock });
  expect(transport.objects.get('pm_pad')!.customer).toBeNull();

  await run({ clear });
  expect(await clear.mock.results[1]!.value).toEqual({ matched: false, placeholderMethods: [], failedMethods: [] });
  const done = await state();
  expect(done.outcomes.map(row => [row.action, row.after])).toEqual([[billingEmailClearedAction, { stripeCustomerId: 'cus_test', erasure: erasureId }]]);
  expect(done.revoked).toEqual(failed.revoked);
  expect(jobs.jobs).toHaveLength(1);
  expect(await retry()).toEqual([]);
});

it('records one skip when two attempts of an erasure overlap, even with the household row gone', async () => {
  for (const gone of [false, true]) {
    const erasureId = uuidv7();
    const { f, clear } = await household({ matched: true, placeholderMethods: [], failedMethods: [] }, erasureId);
    let householdId = f.home.id;
    if (gone) {
      // An erased household's row deleted since its clear was queued; the gym's customer link now names another household.
      const other = await factory('households', f.gymId);
      await db.forGym(f.gymId, tx => tx.delete(households).where(eq(households.id, other.id)));
      householdId = other.id;
    } else await db.forGym(f.gymId, tx => tx.update(households).set({ stripeCustomerId: null }).where(eq(households.id, f.home.id)));
    const payload = { householdId, customerId: 'cus_test', erasureId, emailDigest: billingEmailDigest('payer@example.invalid', secret), paymentMethodIds: ['pm_pad'] };
    const attempt = (scope: typeof db.forGym) =>
      clearErasedBillingEmail(payload, f.gymId, clear, { secret, clock: f.clock, timezone: f.context.timezone, jobs: new FakeJobs(f.clock), scope });
    // The first holds its third transaction (after the replay check and the link check: the skip) open after its write.
    const held = holding(3);
    const firstRun = attempt(held.scope);
    const pid = await held.locked;
    // The second passes its replay check, since the first's skip isn't committed, and waits on the erasure's lock.
    const secondRun = attempt(db.forGym);
    const waited = blockedBy(pid);
    try { await waited; } finally { held.release(); }
    expect(await waited).toBe(true);
    await expect(firstRun).resolves.toBeUndefined();
    await expect(secondRun).resolves.toBeUndefined();
    expect(clear).not.toHaveBeenCalled();
    const skips = await db.forGym(f.gymId, tx => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, billingEmailSkippedAction), eq(auditEvents.targetId, householdId))));
    expect(skips.map(row => row.after)).toEqual([{ stripeCustomerId: 'cus_test', erasure: erasureId }]);
  }
});

it('serializes the retirement with staff making the debit account the default, in either order', async () => {
  for (const first of ['retirement', 'staff'] as const) {
    const { f, pad, card, run, state } = await household({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: [] });
    await db.forGym(f.gymId, async tx => {
      await tx.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.id, pad.id));
      await tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, card.id));
    });
    const context = { gymId: f.gymId, actor: { kind: 'system' as const } };
    // The first holds its transaction open at its locks; the second must wait on the household, then runs after commit.
    const held = holding(first === 'retirement' ? 2 : 1); // The retirement's first scope is its link check.
    const staffScope = first === 'staff' ? held.scope : db.forGym, retireScope = first === 'retirement' ? held.scope : db.forGym;
    const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
    let firstRun: Promise<{ value: unknown } | { error: unknown }>, secondRun: Promise<{ value: unknown } | { error: unknown }>;
    if (first === 'retirement') firstRun = settle(run({ scope: retireScope }));
    else firstRun = settle(createPaymentService({ ...f.serviceOptions, scope: staffScope }).setDefault(context, f.home.id, pad.id));
    const pid = await held.locked;
    if (first === 'retirement') secondRun = settle(createPaymentService({ ...f.serviceOptions, scope: staffScope }).setDefault(context, f.home.id, pad.id));
    else secondRun = settle(run({ scope: retireScope }));
    const waited = blockedBy(pid);
    try { await waited; } finally { held.release(); }
    expect(await waited).toBe(true);
    const [retirement, staff] = first === 'retirement' ? [await firstRun, await secondRun] : [await secondRun, await firstRun];
    expect(retirement).toEqual({ value: undefined });
    if (first === 'retirement') expect(staff).toMatchObject({ error: { code: 'conflict', details: { reason: ['card_removed'] } } });
    else expect(staff).toMatchObject({ value: { id: pad.id } });
    expect((await state()).methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: f.clock.now(), isDefault: false });
  }
});

it('never revokes a method of another household or one already revoked', async () => {
  const { f, pad, jobs, run, state } = await household({ matched: true, placeholderMethods: ['pm_other', 'pm_old'], failedMethods: [] });
  const other = await factory('households', f.gymId);
  await factory('paymentMethods', f.gymId, { householdId: other.id, processorId: 'pm_other', isDefault: true });
  await factory('paymentMethods', f.gymId, { householdId: f.home.id, processorId: 'pm_old', isDefault: false, revokedAt: new Date('2028-01-01T00:00:00Z') });
  const before = await state();
  await run();
  const after = await state();
  expect(after.methods).toEqual(before.methods);
  expect(after.methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: null, isDefault: true });
  expect(after.revoked).toEqual([]);
  expect(after.cleared).toHaveLength(1);
  expect(jobs.jobs).toEqual([]);
});

it('retires the debit account the provider left holding the placeholder, never a card holding the same address', async () => {
  const { f, pad, card, jobs, run, state } = await household({ matched: false, placeholderMethods: [], failedMethods: [] });
  const transport = new StripeFixtures(f.gymId);
  transport.objects.set('cus_test', { id: 'cus_test', object: 'customer', name: 'Household', email: 'payer@example.invalid',
    metadata: { gym_id: f.gymId, household_id: f.home.id } });
  // An earlier attempt left the placeholder on the debit account; the card held the same address before this erasure.
  transport.objects.set('pm_pad', { id: 'pm_pad', object: 'payment_method', type: 'acss_debit', acss_debit: { last4: '6789' }, customer: 'cus_test',
    metadata: { gym_id: f.gymId }, billing_details: { email: 'erased-member@example.com', name: 'Account holder' } });
  transport.objects.set('pm_card', { id: 'pm_card', object: 'payment_method', type: 'card', customer: 'cus_test', metadata: { gym_id: f.gymId },
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, billing_details: { email: 'erased-member@example.com', name: 'Card holder' } });
  const stripe = new StripePayments(f.gymId, { transport, webhookSecret: 'fixture-secret' });
  const clear = vi.fn<ClearBillingEmail>((_gymId, customerId, options) => stripe.clearCustomerEmail(customerId, options));
  await run({ clear });
  expect(await clear.mock.results[0]!.value).toEqual({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: [] });
  expect(transport.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/v1/customers/cus_test']);
  const after = await state();
  expect(after.methods.find(row => row.id === pad.id)).toMatchObject({ revokedAt: f.clock.now(), isDefault: false });
  expect(after.methods.find(row => row.id === card.id)).toEqual(card);
  expect(after.revoked.map(row => row.targetId)).toEqual([pad.id]);
  expect(jobs.jobs.map(job => job.options.idempotencyKey)).toEqual([`detach:${pad.id}`]);
});

it('changes nothing beyond the clear audit when no method holds the placeholder', async () => {
  const { jobs, run, state } = await household({ matched: true, placeholderMethods: [], failedMethods: [] });
  const before = await state();
  await run();
  const after = await state();
  expect(after.methods).toEqual(before.methods);
  expect(after.revoked).toEqual([]);
  expect(after.cleared).toHaveLength(1);
  expect(after.audits.slice(before.audits.length).map(row => row.action)).toEqual([billingEmailClearedAction]);
  expect(jobs.jobs).toEqual([]);
});

it('refuses to run without a job queue, before calling out', async () => {
  const { f, clear, pad } = await household({ matched: true, placeholderMethods: ['pm_pad'], failedMethods: [] });
  await expect(clearErasedBillingEmail({ householdId: f.home.id, customerId: 'cus_test', emailDigest: billingEmailDigest('payer@example.invalid', secret),
    paymentMethodIds: ['pm_pad'] }, f.gymId, clear, { secret, clock: f.clock, timezone: f.context.timezone, scope: db.forGym }))
    .rejects.toThrow('Billing email erasure is not configured');
  expect(clear).not.toHaveBeenCalled();
  expect((await db.forGym(f.gymId, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, pad.id))))[0]).toMatchObject({ revokedAt: null });
});
