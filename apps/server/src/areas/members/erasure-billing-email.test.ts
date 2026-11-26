// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Inspect the durable erasure job to prove it commits and rolls back with the member.
import { auditEvents, households, jobs as jobRows, members, uuidv7, type forGym } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeJobs, PostgresJobs } from '../../infra/jobs/index.js';
import { billingEmailDigest, billingEmailKeyId, FakePayments } from '../../infra/payments/index.js';
import { createMembersService } from './members.js';
import { createErasureJobs } from './members.routes.js';
import { billingEmailClearedAction, billingEmailMaxResets, billingEmailResetDelayMs, clearBillingEmailJob, queueEarlierRedactions, redactEarlierJob } from './erasure-redaction.js';
import { billingEmailAbandonedAction, billingEmailErasuresToRetry, billingEmailMissingAction, billingEmailNoMatchAction, billingEmailResetAction, billingEmailSkippedAction } from './erasure-redaction.query.js';

const database = useTestDatabase(), factory = createFactories(database), gymId = uuidv7(), otherGym = uuidv7();
const clock = new TestClock('2026-11-14T12:00:00Z');
const context = { gymId, actor: { kind: 'system' as const } };
const billingEmailSecret = 'fixture-member-email-erasure-secret';
const service = createMembersService({ scope: database.forGym, clock, billingEmailSecret });
beforeAll(async () => { await factory('gyms', gymId); await factory('gyms', otherGym); });

