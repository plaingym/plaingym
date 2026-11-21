// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createKeyedCommandDigest } from '../email/index.js';
import { createSmsDeliveries, createSmsPhoneDigest, DeliveryError, FakeSms, type Sms } from './index.js';
import { smsInFlightMs } from './deliveries.js';

const db = useTestDatabase(), make = createFactories(db), gymId = uuidv7(), otherGym = uuidv7();
const clock = new TestClock('2026-11-16T12:00:00Z'), deliveries = createSmsDeliveries({ scope: db.forGym, clock });
const message = { to: '+12025550123', body: 'Private text' }, digest = createKeyedCommandDigest('test-auth-secret')(['sms', message.to]);
beforeAll(async () => { await make('gyms', gymId); await make('gyms', otherGym); });
const reserve = (key: string) => db.forGym(gymId, async tx => {
  const reservation = await deliveries.reserve(tx, gymId, key, digest);
  await deliveries.remember(tx, reservation, { linkId: 'example' }); return reservation;
});
const replay = (key: string, requestDigest = digest) => db.forGym(gymId, tx => deliveries.replay(tx, gymId, key, requestDigest));
it('sends once across accepted retries and isolates the key by gym', async () => {
  const key = 'notice:' + uuidv7(), sms = new FakeSms();
  expect(await deliveries.send(gymId, key, sms, message)).toMatchObject({ status: 'sent' });
  expect(await deliveries.send(gymId, key, sms, message)).toEqual({ status: 'skipped', state: 'accepted' });
  expect(sms.messages).toHaveLength(1);
  expect(await deliveries.state(otherGym, key)).toBeUndefined();
  await deliveries.send(otherGym, key, sms, message); expect(sms.messages).toHaveLength(2);
});
it('never retries unknown delivery or a crashed reservation', async () => {
  const key = 'uncertain:' + uuidv7(), sms = new FakeSms();
  sms.respondNext(new Error(message.to));
  await expect(deliveries.send(gymId, key, sms, message)).rejects.toMatchObject({ acceptance: 'unknown', message: 'SMS delivery failed' });
  expect(await deliveries.send(gymId, key, sms, message)).toEqual({ status: 'skipped', state: 'unknown' });
  const crashed = 'crashed:' + uuidv7(); await reserve(crashed); clock.advance(smsInFlightMs);
  expect(await deliveries.send(gymId, crashed, sms, message)).toEqual({ status: 'skipped', state: 'unknown' });
  expect(await replay(crashed)).toEqual({ result: { linkId: 'example' }, outcome: 'unknown' });
  expect(sms.messages).toEqual([]);
});
it('makes a concurrent reservation conflict without a second provider call', async () => {
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const sms: Sms = { async verifyAccount() {}, async sendSms() { calls++; entered(); await gate; return { status: 'sent', messageId: 'id' }; } };
  const key = 'concurrent:' + uuidv7(), first = deliveries.send(gymId, key, sms, message);
  await started;
  try { await expect(deliveries.send(gymId, key, sms, message)).rejects.toMatchObject({ acceptance: 'not_accepted' }); }
  finally { release(); }
  await first; expect(calls).toBe(1);
});
it.each(['refused', 'suppressed', 'released'] as const)('can retry a proven %s non-send and guards old outcomes by attempt number', async outcome => {
  const key = 'retry:' + uuidv7(), first = await reserve(key), sms = new FakeSms();
  if (outcome === 'released') await deliveries.release(first);
  else {
    sms.respondNext(outcome === 'refused' ? new DeliveryError('not_accepted', 'Safe refusal') : { status: 'suppressed', reason: 'disabled' });
    await deliveries.attempt(first, sms, message).catch(() => undefined);
  }
  expect(await replay(key)).toBeUndefined();
  const second = await reserve(key); expect(second.attempts).toBe(2);
  await deliveries.release(first); expect(await deliveries.state(gymId, key)).toBe('sending');
  await deliveries.attempt(second, sms, message);
  expect(await replay(key)).toEqual({ result: { linkId: 'example' } });
});
it('rolls back a reservation with its credential and rejects another command digest', async () => {
  const key = 'command:' + uuidv7();
  await expect(db.forGym(gymId, async tx => { await deliveries.reserve(tx, gymId, key, digest); throw new Error('rollback'); })).rejects.toThrow('rollback');
  expect(await deliveries.state(gymId, key)).toBeUndefined();
  await reserve(key);
  await expect(replay(key)).rejects.toMatchObject({ code: 'conflict' });
  await expect(replay(key, createKeyedCommandDigest('another-secret')([message.to]))).rejects.toMatchObject({ code: 'conflict' });
});
it.each(['accepted', 'refused', 'unknown', 'suppressed'] as const)('retries only outcome writes for %s', async outcome => {
  const key = 'write:' + uuidv7(), reservation = await reserve(key), sms = new FakeSms();
  if (outcome === 'refused' || outcome === 'unknown') sms.respondNext(new DeliveryError(outcome === 'refused' ? 'not_accepted' : 'unknown', 'Safe error'));
  if (outcome === 'suppressed') sms.respondNext({ status: 'suppressed', reason: 'no_consent' });
  let writes = 0;
  const writer = createSmsDeliveries({ clock, scope: (id, fn) => db.forGym(id, async tx => {
    const result = await fn(tx); if (++writes < 3) throw Object.assign(new Error('rollback'), { code: '40001' }); return result;
  }) });
  await writer.attempt(reservation, sms, message).catch(() => undefined);
  expect(writes).toBe(3); expect(sms.messages).toHaveLength(outcome === 'accepted' ? 1 : 0);
  expect(await deliveries.state(gymId, key)).toBe(outcome === 'suppressed' || outcome === 'refused' ? 'not_accepted' : outcome);
});
it('tries an outcome write that fails without a transient code only once', async () => {
  const key = 'permanent:' + uuidv7(), reservation = await reserve(key), sms = new FakeSms();
  let writes = 0;
  const broken = createSmsDeliveries({ clock, scope: async () => { writes++; throw new Error('rollback'); } });
  await expect(broken.attempt(reservation, sms, message)).rejects.toMatchObject({ acceptance: 'unknown' });
  expect(writes).toBe(1); expect(sms.messages).toHaveLength(1);
});
it('reports exhausted outcome writes and keeps a possibly sent message unrepeatable', async () => {
  const key = 'lost-write:' + uuidv7(), reservation = await reserve(key), sms = new FakeSms();
  let writes = 0;
  const broken = createSmsDeliveries({ clock, scope: async () => { writes++; throw Object.assign(new Error(message.to), { code: '08006' }); } });
  await expect(broken.attempt(reservation, sms, message)).rejects.toMatchObject({ acceptance: 'unknown' });
  expect(writes).toBe(3); expect(sms.messages).toHaveLength(1);
  clock.advance(smsInFlightMs);
  expect(await deliveries.send(gymId, key, sms, message)).toEqual({ status: 'skipped', state: 'unknown' });
  await expect(broken.release(reservation)).rejects.toThrow('SMS outcome write failed');
});
it('safely retries a lost commit acknowledgement without changing a settled attempt or resending', async () => {
  const key = 'commit-reply:' + uuidv7(), reservation = await reserve(key), sms = new FakeSms();
  let writes = 0;
  const writer = createSmsDeliveries({ clock, scope: async (id, fn) => {
    const result = await db.forGym(id, fn);
    if (++writes === 1) throw Object.assign(new Error('Commit reply lost'), { code: 'CONNECTION_CLOSED' });
    return result;
  } });
  await writer.attempt(reservation, sms, message);
  expect(writes).toBe(2); expect(sms.messages).toHaveLength(1);
  expect(await deliveries.send(gymId, key, sms, message)).toEqual({ status: 'skipped', state: 'accepted' });
});
it('releases a failed builder, validates keys, and stores keyed phone digests only', async () => {
  const key = 'builder:' + uuidv7(), sms = new FakeSms();
  await expect(deliveries.attempt(await reserve(key), sms, () => { throw new Error(message.body); })).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(await deliveries.state(gymId, key)).toBe('not_accepted');
  for (const bad of ['', 'a'.repeat(301), 'notice:' + message.to, 'notice:personal@example.test', 'line\nbreak'])
    await expect(deliveries.send(gymId, bad, sms, message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  const phoneDigest = createSmsPhoneDigest('test-secret')(message.to);
  expect(phoneDigest).not.toContain(message.to); expect(phoneDigest).not.toBe(createSmsPhoneDigest('another-secret')(message.to));
  await deliveries.send(gymId, 'phone:' + phoneDigest, sms, message);
  const rows = await db.forGym(gymId, tx => tx.select().from(smsDeliveries));
  expect(JSON.stringify(rows)).not.toContain(message.to); expect(JSON.stringify(rows)).not.toContain(message.body);
});
