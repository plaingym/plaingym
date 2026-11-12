// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authUser, uuidv7 } from '@plaingym/db';
import { closeDatabase, initializeDatabase } from '@plaingym/db/client';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { createPortalInvitationService } from '../../areas/members/household-users.invitations.js';
import { authConfig } from './config.js';
import { DeliveryError, FakeEmail } from '../email/index.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-06T12:00:00Z');
const base = authConfig({ AUTH_SECRET: 'portal-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false);
const config = { ...base, tenancy: 'multi' as const, passwordEnabled: false, passwordMode: 'off' as const, smtpConfigured: true };
const origin = 'https://gym.example.test';
beforeAll(() => initializeDatabase(db.appUrl));
afterAll(() => closeDatabase());
async function fixture() {
  const gymId = uuidv7(), fake = new FakeEmail(), logins: unknown[] = [];
  await factory('gyms', gymId);
  const owner = await factory('staffRoles', gymId, { role: 'owner' }), coach = await factory('staffRoles', gymId, { role: 'coach' });
  const home = await factory('households', gymId);
  const service = createPortalInvitationService({ config, database: () => db.system.db, scope: db.forGym, householdScope: db.forHousehold,
    smtpConfigured: async () => true, mailer: async () => fake, loginLink: async input => { logins.push(input); } });
  const email = uuidv7() + '@example.test', actor = { gymId, userId: owner.userId, clock };
  const request = (sendGeneration: string = uuidv7(), address = email) => ({ email: address, scope: 'payer' as const, delivery: 'email' as const, sendGeneration });
  const tokenIn = (index: number) => /#([a-f0-9]{64})/.exec(fake.messages[index]!.text)![1]!;
  const accept = (token: string) => service.accept(gymId, { token }, clock);
  return { gymId, fake, owner, coach, home, service, email, actor, request, tokenIn, accept };
}

describe('portal invitation send commands', () => {
  it('a replay sends no second email and leaves the emailed link working', async () => {
    const f = await fixture(), generation = uuidv7(), first = await f.service.invite(f.actor, f.home.id, f.request(generation), origin);
    expect(await f.service.invite(f.actor, f.home.id, f.request(generation), origin)).toEqual(first);
    expect(f.fake.messages).toHaveLength(1);
    await expect(f.accept(f.tokenIn(0))).resolves.toEqual({ data: { status: 'email_sent' } });
  });
  it('a deliberate resend sends again and replaces the earlier link', async () => {
    const f = await fixture();
    await f.service.invite(f.actor, f.home.id, f.request(), origin);
    await f.service.invite(f.actor, f.home.id, f.request(), origin);
    expect(f.fake.messages).toHaveLength(2);
    await expect(f.accept(f.tokenIn(0))).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.accept(f.tokenIn(1))).resolves.toEqual({ data: { status: 'email_sent' } });
  });
  it('a replay after the invitation was withdrawn issues nothing and provisions no identity', async () => {
    const f = await fixture(), generation = uuidv7(), first = await f.service.invite(f.actor, f.home.id, f.request(generation), origin);
    const [pending] = (await f.service.outstanding(f.actor, f.home.id)).data;
    await f.service.revokeInvitation(f.actor, f.home.id, pending!.id);
    expect(await f.service.invite(f.actor, f.home.id, f.request(generation), origin)).toEqual(first);
    expect((await f.service.outstanding(f.actor, f.home.id)).data).toEqual([]);
    expect(await db.system.db.select().from(authUser).where(eq(authUser.email, f.email))).toEqual([]);
    expect(f.fake.messages).toHaveLength(1);
  });
  it('a possibly accepted attempt is never sent again', async () => {
    const f = await fixture(), generation = uuidv7();
    f.fake.respondNext(new DeliveryError('unknown', 'Reply lost'));
    await expect(f.service.invite(f.actor, f.home.id, f.request(generation), origin)).rejects.toThrow('Reply lost');
    expect(await f.service.invite(f.actor, f.home.id, f.request(generation), origin)).toMatchObject({ data: { delivery: 'email', outcome: 'unknown' } });
    expect(f.fake.messages).toHaveLength(0);
  });
  it.each([
    ['refused', new DeliveryError('not_accepted', 'Refused')],
    ['suppressed', { status: 'suppressed', reason: 'disabled' } as const],
  ])('a %s attempt sends again under its generation', async (_name, failure) => {
    const f = await fixture(), generation = uuidv7();
    f.fake.respondNext(failure);
    await expect(f.service.invite(f.actor, f.home.id, f.request(generation), origin)).rejects.toThrow();
    await f.service.invite(f.actor, f.home.id, f.request(generation), origin);
    expect(f.fake.messages).toHaveLength(1);
    await expect(f.accept(f.tokenIn(0))).resolves.toEqual({ data: { status: 'email_sent' } });
  });
  it('refuses a generation reused for another address, and a replay by someone without portal access', async () => {
    const f = await fixture(), generation = uuidv7();
    await f.service.invite(f.actor, f.home.id, f.request(generation), origin);
    await expect(f.service.invite(f.actor, f.home.id, f.request(generation, uuidv7() + '@example.test'), origin)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.invite({ ...f.actor, userId: f.coach.userId }, f.home.id, f.request(generation), origin)).rejects.toMatchObject({ code: 'not_found' });
    expect(f.fake.messages).toHaveLength(1);
  });
});