async function fixture(email: string | null = ' PAYER@EXAMPLE.INVALID ', customer = true, cardPrefix = 'pm_') {
  const customerId = customer ? 'cus_' + uuidv7().replaceAll('-', '') : null;
  const home = await factory('households', gymId, { email, stripeCustomerId: customerId });
  const person = await factory('members', gymId, { householdId: home.id, email: 'payer@example.invalid' });
  const remaining = await factory('members', gymId, { householdId: home.id, email: 'remaining@example.invalid' });
  const card = await factory('paymentMethods', gymId, { householdId: home.id, isDefault: true, processorId: cardPrefix + uuidv7().replaceAll('-', '') });
  const payments = new FakePayments(gymId, clock);
  if (customerId) {
    payments.seedCustomer({ id: customerId, householdId: home.id, email: 'payer@example.invalid', name: 'Household' });
    payments.recordPaymentMethod({ id: card.processorId, customerId, brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
    payments.setBillingDetails(card.processorId, { email: 'payer@example.invalid', name: 'Card holder' });
  }
  return { home, person, remaining, card, customerId, payments };
}
async function jobPayload(queue: FakeJobs | PostgresJobs, customerId: string | null) {
  if (queue instanceof FakeJobs) return queue.jobs.filter(job => job.name === clearBillingEmailJob)
    .map(job => ({ payload: job.payload, key: job.options.idempotencyKey, attempts: job.options.maxAttempts }));
  const rows = await database.forGym(gymId, tx => tx.select().from(jobRows).where(eq(jobRows.name, clearBillingEmailJob)));
  return rows.filter(row => (row.payload as { value: { customerId: string } }).value.customerId === customerId)
    .map(row => ({ payload: (row.payload as { value: unknown }).value, key: row.idempotencyKey, attempts: row.maxAttempts }));
}
function handler(payments: FakePayments) {
  const clear = vi.fn(async (gym: string, customerId: string, options: Parameters<FakePayments['clearCustomerEmail']>[1]) => {
    expect(gym).toBe(gymId);
    return payments.clearCustomerEmail(customerId, options);
  });
  const job = createErasureJobs({ clearBillingEmail: clear, billingEmailSecret, jobs: new FakeJobs(clock), scope: database.forGym }).find(job => job.id === clearBillingEmailJob)!;
  return { clear, run: (payload: unknown, gym = gymId) => job.handler(payload, { gymId: gym, jobId: 'clear-email', timezone: 'UTC', attempt: 1, clock }) };
}

describe.each(['fake', 'postgres'] as const)('%s payer email erasure', kind => {
  const queue = () => kind === 'fake' ? new FakeJobs(clock) : new PostgresJobs({ database, clock });
  it('queues once, audits the email clear and runs idempotently without erasing the remaining household', async () => {
    const { home, person, remaining, customerId, card, payments } = await fixture(), jobs = queue();
    const result = await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    const payload = (await jobPayload(jobs, customerId))[0]!.payload as { erasureId: string };
    const expected = { householdId: home.id, customerId, erasureId: payload.erasureId, paymentMethodIds: [card.processorId], emailDigest: billingEmailDigest('payer@example.invalid', billingEmailSecret),
      keyId: billingEmailKeyId(billingEmailSecret) };
    expect(await jobPayload(jobs, customerId)).toEqual([{ payload: expected,
      key: kind === 'fake' ? `clear-billing-email:${payload.erasureId}` : expect.stringMatching(/^[a-f0-9]{64}$/), attempts: 12 }]);
    expect(JSON.stringify(await jobPayload(jobs, customerId))).not.toContain('payer@example.invalid');
    expect(JSON.stringify(await jobPayload(jobs, customerId))).not.toContain(billingEmailSecret);
    expect(result).toMatchObject({ householdErased: false, erasedCustomerId: null, revokedCards: [] });
    const stored = await database.forGym(gymId, async tx => ({
      home: (await tx.select().from(households).where(eq(households.id, home.id)))[0],
      member: (await tx.select().from(members).where(eq(members.id, remaining.id)))[0],
      audits: await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, home.id), eq(auditEvents.action, 'household.pin.cleared'))),
    }));
    expect(stored.home).toMatchObject({ email: null, stripeCustomerId: customerId, name: home.name });
    expect(stored.member).toMatchObject({ email: 'remaining@example.invalid', anonymizedAt: null });
    expect(stored.audits).toHaveLength(1);
    expect(stored.audits[0]!.after).toEqual({ billingEmailCleared: true });
    const job = handler(payments);
    await job.run(expected); await job.run(expected);
    expect(payments.customer(customerId!)!).toMatchObject({ email: null, name: 'Household' });
    expect(payments.billingDetails(card.processorId)).toMatchObject({ email: null, name: 'Card holder' });
    expect(await payments.readPaymentObject({ kind: 'payment_method', id: card.processorId })).toMatchObject({ status: 'found' });
    await expect(service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' })).rejects.toThrow();
    const completed = await database.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailClearedAction), eq(auditEvents.targetId, home.id))));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ actorKind: 'system', after: { stripeCustomerId: customerId, erasure: payload.erasureId }, occurredAt: clock.now() });
    expect(JSON.stringify(completed)).not.toContain(expected.emailDigest);
    // Every erased email is checked at the provider even when no local billing email remains.
    await factory('members', gymId, { householdId: home.id });
    await service.eraseMember(context, remaining.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    expect(await jobPayload(jobs, customerId)).toHaveLength(2);
  });
  it.each(['remaining@example.invalid', null])('clears provider leftovers despite a different or absent household email: %s', async email => {
    const { home, person, customerId, payments } = await fixture(email), jobs = queue();
    await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    const [queued] = await jobPayload(jobs, customerId);
    expect(queued).toBeDefined();
    await handler(payments).run(queued!.payload);
    expect(payments.customer(customerId!)!.email).toBeNull();
    const [audit] = await database.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, home.id), eq(auditEvents.action, 'household.pin.cleared'))));
    expect(audit?.after ?? {}).not.toHaveProperty('billingEmailCleared');
  });
  it('audits the local clear without queuing when the customer is absent', async () => {
    const { home, person } = await fixture(undefined, false), jobs = queue();
    await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    expect(await jobPayload(jobs, null)).toEqual([]);
    const [audit] = await database.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, home.id)));
    expect(audit!.after).toEqual({ billingEmailCleared: true });
  });
  it('rolls the email, member, audit and cleanup job back together after enqueue', async () => {
    const { home, person, customerId } = await fixture(), jobs = queue();
    const scope: typeof forGym = (gym, fn) => database.forGym(gym, async tx => {
      await fn(tx);
      if (kind === 'postgres') expect((await tx.select().from(jobRows).where(eq(jobRows.name, clearBillingEmailJob)))
        .some(row => JSON.stringify(row.payload).includes(customerId!))).toBe(true);
      throw new Error('fail before commit');
    });
    await expect(createMembersService({ scope, clock, billingEmailSecret }).eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' })).rejects.toThrow('fail before commit');
    expect(await jobPayload(jobs, customerId)).toEqual([]);
    const stored = await database.forGym(gymId, async tx => ({
      home: (await tx.select().from(households).where(eq(households.id, home.id)))[0],
      member: (await tx.select().from(members).where(eq(members.id, person.id)))[0],
      audits: await tx.select().from(auditEvents).where(eq(auditEvents.targetId, home.id)),
    }));
    expect(stored.home!.email).toBe(home.email);
    expect(stored.member!.anonymizedAt).toBeNull();
    expect(stored.audits).toEqual([]);
  });
});

