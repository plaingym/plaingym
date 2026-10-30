// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { createEmailDeliveries, DeliveryError, FakeEmail, SmtpEmail, type Email } from './index.js';
import { emailInFlightMs } from './deliveries.js';
import { captureSmtp } from './test-smtp.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7(), clock = new TestClock('2026-10-29T12:00:00Z');
const deliveries = createEmailDeliveries({ scope: database.forGym, clock });
const message = { to: 'owner@example.test', subject: 'Notice', html: '<p>Notice</p>', text: 'Notice' };
let capture: Awaited<ReturnType<typeof captureSmtp>>, smtp: SmtpEmail;
const rows = (gymId: string) => database.forGym(gymId, tx => tx.select().from(emailDeliveries));
beforeAll(async () => {
  capture = await captureSmtp();
  smtp = new SmtpEmail({ host: '127.0.0.1', port: capture.port, security: 'plain', from: 'desk@example.test' });
  await factory('gyms', gymA);
  await factory('gyms', gymB);
});
afterAll(async () => { smtp?.close(); await capture?.close(); });

describe('durable email send state', () => {
  it('never resends after SMTP accepted, even when the caller failed afterwards and retried', async () => {
    const key = 'test.accepted:' + uuidv7(), before = capture.messages.length;
    expect(await deliveries.send(gymA, key, smtp, message)).toMatchObject({ status: 'sent' });
    // The job fails after this point (for example its audit write) and the queue runs it again.
    expect(await deliveries.send(gymA, key, smtp, message)).toEqual({ status: 'skipped', state: 'accepted' });
    expect(capture.messages).toHaveLength(before + 1);
    expect(await deliveries.state(gymA, key)).toBe('accepted');
    expect((await rows(gymA)).find(row => row.key === key)).toMatchObject({ state: 'accepted', attempts: 1, gymId: gymA });
  });

  it('records a partial acceptance as unknown and never resends it', async () => {
    const key = 'test.partial:' + uuidv7(), before = capture.messages.length;
    capture.rejectRecipient('second@example.test');
    try {
      await expect(deliveries.send(gymA, key, smtp, { ...message, to: 'owner@example.test, second@example.test' }))
        .rejects.toMatchObject({ acceptance: 'unknown' });
    } finally { capture.rejectRecipient(false); }
    expect(await deliveries.send(gymA, key, smtp, { ...message, to: 'owner@example.test, second@example.test' }))
      .toEqual({ status: 'skipped', state: 'unknown' });
    expect(capture.messages).toHaveLength(before + 1);
  });

  it('records a lost acknowledgement as unknown and never resends it', async () => {
    const key = 'test.lost:' + uuidv7(), before = capture.messages.length;
    capture.loseReply(true);
    try { await expect(deliveries.send(gymA, key, smtp, message)).rejects.toMatchObject({ acceptance: 'unknown' }); }
    finally { capture.loseReply(false); }
    expect(await deliveries.send(gymA, key, smtp, message)).toEqual({ status: 'skipped', state: 'unknown' });
    expect(capture.messages).toHaveLength(before + 1);
  });

  it('retries a definite non-send and records the later acceptance', async () => {
    const key = 'test.refused:' + uuidv7(), before = capture.messages.length;
    capture.rejectRecipient(true);
    try { await expect(deliveries.send(gymA, key, smtp, message)).rejects.toMatchObject({ acceptance: 'not_accepted' }); }
    finally { capture.rejectRecipient(false); }
    expect(await deliveries.state(gymA, key)).toBe('not_accepted');
    expect(await deliveries.send(gymA, key, smtp, message)).toMatchObject({ status: 'sent' });
    expect(capture.messages).toHaveLength(before + 1);
    expect((await rows(gymA)).find(row => row.key === key)).toMatchObject({ state: 'accepted', attempts: 2 });
  });

  it('treats a suppressed result as not accepted and an unclassified error as unknown', async () => {
    const fake = new FakeEmail(), suppressed = 'test.suppressed:' + uuidv7(), failed = 'test.unclassified:' + uuidv7();
    fake.respondNext({ status: 'suppressed', reason: 'opt_out' });
    expect(await deliveries.send(gymA, suppressed, fake, message)).toEqual({ status: 'suppressed', reason: 'opt_out' });
    expect(await deliveries.state(gymA, suppressed)).toBe('not_accepted');
    fake.respondNext(new Error('transport crashed'));
    await expect(deliveries.send(gymA, failed, fake, message)).rejects.toThrow('transport crashed');
    expect(await deliveries.send(gymA, failed, fake, message)).toEqual({ status: 'skipped', state: 'unknown' });
    expect(fake.messages).toHaveLength(0);
  });

  it('reserves before sending, so a concurrent attempt waits for the outcome instead of sending or skipping', async () => {
    const key = 'test.concurrent:' + uuidv7();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    let sends = 0;
    const slow: Email = { async sendEmail() {
      sends++; entered(); await gate; throw new DeliveryError('not_accepted', 'SMTP connection failed');
    } };
    const first = deliveries.send(gymA, key, slow, message);
    await started;
    // A lease-retried worker sees the reservation in flight: it sent nothing, and its job retries later.
    expect(await deliveries.state(gymA, key)).toBe('sending');
    await expect(deliveries.send(gymA, key, slow, message)).rejects.toMatchObject({ acceptance: 'not_accepted',
      message: 'Another attempt is sending this email' });
    release();
    await expect(first).rejects.toMatchObject({ acceptance: 'not_accepted' });
    // The first attempt proved a non-send, so the retry may send.
    expect(await deliveries.send(gymA, key, new FakeEmail(), message)).toMatchObject({ status: 'sent' });
    expect(sends).toBe(1);
  });

  it('counts a reservation whose worker died in flight as unknown once the in-flight window passes', async () => {
    const key = 'test.crashed:' + uuidv7(), fake = new FakeEmail();
    await database.forGym(gymA, tx => tx.insert(emailDeliveries).values({ gymId: gymA, key, state: 'sending',
      updatedAt: new Date(clock.now().getTime() - emailInFlightMs) }));
    expect(await deliveries.state(gymA, key)).toBe('unknown');
    expect(await deliveries.send(gymA, key, fake, message)).toEqual({ status: 'skipped', state: 'unknown' });
    expect(fake.messages).toHaveLength(0);
  });

  it('keeps each gym\'s send state separate under row-level security', async () => {
    const key = 'test.shared-key:' + uuidv7(), fake = new FakeEmail();
    await deliveries.send(gymA, key, fake, message);
    expect(await deliveries.state(gymB, key)).toBeUndefined();
    expect(await deliveries.send(gymB, key, fake, message)).toMatchObject({ status: 'sent' });
    expect(fake.messages).toHaveLength(2);
    expect((await rows(gymB)).every(row => row.gymId === gymB)).toBe(true);
    await expect(database.forGym(gymB, tx => tx.insert(emailDeliveries).values({ gymId: gymA, key: 'test.foreign', state: 'accepted',
      updatedAt: clock.now() }))).rejects.toThrow();
  });

  it('reports a failed reservation as a definite non-send and refuses to run inside a transaction', async () => {
    const fake = new FakeEmail();
    for (const key of ['', 'x'.repeat(301)])
      await expect(deliveries.send(gymA, key, fake, message)).rejects.toMatchObject({ acceptance: 'not_accepted',
        cause: { message: 'Invalid email delivery key' } });
    const failing = createEmailDeliveries({ clock, scope: async () => { throw new Error('connection reset'); } });
    await expect(failing.send(gymA, 'test.reserve:' + uuidv7(), fake, message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
    expect(fake.messages).toHaveLength(0);
    await database.forGym(gymA, async () => {
      await expect(deliveries.send(gymA, 'test.transaction', new FakeEmail(), message)).rejects.toThrow(/transaction/i);
    });
    expect(new DeliveryError('unknown', 'lost')).toMatchObject({ name: 'DeliveryError', acceptance: 'unknown', code: 'unknown' });
  });
});
