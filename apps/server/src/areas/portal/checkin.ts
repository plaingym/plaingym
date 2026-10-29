// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import { notFound } from '../../core/interfaces/common.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import type { CheckinCodeService } from '../members/checkin-code.js';

export interface PortalCheckinOptions {
  households?: MemberHouseholdContext; householdScope?: typeof forHousehold;
  /** The derived, revocable codes over the gym's encrypted key; unconfigured means unavailable. */
  codes: () => CheckinCodeService | undefined;
}
/** A login reads and regenerates the codes of the members it may see: the payer's household, or an adult member alone. */
export function createPortalCheckinService(options: PortalCheckinOptions) {
  const households = options.households ?? createMemberHouseholdContext(), scope = options.householdScope ?? forHousehold;
  function codes() { return options.codes() ?? (() => { throw new AppError('unavailable', 'Check-in codes are not configured'); })(); }
  async function target(identity: PortalIdentity, memberId: string) {
    await households.requireMember(identity, memberId, 'checkin.manage');
    try { if (!(await scope({ kind: 'user', ...identity }, queries => queries.member(memberId)))[0]) notFound(); }
    catch (error) { if (error instanceof Error && error.message === 'Household access denied') notFound(); throw error; }
  }
  return {
    async read(identity: PortalIdentity, memberId: string) {
      await target(identity, memberId);
      return codes().read(identity.gymId, memberId);
    },
    async regenerate(identity: PortalIdentity, memberId: string, input: unknown) {
      await target(identity, memberId);
      const saved = await codes().regenerate({ gymId: identity.gymId, actor: { kind: 'user', userId: identity.userId } }, memberId, input);
      // A grant revoked while the code was replaced must not receive the new code.
      await target(identity, memberId);
      return saved;
    },
  };
}
export type PortalCheckinService = ReturnType<typeof createPortalCheckinService>;
