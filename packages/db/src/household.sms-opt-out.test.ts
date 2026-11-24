// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from './id.js';
import { households, members } from './schema/index.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';
import type { HouseholdScope } from './household.js';

const database = useTestDatabase(), factory = createFactories(database);
type Kind = 'member' | 'household';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 18, minute));
type Queries = Parameters<Parameters<typeof database.forHousehold>[1]>[0];
const read = (scope: HouseholdScope, fn: (queries: Queries) => Promise<ReadonlyMap<string, string>>) =>
  database.forHousehold(scope, fn).then(map => Object.fromEntries(map));

async function fixture() {
  const gymId = uuidv7(), otherGym = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const home = await factory('households', gymId), other = await factory('households', gymId);
  const payer = await factory('authUser', gymId), adultUser = await factory('authUser', gymId), otherPayer = await factory('authUser', gymId);
  const adult = await factory('members', gymId, { householdId: home.id }), child = await factory('members', gymId, { householdId: home.id });
  const quiet = await factory('members', gymId, { householdId: home.id }), outsider = await factory('members', gymId, { householdId: other.id });
  await factory('householdUsers', gymId, { householdId: home.id, userId: payer.id, scope: 'payer' });
  await factory('householdUsers', gymId, { householdId: home.id, userId: adultUser.id, scope: 'member', memberId: adult.id });
  await factory('householdUsers', gymId, { householdId: other.id, userId: otherPayer.id, scope: 'payer' });
  const audit = (type: Kind, targetId: string, change: string, minute: number, extra: Record<string, unknown> = {}, gym = gymId) =>
    factory('auditEvents', gym, { action: `${type}.${change}`, targetType: type, targetId, occurredAt: at(minute), ...extra });
  const user = (userId: string, householdId = home.id) => ({ kind: 'user' as const, gymId, householdId, userId });
  return { gymId, otherGym, home, other, adult, child, quiet, outsider, audit,
    payer: user(payer.id), adultLogin: user(adultUser.id), otherLogin: user(otherPayer.id, other.id) };
}

it('returns the opt-out date only while it is the newest consent or number change, for the grant\'s members', async () => {
  const f = await fixture();
  for (const person of [f.adult, f.child, f.outsider]) {
    await f.audit('member', person.id, 'sms_consent_changed', 0);
    await f.audit('member', person.id, 'sms_opted_out', 1);
  }
  // Recording consent again, then a later number change: both end the opt-out.
  await f.audit('member', f.child.id, 'sms_consent_changed', 2);
  await f.audit('member', f.quiet.id, 'sms_opted_out', 1);
  await f.audit('member', f.quiet.id, 'sms_number_changed', 3);
  // Audits that are not consent changes, another target type and another gym's rows never count.
  await f.audit('member', f.adult.id, 'updated', 5);
  await f.audit('household', f.adult.id, 'sms_consent_changed', 6);
  await f.audit('member', f.adult.id, 'sms_consent_changed', 7, {}, f.otherGym);
  const ids = [f.adult.id, f.child.id, f.quiet.id, f.outsider.id, uuidv7()];
  expect(await read(f.payer, queries => queries.smsOptedOut('member', ids))).toEqual({ [f.adult.id]: at(1).toISOString() });
  // The adult non-payer reads only their own member.
  expect(await read(f.adultLogin, queries => queries.smsOptedOut('member', ids))).toEqual({ [f.adult.id]: at(1).toISOString() });
  // Another household's payer learns nothing about these IDs, and its own opted-out member still answers.
  expect(await read(f.otherLogin, queries => queries.smsOptedOut('member', [f.adult.id, f.child.id]))).toEqual({});
  expect(await read(f.otherLogin, queries => queries.smsOptedOut('member', ids))).toEqual({ [f.outsider.id]: at(1).toISOString() });
  expect(await read(f.payer, queries => queries.smsOptedOut('member', []))).toEqual({});
});

it('resolves audits with the same time by the larger ID', async () => {
  const f = await fixture();
  /** Two audits at the same time; the opt-out gets the larger ID when it should win. */
  async function tie(type: Kind, targetId: string, optOutWins: boolean, other = 'sms_consent_changed') {
    const [low, high] = [uuidv7(), uuidv7()].sort();
    await f.audit(type, targetId, 'sms_opted_out', 4, { id: optOutWins ? high : low });
    await f.audit(type, targetId, other, 4, { id: optOutWins ? low : high });
  }
  await tie('member', f.adult.id, true);
  await tie('member', f.child.id, false);
  expect(await read(f.payer, queries => queries.smsOptedOut('member', [f.adult.id, f.child.id]))).toEqual({ [f.adult.id]: at(4).toISOString() });
  await tie('household', f.home.id, true, 'sms_number_changed');
  expect(await read(f.payer, queries => queries.smsOptedOut('household', [f.home.id]))).toEqual({ [f.home.id]: at(4).toISOString() });
  await tie('household', f.other.id, false, 'sms_number_changed');
  expect(await read(f.otherLogin, queries => queries.smsOptedOut('household', [f.other.id]))).toEqual({});
});

