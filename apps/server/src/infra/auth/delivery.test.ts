// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { emailDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { createEmailDeliveries, DeliveryError, FakeEmail, type SmtpConfig } from '../email/index.js';
import { createAuthEmailSender } from './delivery.js';

const database = useTestDatabase(), factory = createFactories(database);
const gymId = uuidv7(), clock = new TestClock('2026-11-06T12:00:00Z');
const config: SmtpConfig = { host: 'smtp.example.test', port: 587, security: 'starttls', from: 'desk@example.test' };
const deliveries = createEmailDeliveries({ scope: database.forGym, clock });
function sender() {
  const email = new FakeEmail();
  return { email, send: createAuthEmailSender(async () => config, deliveries, () => email) };
}
const link = () => `https://gym.example.test/api/auth/magic-link/verify?token=${uuidv7()}`;
beforeAll(async () => { await factory('gyms', gymId); });

describe('login link email', () => {
  it('sends one link once, and a new login link again', async () => {
    const { email, send } = sender(), url = link();
    await send({ email: 'coach@example.test', url, gymId });
    await send({ email: 'coach@example.test', url, gymId });
    expect(email.messages).toHaveLength(1);
    await send({ email: 'coach@example.test', url: link(), gymId });
    expect(email.messages).toHaveLength(2);
  });
  it('retries a refused send of the same link and never one that may have been accepted', async () => {
    const { email, send } = sender(), url = link(), uncertain = link();
    email.respondNext(new DeliveryError('not_accepted', 'Connection failed'));
    await expect(send({ email: 'coach@example.test', url, gymId })).rejects.toThrow('Connection failed');
    await send({ email: 'coach@example.test', url, gymId });
    expect(email.messages).toHaveLength(1);
    email.respondNext(new DeliveryError('unknown', 'Reply lost'));
    await expect(send({ email: 'coach@example.test', url: uncertain, gymId })).rejects.toThrow('Reply lost');
    await send({ email: 'coach@example.test', url: uncertain, gymId });
    expect(email.messages).toHaveLength(1);
  });
  it('reports a suppressed send, as the login form did before, and retries it', async () => {
    const { email, send } = sender(), url = link();
    email.respondNext({ status: 'suppressed', reason: 'disabled' });
    await expect(send({ email: 'coach@example.test', url, gymId })).rejects.toThrow('Login email was not delivered');
    await send({ email: 'coach@example.test', url, gymId });
    expect(email.messages).toHaveLength(1);
  });
  it('keeps the credential and the address out of the kept key', async () => {
    const { send } = sender(), token = uuidv7();
    await send({ email: 'private@example.test', url: `https://gym.example.test/verify?token=${token}`, gymId });
    const stored = JSON.stringify(await database.forGym(gymId, tx => tx.select().from(emailDeliveries)));
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('private@example.test');
  });
  it('fails without SMTP before reserving anything', async () => {
    const before = (await database.forGym(gymId, tx => tx.select().from(emailDeliveries))).length;
    const send = createAuthEmailSender(async () => null, deliveries);
    await expect(send({ email: 'coach@example.test', url: link(), gymId })).rejects.toThrow('Login email is not configured');
    expect(await database.forGym(gymId, tx => tx.select().from(emailDeliveries))).toHaveLength(before);
  });
});
