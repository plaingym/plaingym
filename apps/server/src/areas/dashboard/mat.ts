// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canStaff } from '@plaingym/shared';
import { matDashboardWidgetSchema, type MatDashboardWidget, type ListResponse } from '@plaingym/shared/contracts';
import type { AttendanceQueries } from '../../core/interfaces/attendance.js';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import type { createMembersService } from '../members/members.js';
import type { createRanksService } from '../ranks/ranks.service.js';
import type { DashboardContext } from './widgets.js';

export interface MatWidgetServices {
  readonly members: Pick<ReturnType<typeof createMembersService>, 'listMembers'>;
  readonly ranks: Pick<ReturnType<typeof createRanksService>, 'listPrograms' | 'listRanks' | 'eligibility'>;
  readonly attendance: AttendanceQueries;
}
async function allPages<T>(read: (page: { limit: number; offset: number }) => Promise<ListResponse<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await read({ limit: 100, offset });
    rows.push(...page.data);
    if (offset + 100 >= page.pagination.total || page.data.length === 0) return rows;
  }
}
const titleKey = (id: MatDashboardWidget['id']) => 'dashboard/dashboard:widget.' + id;
function provider(id: MatDashboardWidget['id'], order: number,
  permission: DashboardWidgetProvider['permission'],
  read: (context: DashboardContext) => Promise<MatDashboardWidget>): DashboardWidgetProvider<MatDashboardWidget> {
  return { id, order, permission, schema: matDashboardWidgetSchema, async read(context) {
    if (!canStaff(context.roles, permission)) throw new AppError('not_found', 'Widget not found');
    return read(context);
  } };
}

/** No table imports: each area owns its queries and short transactions. */
export function createMatWidgetProviders(services: MatWidgetServices): readonly DashboardWidgetProvider<MatDashboardWidget>[] {
  const activeMembers = (gymId: string) => allPages((page) => services.members.listMembers(gymId, { ...page, status: 'active' }));
  const lastSeen = async (context: DashboardContext, memberId: string) => {
    const result = await services.attendance.history({ kind: 'gym', gymId: context.gymId },
      { memberId, until: new Date(context.clock.now().getTime() + 1).toISOString() }, { limit: 1, offset: 0 });
    return result.data[0]?.occurredAt ?? null;
  };
  return [
    provider('active_members', 10, 'members.read', async (context) => {
      const page = await services.members.listMembers(context.gymId, { status: 'active', limit: 1, offset: 0 });
      return { id: 'active_members', titleKey: titleKey('active_members'), status: 'ready', count: page.pagination.total };
    }),
    provider('not_seen', 20, 'members.read', async (context) => {
      const cutoff = context.clock.now().getTime() - 14 * 24 * 60 * 60 * 1000;
      const unseen = [];
      for (const member of await activeMembers(context.gymId)) {
        const lastSeenAt = await lastSeen(context, member.id);
        // A new member who has never visited gets the same fourteen-day grace period.
        if (Date.parse(lastSeenAt ?? member.createdAt) <= cutoff) unseen.push({ memberId: member.id,
          firstName: member.firstName, lastName: member.lastName, lastSeenAt });
      }
      return { id: 'not_seen', titleKey: titleKey('not_seen'), status: 'ready', days: 14,
        count: unseen.length, members: unseen.slice(0, 100) };
    }),
    provider('promotion_ready', 30, 'promotions.manage', async (context) => {
      const members = new Map((await activeMembers(context.gymId)).map((member) => [member.id, member]));
      const ready = new Map<string, Extract<MatDashboardWidget, { id: 'promotion_ready' }>['members'][number]>();
      const programs = await allPages((page) => services.ranks.listPrograms(context.gymId, { ...page, active: 'true' }));
      for (const program of programs) {
        if (!program.active || !program.rankSystemId) continue;
        const ranks = await allPages((page) => services.ranks.listRanks(context.gymId, { ...page, rankSystemId: program.rankSystemId }));
        const considered = new Set<string>();
        // Consider the next available rank/sub-rank, even when its criteria are unmet.
        // Otherwise an easier, higher rank could incorrectly leapfrog that step.
        for (const rank of ranks.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))) {
          const candidates = await allPages((page) => services.ranks.eligibility(context.gymId,
            { ...page, programId: program.id, rankId: rank.id }, context.enabledModules));
          for (const candidate of candidates) {
            if (considered.has(candidate.memberId)) continue;
            considered.add(candidate.memberId);
            const member = members.get(candidate.memberId);
            if (!candidate.eligible || !member || ready.has(member.id)) continue;
            ready.set(member.id, { memberId: member.id, firstName: member.firstName, lastName: member.lastName,
              lastSeenAt: null, programId: program.id, rankId: rank.id });
          }
          if ([...members.keys()].every((id) => considered.has(id))) break;
        }
      }
      const result = [...ready.values()].sort((a, b) => a.lastName.localeCompare(b.lastName)
        || a.firstName.localeCompare(b.firstName) || a.memberId.localeCompare(b.memberId));
      for (const member of result.slice(0, 100)) member.lastSeenAt = await lastSeen(context, member.memberId);
      return { id: 'promotion_ready', titleKey: titleKey('promotion_ready'), status: 'ready', count: ready.size, members: result.slice(0, 100) };
    }),
  ];
}
