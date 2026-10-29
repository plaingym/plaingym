// SPDX-License-Identifier: AGPL-3.0-only
import { forHousehold } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { portalAttendanceQuerySchema, portalAttendanceSchema, portalMemberProgressResponseSchema, portalRankHistorySchema,
  type PortalMemberProgress } from '@plaingym/shared/contracts';
import type { AttendanceQueries } from '../../core/interfaces/attendance.js';
import type { MemberHouseholdContext, PortalIdentity } from '../../core/interfaces/member-household.js';
import { notFound } from '../../core/interfaces/common.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createAttendanceQueries } from '../attendance/attendance.js';
import type { RanksService } from '../ranks/ranks.service.js';

export interface PortalProgressOptions {
  households?: MemberHouseholdContext; householdScope?: typeof forHousehold;
  /** The ranks service built over the runtime's criterion registry; unconfigured means unavailable. */
  ranks: () => RanksService | undefined;
  attendance?: () => AttendanceQueries | undefined;
}
/** Rank progress and attendance for a member this login may see; activity is read only through forHousehold. */
export function createPortalProgressService(options: PortalProgressOptions) {
  const households = options.households ?? createMemberHouseholdContext(), scope = options.householdScope ?? forHousehold;
  const fallback = createAttendanceQueries();
  async function read<T>(identity: PortalIdentity, fn: Parameters<typeof forHousehold<T>>[1]) {
    try { return await scope({ kind: 'user', ...identity }, fn); }
    catch (error) { if (error instanceof Error && error.message === 'Household access denied') notFound(); throw error; }
  }
  return {
    async progress(identity: PortalIdentity, memberId: string, enabledModules: ReadonlySet<string> = new Set()): Promise<PortalMemberProgress> {
      await households.requireMember(identity, memberId, 'progress.read');
      const ranks = options.ranks() ?? (() => { throw new AppError('unavailable', 'Ranks are not configured'); })();
      const { member, history } = await read(identity, async queries => ({
        member: (await queries.member(memberId))[0],
        // Promotion notes and the promoting coach are never selected into the portal projection.
        history: (await queries.ranks()).filter(row => row.memberId === memberId).map(row => ({ id: row.id, memberId: row.memberId,
          programId: row.programId, rankId: row.rankId, rankSystemId: row.rankSystemId, subRank: row.subRank, promotedAt: row.promotedAt, createdAt: row.createdAt })),
      }));
      if (!member) notFound();
      const progress = await ranks.memberProgress(identity.gymId, { memberId, dateOfBirth: member.dateOfBirth, history,
        attendanceScope: { kind: 'household', identity } }, enabledModules);
      // The ranks service returns the history in the order that chose each program's current rank.
      return portalMemberProgressResponseSchema.parse({ data: { ...progress, history: progress.history.map(row => portalRankHistorySchema.parse({
        id: row.id, memberId: row.memberId, programId: row.programId, rankId: row.rankId, rankSystemId: row.rankSystemId,
        subRank: row.subRank, promotedAt: row.promotedAt.toISOString() })) } }).data;
    },
    async attendance(identity: PortalIdentity, memberId: string, input: unknown) {
      const query = portalAttendanceQuerySchema.parse(input), queries = options.attendance?.() ?? fallback;
      await households.requireMember(identity, memberId, 'attendance.read');
      const page = await queries.history({ kind: 'household', identity }, { memberId,
        ...(query.programId ? { programId: query.programId } : {}), ...(query.tagId ? { tagId: query.tagId } : {}), ...(query.since ? { since: query.since } : {}) },
      { limit: query.limit, offset: query.offset });
      return { pagination: page.pagination, data: page.data.map(entry => portalAttendanceSchema.parse({ id: entry.id, memberId: entry.memberId,
        sessionId: entry.sessionId, programId: entry.programId, occurredAt: entry.occurredAt, source: entry.source, kind: entry.kind })) };
    },
  };
}
export type PortalProgressService = ReturnType<typeof createPortalProgressService>;