it('gives the household date only to its payer, for its own household', async () => {
  const f = await fixture();
  for (const home of [f.home, f.other]) {
    await f.audit('household', home.id, 'sms_consent_changed', 0);
    await f.audit('household', home.id, 'sms_opted_out', 1);
  }
  const both = [f.home.id, f.other.id];
  expect(await read(f.payer, queries => queries.smsOptedOut('household', both))).toEqual({ [f.home.id]: at(1).toISOString() });
  expect(await read(f.otherLogin, queries => queries.smsOptedOut('household', [f.home.id]))).toEqual({});
  // The adult non-payer and an onboarding link have no household-profile access.
  expect(await read(f.adultLogin, queries => queries.smsOptedOut('household', both))).toEqual({});
  const link = await factory('signedLinks', f.gymId, { householdId: f.home.id, purpose: 'onboarding', expiresAt: new Date('2030-01-01Z') });
  const linkScope = { kind: 'signed_link' as const, gymId: f.gymId, linkId: link.id, now: new Date('2026-11-21Z') };
  expect(await read(linkScope, queries => queries.smsOptedOut('household', both))).toEqual({});
  // Recording consent afterwards, or a number change, ends it.
  await f.audit('household', f.home.id, 'sms_consent_changed', 2);
  await f.audit('household', f.other.id, 'sms_number_changed', 2);
  expect(await read(f.payer, queries => queries.smsOptedOut('household', both))).toEqual({});
  expect(await read(f.otherLogin, queries => queries.smsOptedOut('household', both))).toEqual({});
});

it('fills records with no audit answer from the gym\'s opted-out numbers, inside the grant', async () => {
  const f = await fixture(), listed = '+12025550123', unlisted = '+12025550199';
  await factory('smsOptedOutNumbers', f.gymId, { phoneE164: listed, optedOutAt: at(10) });
  // Another gym's row for the unlisted number never answers here.
  await factory('smsOptedOutNumbers', f.otherGym, { phoneE164: unlisted, optedOutAt: at(11) });
  const withNumber = (id: string, phoneE164: string, table: 'members' | 'households' = 'members') => database.forGym(f.gymId, tx => table === 'members'
    ? tx.update(members).set({ phone: phoneE164, phoneE164 }).where(eq(members.id, id))
    : tx.update(households).set({ phone: phoneE164, phoneE164 }).where(eq(households.id, id)));
  await withNumber(f.adult.id, listed); await withNumber(f.child.id, unlisted); await withNumber(f.outsider.id, listed);
  // The quiet member's own opt-out audit wins over the list's date.
  await withNumber(f.quiet.id, listed); await f.audit('member', f.quiet.id, 'sms_opted_out', 3);
  const ids = [f.adult.id, f.child.id, f.quiet.id, f.outsider.id];
  expect(await read(f.payer, queries => queries.smsOptedOut('member', ids)))
    .toEqual({ [f.adult.id]: at(10).toISOString(), [f.quiet.id]: at(3).toISOString() });
  expect(await read(f.adultLogin, queries => queries.smsOptedOut('member', ids))).toEqual({ [f.adult.id]: at(10).toISOString() });
  await withNumber(f.home.id, listed, 'households'); await withNumber(f.other.id, listed, 'households');
  expect(await read(f.payer, queries => queries.smsOptedOut('household', [f.home.id, f.other.id]))).toEqual({ [f.home.id]: at(10).toISOString() });
  expect(await read(f.adultLogin, queries => queries.smsOptedOut('household', [f.home.id]))).toEqual({});
  expect(await read(f.otherLogin, queries => queries.smsOptedOut('household', [f.home.id]))).toEqual({});
});

it('leaves records with stored SMS consent out of the list fallback while keeping their own opt-out audit', async () => {
  const f = await fixture(), listed = '+12025550123';
  await factory('smsOptedOutNumbers', f.gymId, { phoneE164: listed, optedOutAt: at(10) });
  await database.forGym(f.gymId, async tx => {
    await tx.update(members).set({ phone: listed, phoneE164: listed, smsNoticesConsentAt: at(5), smsNoticesConsentSource: 'join' }).where(eq(members.id, f.adult.id));
    await tx.update(members).set({ phone: listed, phoneE164: listed, smsAnnouncementsConsentAt: at(5), smsAnnouncementsConsentSource: 'join' }).where(eq(members.id, f.child.id));
    await tx.update(members).set({ phone: listed, phoneE164: listed }).where(eq(members.id, f.quiet.id));
    await tx.update(households).set({ phone: listed, phoneE164: listed, smsNoticesConsentAt: at(5), smsNoticesConsentSource: 'join' }).where(eq(households.id, f.home.id));
    await tx.update(households).set({ phone: listed, phoneE164: listed }).where(eq(households.id, f.other.id));
  });
  expect(await read(f.payer, queries => queries.smsOptedOut('member', [f.adult.id, f.child.id, f.quiet.id])))
    .toEqual({ [f.quiet.id]: at(10).toISOString() });
  expect(await read(f.payer, queries => queries.smsOptedOut('household', [f.home.id]))).toEqual({});
  expect(await read(f.otherLogin, queries => queries.smsOptedOut('household', [f.other.id])))
    .toEqual({ [f.other.id]: at(10).toISOString() });
  // A record's own opt-out audit still answers.
  await f.audit('member', f.adult.id, 'sms_opted_out', 3);
  expect(await read(f.payer, queries => queries.smsOptedOut('member', [f.adult.id, f.child.id, f.quiet.id])))
    .toEqual({ [f.adult.id]: at(3).toISOString(), [f.quiet.id]: at(10).toISOString() });
});

it('refuses more than 100 IDs in one read', async () => {
  const f = await fixture();
  const ids = Array.from({ length: 101 }, () => uuidv7());
  await expect(read(f.payer, queries => queries.smsOptedOut('member', ids))).rejects.toThrow(RangeError);
  expect(await read(f.payer, queries => queries.smsOptedOut('member', ids.slice(0, 100)))).toEqual({});
});
