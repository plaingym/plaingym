// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { householdUsers } from './schema/index.js';
import { HouseholdAccessError } from './household.js';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';

const db = useTestDatabase(), factory = createFactories(db);
const now = new Date('2026-11-11T12:00:00Z');
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const home = await factory('households', gymId), other = await factory('households', gymId);
  const payer = await factory('authUser', gymId), adult = await factory('authUser', gymId), otherPayer = await factory('authUser', gymId);
  const member = await factory('members', gymId, { householdId: home.id, firstName: 'Alex' });
  const sibling = await factory('members', gymId, { householdId: home.id, firstName: 'Kim' });
  const outsider = await factory('members', gymId, { householdId: other.id, firstName: 'Out' });
  await factory('householdUsers', gymId, { householdId: home.id, userId: payer.id, scope: 'payer' });
  const adultGrant = await factory('householdUsers', gymId, { householdId: home.id, userId: adult.id, scope: 'member', memberId: member.id });
  await factory('householdUsers', gymId, { householdId: other.id, userId: otherPayer.id, scope: 'payer' });
  const scope = { kind: 'user' as const, gymId, householdId: home.id, userId: payer.id };
  const credits = (memberId: string, credits = 3, expiresAt: Date | null = null) => factory('classCreditEntries', gymId, { memberId, credits, expiresAt });
  return { gymId, home, member, sibling, outsider, adult, adultGrant, other, otherPayer, scope, credits };
}

it('reads only granted household members and only the adult non-payer themselves, in both directions', async () => {
  const f = await fixture();
  for (const member of [f.member, f.sibling, f.outsider]) await f.credits(member.id);
  const read = (scope: typeof f.scope) => db.forHousehold(scope, queries => queries.classCredits(now));
  const own = await read(f.scope);
  expect(own.map(row => row.memberId).sort()).toEqual([f.member.id, f.sibling.id].sort());
  expect(own[0]).toEqual({ memberId: f.member.id, firstName: f.member.firstName, lastName: f.member.lastName, balance: 3, soonestExpiry: null });
  expect((await read({ ...f.scope, userId: f.adult.id })).map(row => row.memberId)).toEqual([f.member.id]);
  expect((await read({ ...f.scope, householdId: f.other.id, userId: f.otherPayer.id })).map(row => row.memberId)).toEqual([f.outsider.id]);
  await expect(read({ ...f.scope, householdId: f.other.id })).rejects.toBeInstanceOf(HouseholdAccessError);
});

it('sums positive lot remainders, ignoring expired, exactly-expiring and used-up lots before the expiry job', async () => {
  const f = await fixture(), soonest = new Date('2026-11-12T05:00:00Z');
  const lot = await f.credits(f.member.id, 10, soonest);
  await factory('classCreditEntries', f.gymId, { memberId: f.member.id, lotId: lot.id, credits: -3 });
  const spent = await f.credits(f.member.id, 2, new Date('2026-11-11T13:00:00Z'));
  await factory('classCreditEntries', f.gymId, { memberId: f.member.id, lotId: spent.id, credits: -2 });
  await f.credits(f.member.id, 99, new Date('2026-11-10T12:00:00Z'));
  await f.credits(f.member.id, 44, now);
  await f.credits(f.member.id, 5);
  await f.credits(f.sibling.id, 1, now);
  const read = (at: Date) => db.forHousehold(f.scope, queries => queries.classCredits(at));
  expect(await read(now)).toEqual([{ memberId: f.member.id, firstName: f.member.firstName, lastName: f.member.lastName, balance: 12, soonestExpiry: soonest }]);
  expect(await read(soonest)).toEqual([{ memberId: f.member.id, firstName: f.member.firstName, lastName: f.member.lastName, balance: 5, soonestExpiry: null }]);
});

it('refuses revoked grants and cross-gym claims while a second gym reads only its own credits', async () => {
  const a = await fixture(), b = await fixture();
  await a.credits(a.member.id, 9); await b.credits(b.member.id, 2);
  expect((await db.forHousehold(b.scope, queries => queries.classCredits(now))).map(row => row.memberId)).toEqual([b.member.id]);
  await expect(db.forHousehold({ ...a.scope, gymId: b.gymId }, queries => queries.classCredits(now))).rejects.toBeInstanceOf(HouseholdAccessError);
  await db.forGym(a.gymId, tx => tx.delete(householdUsers).where(eq(householdUsers.id, a.adultGrant.id)));
  await expect(db.forHousehold({ ...a.scope, userId: a.adult.id }, queries => queries.classCredits(now))).rejects.toBeInstanceOf(HouseholdAccessError);
});

it('does not extend signed-link grants to credit balances, including onboarding links', async () => {
  const f = await fixture(); await f.credits(f.member.id);
  for (const purpose of ['onboarding', 'sign_waiver', 'update_card', 'pay_invoice'] as const) {
    const invoice = purpose === 'pay_invoice' ? await factory('invoices', f.gymId, { householdId: f.home.id }) : null;
    const link = await factory('signedLinks', f.gymId, { householdId: f.home.id, purpose, memberId: purpose === 'sign_waiver' ? f.member.id : null,
      invoiceId: invoice?.id ?? null, expiresAt: new Date('2026-11-12T12:00:00Z') });
    await expect(db.forHousehold({ kind: 'signed_link', gymId: f.gymId, linkId: link.id, now }, queries => queries.classCredits(now)))
      .rejects.toBeInstanceOf(HouseholdAccessError);
  }
});
