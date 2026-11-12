// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffRoles, uuidv7 } from '@plaingym/db';
import { closeDatabase, initializeDatabase } from '@plaingym/db/client';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { createStaffInvitationService } from '../../areas/staff/profiles.invitations.js';
import { authConfig } from './config.js';
import { DeliveryError, FakeEmail } from '../email/index.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-06T12:00:00Z');
const config = authConfig({ AUTH_SECRET: 'staff-invitation-test-secret-at-least-32-characters', AUTH_PASSWORD_LOGIN: 'on' }, false);
const origin = 'https://gym.example.test', password = 'a-strong-invited-password';
const gymId = uuidv7();
let ownerId: string, coachId: string;
beforeAll(async () => {
  await initializeDatabase(db.appUrl);
  await factory('gyms', gymId);
  ownerId = (await factory('staffRoles', gymId, { role: 'owner' })).userId;
  coachId = (await factory('staffRoles', gymId, { role: 'coach' })).userId;
});
afterAll(() => closeDatabase());
function fixture() {
  const fake = new FakeEmail();
  const service = createStaffInvitationService({ config, database: () => db.system.db, scope: db.forGym,
    smtpConfigured: async () => true, mailer: async () => fake });
  const email = uuidv7() + '@example.test', actor = { gymId, actorUserId: ownerId, clock };
  const request = (sendGeneration: string = uuidv7(), role: 'coach' | 'admin' = 'coach') => ({ email, role, delivery: 'email' as const, sendGeneration });
  const tokenIn = (index: number) => /staff-invitation#([a-f0-9]{64})/.exec(fake.messages[index]!.text)![1]!;
  const accept = (token: string) => service.acceptInvitation(gymId, { token, name: 'New coach', password }, clock);
  return { fake, service, actor, request, tokenIn, accept };
}

describe('staff invitation send commands', () => {
  it('a replay sends no second email and leaves the emailed link working', async () => {
    const f = fixture(), generation = uuidv7(), first = await f.service.inviteStaff(f.actor, f.request(generation), origin);
    expect(await f.service.inviteStaff(f.actor, f.request(generation), origin)).toEqual(first);
    expect(f.fake.messages).toHaveLength(1);
    await expect(f.accept(f.tokenIn(0))).resolves.toEqual({ data: null });
  });
  it('a deliberate resend sends again and replaces the earlier link', async () => {
    const f = fixture();
    await f.service.inviteStaff(f.actor, f.request(), origin);
    await f.service.inviteStaff(f.actor, f.request(), origin);
    expect(f.fake.messages).toHaveLength(2);
    await expect(f.accept(f.tokenIn(0))).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.accept(f.tokenIn(1))).resolves.toEqual({ data: null });
  });
  it('a replay after acceptance returns the first result instead of a conflict', async () => {
    const f = fixture(), generation = uuidv7(), first = await f.service.inviteStaff(f.actor, f.request(generation), origin);
    await f.accept(f.tokenIn(0));
    expect(await f.service.inviteStaff(f.actor, f.request(generation), origin)).toEqual(first);
    expect(f.fake.messages).toHaveLength(1);
  });
  it('a replay after the role was revoked grants nothing', async () => {
    const f = fixture(), generation = uuidv7(), first = await f.service.inviteStaff(f.actor, f.request(generation), origin);
    await db.forGym(gymId, tx => tx.delete(staffRoles).where(eq(staffRoles.id, first.data.staffRole.id)));
    expect(await f.service.inviteStaff(f.actor, f.request(generation), origin)).toEqual(first);
    expect(await db.forGym(gymId, tx => tx.select().from(staffRoles).where(eq(staffRoles.id, first.data.staffRole.id)))).toHaveLength(0);
    expect(await db.forGym(gymId, tx => tx.select().from(staffRoles).where(eq(staffRoles.userId, first.data.staffRole.userId)))).toHaveLength(0);
  });
  it('a possibly accepted attempt is never sent again, and its link stays in force', async () => {
    const f = fixture(), generation = uuidv7();
    f.fake.respondNext(new DeliveryError('unknown', 'Reply lost'));
    await expect(f.service.inviteStaff(f.actor, f.request(generation), origin)).rejects.toThrow('Reply lost');
    expect(await f.service.inviteStaff(f.actor, f.request(generation), origin)).toMatchObject({ data: { delivery: 'email', outcome: 'unknown' } });
    expect(f.fake.messages).toHaveLength(0);
  });
  it.each([
    ['refused', new DeliveryError('not_accepted', 'Refused')],
    ['suppressed', { status: 'suppressed', reason: 'disabled' } as const],
  ])('a %s attempt sends again under its generation', async (_name, failure) => {
    const f = fixture(), generation = uuidv7();
    f.fake.respondNext(failure);
    await expect(f.service.inviteStaff(f.actor, f.request(generation), origin)).rejects.toThrow();
    await f.service.inviteStaff(f.actor, f.request(generation), origin);
    expect(f.fake.messages).toHaveLength(1);
    await expect(f.accept(f.tokenIn(0))).resolves.toEqual({ data: null });
  });
  it('refuses a generation reused for another role, and a replay by someone who can no longer manage staff', async () => {
    const f = fixture(), generation = uuidv7();
    await f.service.inviteStaff(f.actor, f.request(generation), origin);
    await expect(f.service.inviteStaff(f.actor, f.request(generation, 'admin'), origin)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.inviteStaff({ ...f.actor, actorUserId: coachId }, f.request(generation), origin)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.fake.messages).toHaveLength(1);
  });
});
