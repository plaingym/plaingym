// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { emailDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { commandDigest, createEmailDeliveries, DeliveryError, FakeEmail, recipientDigest } from './index.js';
import { emailInFlightMs } from './deliveries.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7(), clock = new TestClock('2026-11-06T12:00:00Z');
const deliveries = createEmailDeliveries({ scope: database.forGym, clock });
const message = { to: 'payer@example.test', subject: 'Link', html: '<p>Link</p>', text: 'Link' };
const digest = commandDigest(['request']);
const replay = (gymId: string, key: string, requestDigest = digest) =>
  database.forGym(gymId, tx => deliveries.replay(tx, gymId, key, requestDigest));
async function reserve(key: string, result: unknown = { linkId: 'first' }) {
  return database.forGym(gymA, async tx => {
    const reservation = await deliveries.reserve(tx, gymA, key, digest);
    await deliveries.remember(tx, reservation, result);
    return reservation;
  });
}
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });

describe('send commands', () => {
  it('finds nothing for a new command and replays an accepted one without sending', async () => {
    const key = 'test.command:' + uuidv7(), email = new FakeEmail();
    expect(await replay(gymA, key)).toBeUndefined();
    await deliveries.attempt(await reserve(key), email, message);
    expect(await replay(gymA, key)).toEqual({ result: { linkId: 'first' } });
    expect(email.messages).toHaveLength(1);
  });
  it('rolls the reservation back with the transaction that issues the credential', async () => {
    const key = 'test.rollback:' + uuidv7();
    await expect(database.forGym(gymA, async tx => {
      await deliveries.reserve(tx, gymA, key, digest);
      throw new Error('Credential refused');
    })).rejects.toThrow('Credential refused');
    expect(await deliveries.state(gymA, key)).toBeUndefined();
  });
  it('treats an attempt in flight as a conflict, and one past the deadline as possibly sent', async () => {
    const key = 'test.flight:' + uuidv7();
    await reserve(key);
    await expect(replay(gymA, key)).rejects.toMatchObject({ code: 'conflict' });
    await expect(reserve(key)).rejects.toMatchObject({ code: 'conflict' });
    clock.advance(emailInFlightMs);
    expect(await replay(gymA, key)).toEqual({ result: { linkId: 'first' } });
    await expect(reserve(key)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('keeps a possibly accepted attempt from running again', async () => {
    const key = 'test.unknown:' + uuidv7(), email = new FakeEmail();
    email.respondNext(new DeliveryError('unknown', 'Reply lost'));
    await expect(deliveries.attempt(await reserve(key), email, message)).rejects.toThrow('Reply lost');
    expect(await replay(gymA, key)).toEqual({ result: { linkId: 'first' } });
  });
  it.each(['refused', 'suppressed', 'released'] as const)('runs a %s attempt again under its key', async outcome => {
    const key = 'test.again:' + uuidv7(), email = new FakeEmail(), first = await reserve(key);
    if (outcome === 'released') await deliveries.release(first);
    else {
      email.respondNext(outcome === 'refused' ? new DeliveryError('not_accepted', 'Refused') : { status: 'suppressed', reason: 'disabled' });
      await deliveries.attempt(first, email, message).catch(() => undefined);
    }
    expect(await replay(gymA, key)).toBeUndefined();
    const second = await reserve(key, { linkId: 'second' });
    expect(second).toMatchObject({ id: first.id, attempts: 2 });
    await deliveries.attempt(second, email, message);
    expect(await replay(gymA, key)).toEqual({ result: { linkId: 'second' } });
    expect((await database.forGym(gymA, tx => tx.select().from(emailDeliveries))).filter(row => row.key === key)).toHaveLength(1);
  });
  it('refuses a generation reused for another request, and a plain key used as a command', async () => {
    const key = 'test.reused:' + uuidv7(), plain = 'test.plain:' + uuidv7();
    await deliveries.attempt(await reserve(key), new FakeEmail(), message);
    await expect(replay(gymA, key, commandDigest(['another request']))).rejects.toMatchObject({ code: 'conflict' });
    await deliveries.send(gymA, plain, new FakeEmail(), message);
    await expect(replay(gymA, plain)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('refuses another request that passed replay before a refused attempt could run again', async () => {
    const key = 'test.raced:' + uuidv7();
    await deliveries.release(await reserve(key));
    await expect(database.forGym(gymA, tx => deliveries.reserve(tx, gymA, key, commandDigest(['another request'])))).rejects.toMatchObject({ code: 'conflict' });
    expect(await reserve(key, { linkId: 'second' })).toMatchObject({ attempts: 2 });
  });
  it('keeps a command in its own gym', async () => {
    const key = 'test.gym:' + uuidv7();
    await deliveries.attempt(await reserve(key), new FakeEmail(), message);
    expect(await replay(gymB, key)).toBeUndefined();
  });
  it('hashes addresses after normalizing them and stores no readable address', () => {
    expect(recipientDigest(' Payer@Example.test ')).toBe(recipientDigest('payer@example.test'));
    expect(recipientDigest('payer@example.test')).not.toContain('payer');
  });
});
