// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
export interface HouseholdContractFixture {
  context: MemberHouseholdContext; payer: PortalIdentity; adult: PortalIdentity;
  member: string; sibling: string; erased: string; erasedAdult: PortalIdentity; foreign: string; otherGym: string; otherHousehold: string;
  revoke(): Promise<void>;
}
export function householdContextContract(name: string, setup: () => Promise<HouseholdContractFixture>) {
  describe(name, () => {
    it('excludes erased members from payer and adult scopes', async () => {
      const f = await setup();
      expect((await f.context.resolve(f.payer)).visibleMemberIds).not.toContain(f.erased);
      expect((await f.context.resolve(f.erasedAdult)).visibleMemberIds).toEqual([]);
      for (const identity of [f.payer, f.erasedAdult]) {
        await expect(f.context.requireMember(identity, f.erased, 'profile.read')).rejects.toMatchObject({ code: 'not_found' });
      }
    });
    it('resolves scopes and permits payer household actions and adult self actions', async () => {
      const f = await setup();
      expect([...(await f.context.resolve(f.payer)).visibleMemberIds].sort()).toEqual([f.member, f.sibling].sort());
      expect(await f.context.resolve(f.adult)).toMatchObject({ role: 'member', memberId: f.member, visibleMemberIds: [f.member] });
      await expect(f.context.requireMember(f.payer, f.sibling, 'bookings.household')).resolves.toBeDefined();
      await expect(f.context.requireMember(f.adult, f.member, 'profile.read')).resolves.toBeDefined();
      await expect(f.context.requirePayer(f.payer, 'billing.manage')).resolves.toBeDefined();
    });
    it('uses not-found for foreign resources, forbidden capabilities and forged scope', async () => {
      const f = await setup();
      for (const id of [f.sibling, f.foreign]) await expect(f.context.requireMember(f.adult, id, 'profile.read')).rejects.toMatchObject({ code: 'not_found' });
      await expect(f.context.requireMember(f.payer, f.foreign, 'profile.read')).rejects.toMatchObject({ code: 'not_found' });
      await expect(f.context.requirePayer(f.adult, 'billing.manage')).rejects.toMatchObject({ code: 'not_found' });
      await expect(f.context.requirePayer(f.payer, 'memberships.manage')).rejects.toMatchObject({ code: 'not_found' });
      for (const identity of [{ ...f.payer, gymId: f.otherGym }, { ...f.payer, householdId: f.otherHousehold }]) await expect(f.context.resolve(identity)).rejects.toMatchObject({ code: 'not_found' });
    });
    it('returns independent snapshots and reloads revoked links', async () => {
      const f = await setup(), snapshot = await f.context.resolve(f.payer);
      (snapshot.visibleMemberIds as string[]).push(f.foreign);
      expect((await f.context.resolve(f.payer)).visibleMemberIds).not.toContain(f.foreign);
      await f.revoke();
      await expect(f.context.resolve(f.payer)).rejects.toMatchObject({ code: 'not_found' });
    });
  });
}

