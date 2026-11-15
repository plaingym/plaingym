// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { createEmailDeliveries, DeliveryError, FakeEmail } from './index.js';
import { emailInFlightMs } from './deliveries.js';

const db = useTestDatabase(), factory = createFactories(db), gymId = uuidv7();
const clock = new TestClock('2026-11-06T12:00:00Z'), deliveries = createEmailDeliveries({ scope: db.forGym, clock });
const message = { to: 'payer@example.test', subject: 'Notice', html: '<p>Notice</p>', text: 'Notice' };
beforeAll(async () => { await factory('gyms', gymId); });
const reserve = (key: string) => db.forGym(gymId, async tx => {
  const reservation = await deliveries.reserve(tx, gymId, key);
  if (!reservation) throw new Error('Expected a fresh reservation');
  return reservation;
});

it.each(['refused', 'suppressed', 'accepted', 'unknown'] as const)('retries two failed %s outcome transactions without retrying SMTP', async outcome => {
  const key = 'test.outcome:' + uuidv7(), reservation = await reserve(key), email = new FakeEmail();
  const failure = new DeliveryError(outcome === 'refused' ? 'not_accepted' : 'unknown', 'Transport failed');
  if (outcome === 'refused' || outcome === 'unknown') email.respondNext(failure);
  if (outcome === 'suppressed') email.respondNext({ status: 'suppressed', reason: 'disabled' });
  let writes = 0;
  const writer = createEmailDeliveries({ clock, scope: (id, fn) => db.forGym(id, async tx => {
    const result = await fn(tx);
    if (++writes <= 2) throw new Error('Outcome transaction failed');
    return result;
  }) });
  const attempt = writer.attempt(reservation, email, message);
  if (outcome === 'refused' || outcome === 'unknown') await expect(attempt).rejects.toBe(failure);
  else await expect(attempt).resolves.toMatchObject({ status: outcome === 'accepted' ? 'sent' : 'suppressed' });
  expect(writes).toBe(3);
  expect(email.messages).toHaveLength(outcome === 'accepted' ? 1 : 0);
  expect(await deliveries.state(gymId, key)).toBe(outcome === 'refused' || outcome === 'suppressed' ? 'not_accepted' : outcome);
  const retried = await deliveries.send(gymId, key, email, message);
  if (outcome === 'refused' || outcome === 'suppressed') expect(retried.status).toBe('sent');
  else expect(retried).toEqual({ status: 'skipped', state: outcome });
  expect(email.messages).toHaveLength(outcome === 'unknown' ? 0 : 1);
});

it.each(['not_accepted', 'unknown'] as const)('bounds failed writes and retains both %s transport and write errors', async acceptance => {
  const key = 'test.exhausted:' + uuidv7(), reservation = await reserve(key), email = new FakeEmail();
  const transportError = new DeliveryError(acceptance, 'Transport failed'), writeError = new Error('Database unavailable');
  email.respondNext(transportError);
  let writes = 0;
  const writer = createEmailDeliveries({ clock, scope: async () => { writes++; throw writeError; } });
  await expect(writer.attempt(reservation, email, message)).rejects.toMatchObject({ acceptance,
    cause: { errors: [transportError, writeError] } });
  expect(writes).toBe(3);
  expect(email.messages).toHaveLength(0);
  clock.advance(emailInFlightMs);
  expect(await deliveries.send(gymId, key, email, message)).toEqual({ status: 'skipped', state: 'unknown' });
});

it('retries a lost outcome commit reply without overwriting the committed acceptance', async () => {
  const key = 'test.commit-reply:' + uuidv7(), reservation = await reserve(key), email = new FakeEmail();
  let writes = 0;
  const writer = createEmailDeliveries({ clock, scope: async (id, fn) => {
    const result = await db.forGym(id, fn);
    if (++writes <= 2) throw new Error('Commit reply lost');
    return result;
  } });
  await writer.attempt(reservation, email, message);
  expect(writes).toBe(3);
  expect(await deliveries.send(gymId, key, email, message)).toEqual({ status: 'skipped', state: 'accepted' });
  expect(email.messages).toHaveLength(1);
});

it('retries a failed release and preserves both errors if building and release fail', async () => {
  const key = 'test.builder-release:' + uuidv7(), reservation = await reserve(key);
  const buildError = new Error('Rendering failed'), writeError = new Error('Database unavailable');
  let writes = 0;
  const writer = createEmailDeliveries({ clock, scope: async () => { writes++; throw writeError; } });
  await expect(writer.attempt(reservation, new FakeEmail(), () => { throw buildError; })).rejects.toMatchObject({
    acceptance: 'not_accepted', cause: { errors: [buildError, writeError] },
  });
  expect(writes).toBe(3);
  await deliveries.release(reservation);
  expect(await deliveries.state(gymId, key)).toBe('not_accepted');
});