it.each(['other gym', 'other household', 'unlinked'])('skips a stale or foreign job: %s', async change => {
  const { home, person, customerId, payments } = await fixture(), jobs = new FakeJobs(clock);
  await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
  const payload = (await jobPayload(jobs, customerId))[0]!.payload;
  if (change === 'other household' || change === 'unlinked') await database.forGym(gymId, tx => tx.update(households).set({ stripeCustomerId: null }).where(eq(households.id, home.id)));
  if (change === 'other household') await factory('households', gymId, { stripeCustomerId: customerId });
  const job = handler(payments);
  await job.run(payload, change === 'other gym' ? otherGym : gymId);
  expect(job.clear).not.toHaveBeenCalled();
  expect(payments.customer(customerId!)!.email).toBe('payer@example.invalid');
});

it('clears the old provider copy even after staff enter a replacement local billing email', async () => {
  const { home, person, customerId, payments } = await fixture(), jobs = new FakeJobs(clock);
  await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
  await database.forGym(gymId, tx => tx.update(households).set({ email: 'replacement@example.invalid' }).where(eq(households.id, home.id)));
  await handler(payments).run((await jobPayload(jobs, customerId))[0]!.payload);
  expect(payments.customer(customerId!)!.email).toBeNull();
  const [stored] = await database.forGym(gymId, tx => tx.select().from(households).where(eq(households.id, home.id)));
  expect(stored!.email).toBe('replacement@example.invalid');
});

it('clears an imported default card that keeps a legacy card ID', async () => {
  const { person, customerId, card, payments } = await fixture(undefined, true, 'card_'), jobs = new FakeJobs(clock);
  await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
  const [queued] = await jobPayload(jobs, customerId);
  expect(queued!.payload).toMatchObject({ paymentMethodIds: [card.processorId] });
  await handler(payments).run(queued!.payload);
  expect(payments.customer(customerId!)!.email).toBeNull();
  expect(payments.billingDetails(card.processorId)).toMatchObject({ email: null, name: 'Card holder' });
});

it('propagates a provider failure so the queue retries, and refuses an unwired callback', async () => {
  const { person, customerId } = await fixture(), jobs = new FakeJobs(clock);
  await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
  const payload = (await jobPayload(jobs, customerId))[0]!.payload;
  const clear = vi.fn(async () => { throw new Error('provider unavailable'); });
  const ctx = { gymId, jobId: 'retry', timezone: 'UTC', attempt: 1, clock };
  const failing = createErasureJobs({ clearBillingEmail: clear, billingEmailSecret, jobs, scope: database.forGym }).find(job => job.id === clearBillingEmailJob)!;
  await expect(failing.handler(payload, ctx)).rejects.toThrow('provider unavailable');
  expect(await database.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailClearedAction),
    eq(auditEvents.targetId, (payload as { householdId: string }).householdId))))).toEqual([]);
  await expect(createErasureJobs({}).find(job => job.id === clearBillingEmailJob)!.handler(payload, ctx)).rejects.toThrow('not configured');
});

