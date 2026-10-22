// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FakeMemberHouseholdContext } from './member-household.js';
import type { PortalLoginFixture } from './member-household.js';
import { gym, otherGym, household, member, sibling, id } from './test-fixtures.js';
const members = [
  { gymId: gym, householdId: household, id: member },
  { gymId: gym, householdId: household, id: sibling },
  { gymId: gym, householdId: id(10), id: id(11) },
  { gymId: otherGym, householdId: id(12), id: id(13) },
];
const payer: PortalLoginFixture = { gymId: gym, householdId: household, userId: id(20), role: 'payer', memberId: null };
const adult: PortalLoginFixture = { gymId: gym, householdId: household, userId: id(21), role: 'member', memberId: member };
describe('MemberHouseholdContext fake', () => {
  it('resolves payer and adult scopes from login links', async () => {
    const fake = new FakeMemberHouseholdContext(members, [payer, adult]);
    expect(await fake.resolve(payer)).toMatchObject({ role: 'payer', visibleMemberIds: [member, sibling] });
    expect(await fake.resolve(adult)).toMatchObject({ role: 'member', memberId: member, visibleMemberIds: [member] });
    await expect(fake.requireMember(payer, sibling, 'bookings.household')).resolves.toBeDefined();
    await expect(fake.requireMember(adult, member, 'profile.read')).resolves.toBeDefined();
  });
  it('denies sibling, other household, other gym and payer-only data to an adult', async () => {
    const fake = new FakeMemberHouseholdContext(members, [payer, adult]);
    for (const target of [sibling, id(11), id(13)])
      await expect(fake.requireMember(adult, target, 'profile.read')).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.requireMember(payer, id(11), 'profile.read')).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.requirePayer(adult, 'billing.manage')).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.requirePayer(payer, 'billing.manage')).resolves.toBeDefined();
    await expect(fake.requirePayer(payer, 'memberships.manage')).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.resolve({ ...payer, gymId: otherGym })).rejects.toMatchObject({ code: 'not_found' });
    await expect(fake.resolve({ ...payer, householdId: id(10) })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('reloads after revocation and returns independent contexts', async () => {
    const fake = new FakeMemberHouseholdContext(members, [payer]);
    const context = await fake.resolve(payer);
    (context.visibleMemberIds as string[]).push(id(999));
    expect((await fake.resolve(payer)).visibleMemberIds).toEqual([member, sibling]);
    fake.revoke(payer);
    await expect(fake.resolve(payer)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('allows several payers and one login per member, with household-consistent links', () => {
    const fake = new FakeMemberHouseholdContext(members, [payer, adult]);
    fake.link({ ...payer, userId: id(22), memberId: sibling });
    expect(() => fake.link({ ...adult, userId: id(23) })).toThrow('already linked');
    expect(() => fake.link({ ...adult, userId: id(23), memberId: null })).toThrow();
    expect(() => fake.link({ ...adult, userId: id(23), memberId: id(11) })).toThrow();
  });
});
