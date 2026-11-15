// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Inspect the durable erasure job to prove it commits and rolls back with the member.
import { auditEvents, households, jobs as jobRows, members, uuidv7, type forGym } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeJobs, PostgresJobs } from '../../infra/jobs/index.js';
import { billingEmailDigest, FakePayments } from '../../infra/payments/index.js';
import { createMembersService } from './members.js';
import { createErasureJobs } from './members.routes.js';
import { clearBillingEmailJob } from './erasure-redaction.js';

const database = useTestDatabase(), factory = createFactories(database), gymId = uuidv7(), otherGym = uuidv7();
const clock = new TestClock('2026-11-14T12:00:00Z');
const context = { gymId, actor: { kind: 'system' as const } };
const service = createMembersService({ scope: database.forGym, clock });
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
    await payments.clearCustomerEmail(customerId, options);
  });
  const job = createErasureJobs({ clearBillingEmail: clear, scope: database.forGym }).find(job => job.id === clearBillingEmailJob)!;
  return { clear, run: (payload: unknown, gym = gymId) => job.handler(payload, { gymId: gym, jobId: 'clear-email', timezone: 'UTC', attempt: 1, clock }) };
}

describe.each(['fake', 'postgres'] as const)('%s payer email erasure', kind => {
  const queue = () => kind === 'fake' ? new FakeJobs(clock) : new PostgresJobs({ database, clock });
  it('queues once, audits the email clear and runs idempotently without erasing the remaining household', async () => {
    const { home, person, remaining, customerId, card, payments } = await fixture(), jobs = queue();
    const result = await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    const expected = { householdId: home.id, customerId, paymentMethodId: card.processorId, emailDigest: billingEmailDigest('payer@example.invalid') };
    expect(await jobPayload(jobs, customerId)).toEqual([{ payload: expected,
      key: kind === 'fake' ? `clear-billing-email:${person.id}` : expect.stringMatching(/^[a-f0-9]{64}$/), attempts: 12 }]);
    expect(JSON.stringify(await jobPayload(jobs, customerId))).not.toContain('payer@example.invalid');
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
    // Another erased member still leaves a third member, but the household has no erased address to clear again.
    await factory('members', gymId, { householdId: home.id });
    await service.eraseMember(context, remaining.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    expect(await jobPayload(jobs, customerId)).toHaveLength(1);
  });
  it.each(['remaining@example.invalid', null])('queues nothing for a different or absent household email: %s', async email => {
    const { home, person, customerId } = await fixture(email), jobs = queue();
    await service.eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    expect(await jobPayload(jobs, customerId)).toEqual([]);
    const [audit] = await database.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, home.id)));
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
    await expect(createMembersService({ scope, clock }).eraseMember(context, person.id, { revision: 1 }, { jobs, timezone: 'UTC' })).rejects.toThrow('fail before commit');
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
  expect(queued!.payload).toMatchObject({ paymentMethodId: card.processorId });
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
  const failing = createErasureJobs({ clearBillingEmail: clear, scope: database.forGym }).find(job => job.id === clearBillingEmailJob)!;
  await expect(failing.handler(payload, ctx)).rejects.toThrow('provider unavailable');
  await expect(createErasureJobs({}).find(job => job.id === clearBillingEmailJob)!.handler(payload, ctx)).rejects.toThrow('not configured');
});
