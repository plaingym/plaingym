// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, lt, max } from 'drizzle-orm';
import { attendances, forGym, members } from '@plaingym/db';
import type { MatDashboardWidget } from '@plaingym/shared/contracts';
import type { DashboardContext } from './widgets.js';

/** One grouped read, including members with no visits, under the gym's RLS context. */
export function createNotSeenRead(scope: typeof forGym = forGym) {
  return async (context: DashboardContext): Promise<Extract<MatDashboardWidget, { id: 'not_seen' }>> => {
    const now = context.clock.now(), cutoff = now.getTime() - 14 * 24 * 60 * 60 * 1000;
    const rows = await scope(context.gymId, tx => tx.select({ memberId: members.id,
      firstName: members.firstName, lastName: members.lastName, createdAt: members.createdAt,
      lastSeenAt: max(attendances.occurredAt),
    }).from(members).leftJoin(attendances, and(eq(attendances.memberId, members.id),
      eq(attendances.gymId, members.gymId), lt(attendances.occurredAt, new Date(now.getTime() + 1))))
      .where(eq(members.status, 'active')).groupBy(members.id)
      .orderBy(asc(members.lastName), asc(members.firstName), asc(members.id)));
    const unseen = rows.filter(row => (row.lastSeenAt ? new Date(row.lastSeenAt) : row.createdAt).getTime() <= cutoff);
    return { id: 'not_seen', titleKey: 'dashboard/dashboard:widget.not_seen', status: 'ready', days: 14,
      count: unseen.length, members: unseen.slice(0, 100).map(row => ({ memberId: row.memberId,
        firstName: row.firstName, lastName: row.lastName,
        lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null })) };
  };
}