it('queues every unrevoked card and clears non-default email copies without changing the cards', async () => {
  const { home, person, card, payments, customerId } = await fixture('replacement@example.invalid');
  const extra = await factory('paymentMethods', gymId, { householdId: home.id, isDefault: false, processorId: 'pm_extra_' + uuidv7().replaceAll('-', '') });
  const revoked = await factory('paymentMethods', gymId, { householdId: home.id, isDefault: false, revokedAt: clock.now() });
  const foreign = await factory('paymentMethods', otherGym);
  payments.recordPaymentMethod({ id: extra.processorId, customerId: customerId!, brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
  payments.setBillingDetails(extra.processorId, { email: 'payer@example.invalid', name: 'Second card holder' });
  const jobs = new PostgresJobs({ database, clock });
  await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
  const [queued] = await jobPayload(jobs, customerId), payload = queued!.payload as { paymentMethodIds: string[] };
  expect(payload.paymentMethodIds.sort()).toEqual([card.processorId, extra.processorId].sort());
  expect(payload.paymentMethodIds).not.toContain(revoked.processorId);
  expect(payload.paymentMethodIds).not.toContain(foreign.processorId);
  await handler(payments).run(payload);
  expect(payments.billingDetails(extra.processorId)).toEqual({ email: null, name: 'Second card holder' });
  const stored = await database.forGym(gymId, tx => tx.select().from(households).where(eq(households.id, home.id)));
  expect(stored[0]!.email).toBe('replacement@example.invalid');
});

it('recovers an exhausted email clear in the daily sweep, scoped to its gym, then audits completion', async () => {
  const { home, person, customerId, payments } = await fixture();
  const jobs = new PostgresJobs({ database, clock });
  await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
  const [queued] = await jobPayload(jobs, customerId);
  const exhausted = await database.forGym(gymId, tx => tx.update(jobRows).set({ status: 'failed', attempts: 12,
    runAt: new Date(clock.now().getTime() - billingEmailResetDelayMs) })
    .where(and(eq(jobRows.name, clearBillingEmailJob), eq(jobRows.idempotencyKey, queued!.key!))).returning({ id: jobRows.id }));
  expect(exhausted).toHaveLength(1);
  expect(await queueEarlierRedactions({ gymId: otherGym, timezone: 'UTC', jobs, clock, scope: database.forGym })).toBe(0);
  const daily = createErasureJobs({ jobs, scope: database.forGym }).find(job => job.id === redactEarlierJob)!;
  await daily.handler({}, { gymId, timezone: 'UTC', jobId: 'daily', attempt: 1, clock });
  const [retried] = await database.forGym(gymId, tx => tx.select().from(jobRows).where(eq(jobRows.id, exhausted[0]!.id)));
  expect(retried).toMatchObject({ status: 'pending', attempts: 0 });
  expect(await queueEarlierRedactions({ gymId, timezone: 'UTC', jobs, clock, scope: database.forGym })).toBe(0);
  await handler(payments).run(queued!.payload);
  const completed = await database.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailClearedAction), eq(auditEvents.targetId, home.id))));
  expect(completed).toHaveLength(1);
  expect(completed[0]!.occurredAt).toEqual(clock.now());
  // Even a stale failed queue row must not revive an operation whose provider clear completed.
  await database.forGym(gymId, tx => tx.update(jobRows).set({ status: 'failed', attempts: 12 }).where(eq(jobRows.id, exhausted[0]!.id)));
  expect(await queueEarlierRedactions({ gymId, timezone: 'UTC', jobs, clock, scope: database.forGym })).toBe(0);
});

it('fails closed and rolls erasure back when its HMAC secret is missing', async () => {
  const { person } = await fixture();
  await expect(createMembersService({ scope: database.forGym, clock }).eraseMember(context, person.id, { revision: 1 },
    { jobs: new FakeJobs(clock), timezone: 'UTC' })).rejects.toMatchObject({ code: 'unavailable' });
  expect((await service.getMember(gymId, person.id)).anonymizedAt).toBeNull();
});

