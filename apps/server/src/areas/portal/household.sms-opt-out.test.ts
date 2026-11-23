// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, members as memberRows, type HouseholdScope } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the default app-role pools the settings accessor reads with; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeSms, MemberSms, SmsDeliveryError } from '../../infra/sms/index.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createMembersService } from '../members/members.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import type { SmsResolver } from '../settings/sms.js';
import { createPortalHouseholdService, type HouseholdQueries } from './household.js';
import { portalFixture } from './household.fixture.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-20T18:00:00Z');
beforeAll(() => initializeDatabase(db.appUrl));
afterAll(closeDatabase);
// The records store the normalized number with the phone, so recording consent is never a number change.
const stored = { phone: '202-555-0123', phoneE164: '+12025550123' };
const staff = createMembersService({ scope: db.forGym, clock });

/** The household boundary, recording every opt-out lookup the portal makes through it. */
function recording() {
  const calls: Parameters<HouseholdQueries['smsOptedOut']>[] = [];
  const scope = (<T>(grant: HouseholdScope, fn: (queries: HouseholdQueries) => Promise<T>) => db.forHousehold(grant, queries =>
    fn({ ...queries, smsOptedOut: (...args) => { calls.push(args); return queries.smsOptedOut(...args); } }))) as typeof db.forHousehold;
  const service = createPortalHouseholdService({ households: createMemberHouseholdContext(db.forGym), householdScope: scope, members: staff, clock });
  return { calls, service };
}

/** A household whose billing phone, payer and child share one number, each with notices consent, until that number replies STOP. */
async function optedOut() {
  const f = await portalFixture(factory, { address: { country: 'US' }, memberSmsEnabled: true, smsDailyCap: 1000 });
  const system = { gymId: f.gymId, actor: { kind: 'system' as const } };
  await db.forGym(f.gymId, async tx => {
    await tx.update(households).set(stored).where(eq(households.id, f.household.id));
    for (const person of [f.payer, f.child]) await tx.update(memberRows).set(stored).where(eq(memberRows.id, person.id));
  });
  await staff.changeHouseholdSmsConsent(system, f.household.id, { consent: true, revision: f.household.revision });
  for (const person of [f.payer, f.child]) await staff.changeMemberSmsConsent(system, person.id, { kind: 'notices', consent: true, revision: person.revision });
  clock.advance(60_000);
  const sms = new FakeSms();
  const resolver: SmsResolver = { async resolve(gym) { return { gymId: gym, name: 'Test Gym', sms }; }, async configured() { return true; },
    async status() { return { source: 'gym', unreadable: false }; } };
  sms.respondNext(new SmsDeliveryError('not_accepted', 'recipient_opted_out'));
  const sender = new MemberSms({ gymId: f.gymId, memberIds: [f.payer.id, f.child.id], householdIds: [f.household.id], kind: 'notices', resolver,
    settings: createGymSettingsAccessor({ scope: db.forGym }), scope: db.forGym, clock, logSuppression: () => undefined });
  await expect(sender.sendSms({ to: stored.phoneE164, body: 'Notice' })).rejects.toMatchObject({ reason: 'recipient_opted_out' });
  const stopAt = clock.now().toISOString();
  clock.advance(60_000);
  const identity = (userId: string, householdId = f.household.id) => ({ gymId: f.gymId, householdId, userId });
  return { f, stopAt, payer: identity(f.payerUser.id), adult: identity(f.adultUser.id), other: identity(f.otherUser.id, f.otherHousehold.id) };
}

it('returns the STOP date on the household, a member and the payer\'s member list, the list through one lookup', async () => {
  const { f, stopAt, payer, adult } = await optedOut(), { calls, service } = recording();
  expect((await service.household(payer)).sms.optedOutAt).toBe(stopAt);
  for (const person of [f.payer, f.child]) expect((await service.profile(payer, person.id)).sms.optedOutAt).toBe(stopAt);
  // A member without a phone has no STOP date and needs no lookup.
  calls.length = 0;
  expect((await service.profile(adult, f.adult.id)).sms.optedOutAt).toBeNull();
  expect(calls).toEqual([]);
  const list = await service.list(payer, { limit: 50, offset: 0 });
  expect(Object.fromEntries(list.data.map(row => [row.id, row.sms.optedOutAt])))
    .toEqual({ [f.payer.id]: stopAt, [f.child.id]: stopAt, [f.adult.id]: null });
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe('member');
  expect([...calls[0]![1]].sort()).toEqual([f.payer.id, f.child.id].sort());
});

it('ends the STOP date when consent is recorded again, for that record only', async () => {
  const { f, stopAt, payer } = await optedOut(), { service } = recording();
  const home = await service.household(payer);
  expect((await service.changeHouseholdSmsConsent(payer, { consent: true, revision: home.revision })).sms.optedOutAt).toBeNull();
  const child = await service.profile(payer, f.child.id);
  const recorded = await service.changeMemberSmsConsent(payer, f.child.id, { kind: 'notices', consent: true, revision: child.revision }, 'UTC');
  expect(recorded.sms.optedOutAt).toBeNull();
  expect((await service.profile(payer, f.payer.id)).sms.optedOutAt).toBe(stopAt);
  expect((await service.household(payer)).sms.optedOutAt).toBeNull();
});

it('never gives another household\'s login a STOP date or a sign the record exists', async () => {
  const { f, payer, adult, other } = await optedOut(), { service } = recording();
  for (const id of [f.payer.id, f.child.id]) await expect(service.profile(other, id)).rejects.toMatchObject({ code: 'not_found' });
  expect((await service.household(other)).sms.optedOutAt).toBeNull();
  expect((await service.list(other, { limit: 50, offset: 0 })).data.map(row => row.id)).toEqual([f.outsider.id]);
  // The lookup itself, with the other household's grant and this household's IDs, finds nothing.
  for (const type of ['member', 'household'] as const) {
    const ids = type === 'member' ? [f.payer.id, f.child.id] : [f.household.id];
    expect((await db.forHousehold({ kind: 'user', ...other }, queries => queries.smsOptedOut(type, ids))).size).toBe(0);
  }
  // The adult non-payer reads no household and no other member of their own household.
  await expect(service.household(adult)).rejects.toMatchObject({ code: 'not_found' });
  await expect(service.profile(adult, f.child.id)).rejects.toMatchObject({ code: 'not_found' });
  expect((await db.forHousehold({ kind: 'user', ...adult }, queries => queries.smsOptedOut('household', [f.household.id]))).size).toBe(0);
  expect((await db.forHousehold({ kind: 'user', ...payer }, queries => queries.smsOptedOut('household', [f.household.id]))).size).toBe(1);
});
