// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canStaff } from '@plaingym/shared';
import { matDashboardWidgetSchema, type MatDashboardWidget } from '@plaingym/shared/contracts';
import type { AttendanceQueries } from '../../core/interfaces/attendance.js';
import type { DashboardWidgetProvider } from '../../core/interfaces/extensions.js';
import type { createMembersService } from '../members/members.js';
import type { createRanksService } from '../ranks/ranks.service.js';
import type { DashboardContext } from './widgets.js';
import type { createNotSeenRead } from './not-seen.js';

export interface MatWidgetServices {
  readonly notSeen: ReturnType<typeof createNotSeenRead>;
  readonly members: Pick<ReturnType<typeof createMembersService>, 'listMembers'>;
  readonly ranks: Pick<ReturnType<typeof createRanksService>, 'dashboardEligibility'>;
  readonly attendance: AttendanceQueries;
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

/** Area services own promotion queries; the dashboard owns its indexed last-seen reads. */
export function createMatWidgetProviders(services: MatWidgetServices): readonly DashboardWidgetProvider<MatDashboardWidget>[] {
  return [
    provider('active_members', 10, 'members.read', async (context) => {
      const page = await services.members.listMembers(context.gymId, { status: 'active', limit: 1, offset: 0 });
      return { id: 'active_members', titleKey: titleKey('active_members'), status: 'ready', count: page.pagination.total };
    }),
    provider('not_seen', 20, 'members.read', services.notSeen),
    provider('promotion_ready', 30, 'promotions.manage', async (context) => {
      const ready = await services.ranks.dashboardEligibility(context.gymId, context.enabledModules);
      const displayed = ready.slice(0, 100);
      const seen = await services.notSeen.lastSeen(context, displayed.map(member => member.memberId));
      return { id: 'promotion_ready', titleKey: titleKey('promotion_ready'), status: 'ready', count: ready.length,
        members: displayed.map(member => ({ ...member, lastSeenAt: seen.get(member.memberId) ?? null })) };
    }),
  ];
}