it('backs off exhausted email clears exponentially, caps resets and stops selecting abandoned markers', async () => {
  const { person, customerId, home } = await fixture();
  const recoveryClock = new TestClock(clock.now()), jobs = new PostgresJobs({ database, clock: recoveryClock });
  await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
  const [queued] = await jobPayload(jobs, customerId);
  const sweep = () => queueEarlierRedactions({ gymId, timezone: 'UTC', jobs, clock: recoveryClock, scope: database.forGym });
  const fail = () => database.forGym(gymId, tx => tx.update(jobRows).set({ status: 'failed', attempts: 12, runAt: recoveryClock.now() })
    .where(eq(jobRows.idempotencyKey, queued!.key!)));
  for (let reset = 0; reset < billingEmailMaxResets; reset++) {
    await fail();
    recoveryClock.advance(billingEmailResetDelayMs * 2 ** reset - 1);
    expect(await sweep()).toBe(0);
    recoveryClock.advance(1);
    expect(await sweep()).toBe(1);
    const [row] = await database.forGym(gymId, tx => tx.select().from(jobRows).where(eq(jobRows.idempotencyKey, queued!.key!)));
    expect(row).toMatchObject({ status: 'pending', attempts: 0, runAt: recoveryClock.now() });
  }
  await fail();
  expect(await sweep()).toBe(0);
  const resets = await database.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, billingEmailResetAction)));
  const own = resets.filter(row => (row.after as { erasure: string }).erasure === (queued!.payload as { erasureId: string }).erasureId);
  expect(own).toHaveLength(billingEmailMaxResets);
  const abandoned = await database.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, billingEmailAbandonedAction)));
  expect(abandoned.some(row => (row.after as { erasure: string }).erasure === (queued!.payload as { erasureId: string }).erasureId)).toBe(true);
  expect((await database.forGym(gymId, tx => billingEmailErasuresToRetry(tx, gymId, 1000))).some(row => row.householdId === home.id)).toBe(false);
  recoveryClock.advance(100 * billingEmailResetDelayMs);
  expect(await sweep()).toBe(0);
});

it('resolves skipped and pruned job markers without hiding a no-match run from recovery', async () => {
  const cases = await Promise.all([fixture(), fixture(), fixture()]);
  const jobs = new PostgresJobs({ database, clock });
  const payloads: { householdId: string; erasureId: string; emailDigest: string }[] = [];
  for (const item of cases) {
    await service.eraseMember(context, item.person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    payloads.push((await jobPayload(jobs, item.customerId))[0]!.payload as typeof payloads[number]);
  }
  const [skipped, pruned, noMatch] = cases;
  await database.forGym(gymId, tx => tx.update(households).set({ stripeCustomerId: null }).where(eq(households.id, skipped!.home.id)));
  await handler(skipped!.payments).run(payloads[0]);
  expect(await database.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailSkippedAction),
    eq(auditEvents.targetId, skipped!.home.id))))).toHaveLength(1);
  const [prunedJob] = await jobPayload(jobs, pruned!.customerId);
  await database.forGym(gymId, tx => tx.delete(jobRows).where(eq(jobRows.idempotencyKey, prunedJob!.key!)));
  // A rotated HMAC key cannot prove the queued digest matched. This must not write a cleared marker.
  await handler(noMatch!.payments).run({ ...payloads[2], emailDigest: billingEmailDigest('payer@example.invalid', 'rotated-secret') });
  expect(await database.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailNoMatchAction),
    eq(auditEvents.targetId, noMatch!.home.id))))).toHaveLength(1);
  expect(await database.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailClearedAction),
    eq(auditEvents.targetId, noMatch!.home.id))))).toHaveLength(0);
  await queueEarlierRedactions({ gymId, timezone: 'UTC', jobs, clock, scope: database.forGym });
  expect(await database.forGym(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, billingEmailMissingAction),
    eq(auditEvents.targetId, pruned!.home.id))))).toHaveLength(1);
  const pending = await database.forGym(gymId, tx => billingEmailErasuresToRetry(tx, gymId, 1000));
  expect(pending.some(row => row.householdId === skipped!.home.id || row.householdId === pruned!.home.id)).toBe(false);
  expect(pending.some(row => row.householdId === noMatch!.home.id)).toBe(true);
  expect(noMatch!.payments.customer(noMatch!.customerId!)!.email).toBe('payer@example.invalid');
});
