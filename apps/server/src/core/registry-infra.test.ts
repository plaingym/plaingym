// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { runInTransaction, isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from './clock.js';
import { FakeAuth } from '../infra/auth/index.js';
import { FakeEmail } from '../infra/email/index.js';
import { FakeJobs } from '../infra/jobs/index.js';
import {
  FakePayments,
  normalizeChargeOutcome,
  type CreateCharge,
  type CheckoutRequest,
} from '../infra/payments/index.js';
import { FakeUploads, FakeBackupObjectStore } from '../infra/storage/index.js';
import {
  authContract,
  emailContract,
  jobsContract,
  paymentsContract,
  uploadsContract,
  backupContract,
  stream,
  readBytes,
} from './registry-infra-contracts.js';

const initial = '2026-01-01T00:00:00Z';
const charge: CreateCharge = {
  amount: 1500,
  currency: 'usd',
  customerId: 'cus_1',
  paymentMethodId: 'pm_1',
  invoiceId: 'invoice',
  attemptId: 'attempt',
  idempotencyKey: 'invoice:1:create',
};
const checkout: CheckoutRequest = {
  mode: 'payment',
  customerId: 'cus_1',
  amount: 1500,
  currency: 'usd',
  invoiceId: 'invoice',
  successUrl: 'https://gym.invalid/success',
  cancelUrl: 'https://gym.invalid/cancel',
  saveForOffSession: true,
  idempotencyKey: 'checkout:1',
};
const email = { to: 'member@example.test', subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' };
const request = (token: string) =>
  new Request('https://gym.invalid', { headers: { authorization: 'Bearer ' + token } });

authContract('fake auth contract', async () => {
  const auth = new FakeAuth('gym');
  auth.seedSession('own', { gymId: 'gym', userId: 'user' });
  auth.seedSession('foreign', { gymId: 'other', userId: 'user' });
  return { auth, authenticated: request('own'), otherGym: request('foreign'), userId: 'user' };
});
emailContract('fake email contract', async () => new FakeEmail());
jobsContract('fake jobs contract', async () => new FakeJobs(new TestClock(initial)));
paymentsContract('fake payments contract', async () => ({
  payments: new FakePayments('gym', new TestClock(initial)),
  charge,
  checkout,
}));
uploadsContract('fake uploads contract', async () => new FakeUploads('gym', new TestClock(initial)));
backupContract('fake backups contract', async () => new FakeBackupObjectStore(new TestClock(initial)));

describe('transaction guards', () => {
  const auth = new FakeAuth('gym');
  const mail = new FakeEmail();
  const jobs = new FakeJobs();
  const payments = new FakePayments('gym');
  const uploads = new FakeUploads('gym');
  const backups = new FakeBackupObjectStore();
  const calls: readonly [string, () => Promise<unknown>][] = [
    ['auth.getSession', () => auth.getSession(request('token'))],
    ['email.sendEmail', () => mail.sendEmail(email)],
    ['jobs.enqueue', () => jobs.enqueue('test', {}, { gymId: 'gym', timezone: 'UTC' })],
    ['jobs.runNext', () => jobs.runNext()],
    ['jobs.triggerSchedule', () => jobs.triggerSchedule('test', [], 'day')],
    ['payments.createCharge', () => payments.createCharge(charge)],
    ['payments.confirmCharge', () => payments.confirmCharge('pi', { idempotencyKey: 'confirm' })],
    ['payments.cancelCharge', () => payments.cancelCharge('pi')],
    ['payments.findCharge', () => payments.findCharge({ kind: 'charge', id: 'pi' })],
    ['payments.readPaymentObject', () => payments.readPaymentObject({ kind: 'setup', id: 'seti' })],
    ['payments.listChangesSince', () => payments.listChangesSince(new Date(initial))],
    ['payments.refund', () => payments.refund({ chargeId: 'pi', amount: 1, idempotencyKey: 'refund' })],
    ['payments.createCheckout', () => payments.createCheckout(checkout)],
    ['payments.expireCheckout', () => payments.expireCheckout('cs')],
    ['payments.findCustomerByEmail', () => payments.findCustomerByEmail('a@example.test')],
    ['payments.parseWebhook', () => payments.parseWebhook(new Uint8Array(), '')],
    ['storage.put', () => uploads.put('gym/photo', new Uint8Array(), 'image/png')],
    ['storage.get', () => uploads.get('gym/photo')],
    ['storage.head', () => uploads.head('gym/photo')],
    ['storage.list', () => uploads.list()],
    ['storage.signedUrl', () => uploads.signedUrl('gym/photo', 10)],
    ['storage.markDeleted', () => uploads.markDeleted('gym/photo')],
    ['storage.sweep', () => uploads.sweep({ before: new Date(initial) })],
    ['storage.putObject', () => backups.putObject('snapshot', stream([1]))],
    ['storage.getObject', () => backups.getObject('snapshot')],
    ['storage.headObject', () => backups.headObject('snapshot')],
    ['storage.listObjects', () => backups.listObjects('')],
    ['storage.deleteObject', () => backups.deleteObject('snapshot')],
  ];
  for (const [name, call] of calls) {
    it(`rejects ${name} before work begins`, async () => {
      await runInTransaction(async () => {
        await Promise.resolve();
        await expect(call()).rejects.toThrow(name + ' cannot run inside a transaction');
      });
    });
  }
  it('has no effects after rejected calls', () => {
    expect(mail.messages).toEqual([]);
    expect(jobs.jobs).toEqual([]);
    expect(backups.activeUploads).toBe(0);
  });
});

describe('fake auth and mail controls', () => {
  it('revokes sessions', async () => {
    const auth = new FakeAuth('gym');
    auth.seedSession('token', { gymId: 'gym', userId: 'user' });
    expect(await auth.getSession(request('token'))).toEqual({ userId: 'user' });
    auth.revokeSession('token');
    expect(await auth.getSession(request('token'))).toBeNull();
  });
  it('records only delivered mail and isolates caller mutations', async () => {
    const mail = new FakeEmail();
    mail.respondNext({ status: 'suppressed', reason: 'disabled' });
    expect(await mail.sendEmail(email)).toEqual({ status: 'suppressed', reason: 'disabled' });
    mail.respondNext(new Error('SMTP unavailable'));
    await expect(mail.sendEmail(email)).rejects.toThrow('SMTP unavailable');
    expect(mail.messages).toEqual([]);
    const input = { ...email };
    await mail.sendEmail(input);
    input.subject = 'changed';
    expect(mail.messages[0]?.subject).toBe('Hello');
  });
});

describe('fake jobs and clock', () => {
  it('caps concurrent work per gym without blocking another gym', async () => {
    const jobs = new FakeJobs(new TestClock(initial));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    jobs.handle('work', async (_payload, context) => {
      seen.push(context.gymId);
      if (context.gymId === 'a') await pending;
    });
    for (const gymId of ['a', 'a', 'b']) await jobs.enqueue('work', {}, { gymId, timezone: 'UTC' });
    const first = jobs.runNext();
    await jobs.runNext();
    expect(seen).toEqual(['a', 'b']);
    expect(await jobs.runNext()).toBe(false);
    release();
    await first;
    expect(await jobs.runNext()).toBe(true);
    expect(seen).toEqual(['a', 'b', 'a']);
  });

  it('retries with backoff, preserves gym context, and never wraps a handler in a transaction', async () => {
    const clock = new TestClock(initial);
    const jobs = new FakeJobs(clock);
    const attempts: number[] = [];
    jobs.handle('retry', async (payload, context) => {
      expect(isInTransaction()).toBe(false);
      expect(context.gymId).toBe('gym');
      expect(context.timezone).toBe('America/Vancouver');
      expect(payload).toEqual({ value: 1 });
      attempts.push(context.attempt);
      if (context.attempt < 2) throw new Error('temporary');
    });
    await jobs.enqueue('retry', { value: 1 }, { gymId: 'gym', timezone: 'America/Vancouver' });
    expect(await jobs.runNext()).toBe(true);
    expect(await jobs.runNext()).toBe(false);
    clock.advance(1000);
    expect(await jobs.runNext()).toBe(true);
    expect(attempts).toEqual([1, 2]);
    expect(jobs.jobs[0]?.status).toBe('completed');
  });
  it('claims each job once across concurrent runners, and stops retrying at the limit', async () => {
    const jobs = new FakeJobs(new TestClock(initial));
    let count = 0;
    jobs.handle('once', async () => {
      count++;
      await Promise.resolve();
      throw new Error('failed');
    });
    await jobs.enqueue('once', {}, { gymId: 'gym', timezone: 'UTC', maxAttempts: 1 });
    await Promise.all([jobs.runNext(), jobs.runNext()]);
    expect(count).toBe(1);
    expect(jobs.jobs[0]?.status).toBe('failed');
  });
  it('fans out scheduled occurrences per gym and deduplicates repeated triggers', async () => {
    const jobs = new FakeJobs(new TestClock(initial));
    jobs.schedule('daily', '0 9 * * *', async () => {});
    const gyms = [
      { gymId: 'a', timezone: 'UTC' },
      { gymId: 'b', timezone: 'America/Vancouver' },
    ];
    await jobs.triggerSchedule('daily', gyms, 'day1');
    await jobs.triggerSchedule('daily', gyms, 'day1');
    expect(jobs.jobs.map((job) => job.options.gymId)).toEqual(['a', 'b']);
    expect(() => jobs.handle('daily', async () => {})).toThrow('Duplicate');
    expect(() => jobs.schedule('invalid', 'not cron', async () => {})).toThrow('five-field');
  });
  it('returns defensive dates and rejects invalid time', () => {
    const clock = new TestClock(initial);
    clock.now().setUTCFullYear(1990);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(1000);
    expect(clock.now().getUTCSeconds()).toBe(1);
    clock.set('2026-02-01');
    expect(clock.now().getUTCMonth()).toBe(1);
    expect(() => clock.set('bad')).toThrow();
    expect(() => clock.advance(Infinity)).toThrow();
  });
});

describe('fake payment outcomes', () => {
  for (const [response, expected] of [
    ['declined', 'failed'],
    ['authentication_required', 'action_required'],
    ['pending', 'pending'],
  ] as const)
    it(`models ${response}`, async () => {
      const payments = new FakePayments('gym', new TestClock(initial));
      const { id } = await payments.createCharge(charge);
      payments.respondNextConfirmation(response);
      expect(await payments.confirmCharge(id, { idempotencyKey: 'confirm' })).toMatchObject({
        status: expected,
      });
      expect(await payments.findCharge({ kind: 'charge', id })).toMatchObject({ status: expected });
    });
  it('normalizes SCA from thrown errors and last_payment_error, including requires_payment_method', async () => {
    const identity = {
      id: 'pi',
      amount: 100,
      currency: 'usd',
      customerId: 'cus',
      metadata: { gymId: 'gym' },
    };
    for (const status of ['requires_action', 'requires_payment_method', 'processing']) {
      expect(
        normalizeChargeOutcome({
          ...identity,
          status,
          last_payment_error: { code: 'authentication_required' },
        }),
      ).toMatchObject({ status: 'action_required', code: 'authentication_required' });
      expect(
        normalizeChargeOutcome(
          { ...identity, status },
          { raw: { payment_intent: { last_payment_error: { code: 'authentication_required' } } } },
        ),
      ).toMatchObject({ status: 'action_required' });
    }
    expect(
      normalizeChargeOutcome({ ...identity, status: 'succeeded' }, { code: 'authentication_required' }),
    ).toMatchObject({ status: 'succeeded' });
    expect(
      normalizeChargeOutcome({
        ...identity,
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined' },
      }),
    ).toMatchObject({ status: 'failed' });
    expect(normalizeChargeOutcome({ ...identity, status: 'requires_payment_method' })).toMatchObject({
      status: 'pending',
    });
    const payments = new FakePayments('gym');
    const { id } = await payments.createCharge(charge);
    payments.respondNextConfirmation({ error: { code: 'authentication_required' } });
    expect(await payments.confirmCharge(id, { idempotencyKey: 'confirm' })).toMatchObject({
      status: 'action_required',
    });
  });
  it('reconciles a lost confirmation response without creating another charge', async () => {
    const payments = new FakePayments('gym', new TestClock(initial));
    const { id } = await payments.createCharge(charge);
    payments.loseNextResponse('confirmCharge');
    await expect(payments.confirmCharge(id, { idempotencyKey: 'confirm' })).rejects.toThrow('response lost');
    expect(await payments.findCharge({ kind: 'charge', id })).toMatchObject({ status: 'succeeded' });
    expect(await payments.confirmCharge(id, { idempotencyKey: 'confirm' })).toMatchObject({
      status: 'succeeded',
    });
    expect(
      new Set(
        (await payments.listChangesSince(new Date(initial))).changes
          .filter((change) => change.kind === 'charge' && change.object.status !== 'unknown')
          .map((change) => ('id' in change.object ? change.object.id : '')),
      ),
    ).toEqual(new Set([id]));
  });
  it('models expired idempotency keys, parameter mismatch, and cancellation before confirmation', async () => {
    const clock = new TestClock(initial);
    const payments = new FakePayments('gym', clock);
    const first = await payments.createCharge(charge);
    await expect(payments.createCharge({ ...charge, amount: 10 })).rejects.toThrow('different parameters');
    expect(await payments.cancelCharge(first.id)).toMatchObject({ status: 'failed', code: 'canceled' });
    expect(await payments.confirmCharge(first.id, { idempotencyKey: 'confirm' })).toMatchObject({
      status: 'failed',
      code: 'canceled',
    });
    clock.advance(86_400_001);
    expect(await payments.createCharge(charge)).not.toEqual(first);
    payments.setUncertain(first.id);
    expect(await payments.findCharge({ kind: 'charge', id: first.id })).toMatchObject({ status: 'unknown' });
  });
  it('distinguishes all three Checkout expiry outcomes and payment/setup modes', async () => {
    const payments = new FakePayments('gym');
    const open = await payments.createCheckout(checkout);
    payments.setUncertain(open.id);
    expect(await payments.expireCheckout(open.id)).toEqual({ status: 'uncertain' });
    payments.setUncertain(open.id, false);
    payments.completeCheckout(open.id);
    expect(await payments.expireCheckout(open.id)).toMatchObject({ status: 'already_completed' });
    expect(await payments.findCharge({ kind: 'checkout', id: open.id })).toMatchObject({
      status: 'succeeded',
    });
    const expired = await payments.createCheckout({ ...checkout, idempotencyKey: 'expired' });
    await payments.expireCheckout(expired.id);
    expect(() => payments.completeCheckout(expired.id)).toThrow('expired');
    const setup = await payments.createCheckout({ ...checkout, mode: 'setup', idempotencyKey: 'setup' });
    expect(payments.completeCheckout(setup.id).chargeId).toBeUndefined();
    expect(await payments.findCharge({ kind: 'checkout', id: setup.id })).toMatchObject({
      status: 'unknown',
    });
  });
  it('lapses an open Checkout at its requested expiry and keeps the expiry in the idempotent request', async () => {
    const clock = new TestClock(initial), payments = new FakePayments('gym', clock);
    const expiresAt = new Date(clock.now().getTime() + 30 * 60_000), short = { ...checkout, idempotencyKey: 'short', expiresAt };
    const session = await payments.createCheckout(short);
    expect(await payments.createCheckout(short)).toEqual(session);
    await expect(payments.createCheckout({ ...short, expiresAt: new Date(expiresAt.getTime() + 1000) })).rejects.toThrow('different parameters');
    clock.set(expiresAt.toISOString());
    expect(await payments.readPaymentObject({ kind: 'checkout', id: session.id })).toMatchObject({ value: { object: { status: 'expired' } } });
    expect(() => payments.completeCheckout(session.id)).toThrow('expired');
    const unbounded = await payments.createCheckout({ ...checkout, idempotencyKey: 'unbounded' });
    clock.set(new Date(clock.now().getTime() + 86_400_000).toISOString());
    expect(payments.completeCheckout(unbounded.id).status).toBe('complete');
  });
  it('returns current objects for changes, includes refunds/disputes, and paginates beyond 30 days', async () => {
    const clock = new TestClock(initial);
    const payments = new FakePayments('gym', clock);
    const { id } = await payments.createCharge(charge);
    clock.advance(45 * 86_400_000);
    await payments.confirmCharge(id, { idempotencyKey: 'confirm' });
    const refunded = await payments.refund({ chargeId: id, amount: 500, idempotencyKey: 'refund' });
    expect(await payments.refund({ chargeId: id, amount: 500, idempotencyKey: 'refund' })).toEqual(refunded);
    await expect(payments.refund({ chargeId: id, amount: 1100, idempotencyKey: 'too-much' })).rejects.toThrow(
      'exceeds',
    );
    payments.recordDispute({ id: 'dp', chargeId: id, amount: 1000, status: 'open' });
    const first = await payments.listChangesSince(new Date(initial), { limit: 2 });
    expect(first.changes).toHaveLength(2);
    expect(first.changes[0]).toMatchObject({ kind: 'charge', object: { status: 'succeeded' } });
    expect(first.nextCursor).not.toBeNull();
    const second = await payments.listChangesSince(new Date(initial), {
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.changes).toMatchObject([
      { kind: 'refund', object: { chargeId: id } },
      { kind: 'dispute', object: { chargeId: id } },
    ]);
    expect(second.nextCursor).toBeNull();
  });
  it('supports a new customer and re-fetches setup/payment-method objects without trusting event payloads', async () => {
    const payments = new FakePayments('gym');
    const customer = await payments.createCustomer({ email: 'parent@example.test', name: 'Parent', householdId: 'household', idempotencyKey: 'customer' });
    const session = await payments.createCheckout({
      mode: 'setup',
      customerId: customer.id,
      successUrl: 'https://gym.invalid/ok',
      cancelUrl: 'https://gym.invalid/cancel',
      saveForOffSession: true,
      idempotencyKey: 'new-customer',
    });
    const completed = payments.completeCheckout(session.id);
    expect(completed.setupId).toBeDefined();
    expect(completed.paymentMethodId).toBeDefined();
    expect(await payments.readPaymentObject({ kind: 'checkout', id: session.id })).toMatchObject({
      status: 'found',
      value: { kind: 'checkout', object: completed },
    });
    expect(await payments.readPaymentObject({ kind: 'setup', id: completed.setupId! })).toMatchObject({
      status: 'found',
      value: { kind: 'setup', object: { status: 'succeeded', paymentMethodId: completed.paymentMethodId } },
    });
    payments.recordPaymentMethod({
      id: completed.paymentMethodId!,
      customerId: completed.customerId,
      last4: '4242',
      expiresMonth: 1,
      expiresYear: 2035,
    });
    expect(
      await payments.readPaymentObject({ kind: 'payment_method', id: completed.paymentMethodId! }),
    ).toMatchObject({ status: 'found', value: { object: { expiresYear: 2035 } } });
    expect(await payments.findCustomerByEmail('parent@example.test')).toEqual([
      { id: completed.customerId, email: 'parent@example.test' },
    ]);
    expect(await payments.readPaymentObject({ kind: 'setup', id: 'missing' })).toMatchObject({
      status: 'unknown',
    });
  });
  it('matches all customer candidates and verifies signed raw webhook bytes and gym metadata', async () => {
    const payments = new FakePayments('gym');
    payments.seedCustomer({ id: 'cus_1', email: 'A@example.test' });
    payments.seedCustomer({ id: 'cus_2', email: 'a@example.test' });
    expect(await payments.findCustomerByEmail('a@example.test')).toHaveLength(2);
    const event = {
      id: 'event',
      type: 'payment_intent.succeeded',
      gymId: 'gym',
      objectId: 'pi',
      objectKind: 'charge',
    };
    const body = new TextEncoder().encode(JSON.stringify(event));
    expect(await payments.parseWebhook(body, payments.signWebhook(body))).toEqual(event);
    await expect(payments.parseWebhook(body, 'invalid')).rejects.toThrow('signature');
    const foreign = new TextEncoder().encode(JSON.stringify({ ...event, gymId: 'other' }));
    await expect(payments.parseWebhook(foreign, payments.signWebhook(foreign))).rejects.toThrow(
      'Invalid payment event',
    );
  });
});

describe('fake storage failure controls', () => {
  it('does not leak a multipart reservation when the source stream is already locked', async () => {
    const store = new FakeBackupObjectStore();
    const body = stream([1]);
    const reader = body.getReader();
    await expect(store.putObject('locked', body)).rejects.toThrow();
    expect(store.activeUploads).toBe(0);
    reader.releaseLock();
    await store.putObject('locked', body);
    expect(await store.headObject('locked')).toMatchObject({ size: 1 });
  });

  it('splits streamed chunks into fixed-size parts and aborts an injected part failure', async () => {
    const store = new FakeBackupObjectStore(new TestClock(initial));
    await store.putObject('existing', stream([1]), { partSize: 2 });
    await store.putObject('parts', stream([1, 2, 3, 4, 5]), { partSize: 2 });
    expect(store.uploadedPartSizes('parts')).toEqual([2, 2, 1]);
    store.failAtPart(2);
    await expect(store.putObject('existing', stream([9, 9, 9]), { partSize: 2 })).rejects.toThrow(
      'multipart',
    );
    expect(await readBytes(await store.getObject('existing'))).toEqual([1]);
    expect(store.activeUploads).toBe(0);
    expect(store.abortedUploads).toEqual(['existing']);
  });
  it('reserves an upload key before reading a slow stream', async () => {
    const store = new FakeUploads('gym');
    let finish!: () => void;
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        };
      },
    });
    const pending = store.put('gym/photo', slow, 'image/png');
    await expect(store.put('gym/photo', new Uint8Array([2]), 'image/png')).rejects.toThrow('immutable');
    finish();
    await pending;
  });
});
