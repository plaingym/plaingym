// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated window count for the capped dashboard query.
import { sql } from 'drizzle-orm';
import { forGym, members } from '@plaingym/db';
import type { MatDashboardWidget } from '@plaingym/shared/contracts';
import type { DashboardContext } from './widgets.js';
import { createLastSeenRead, lastVisit, lateralMatch } from './last-seen.query.js';

/** Scoped widget read and the same last-visit rule for promotion details. */
export function createNotSeenRead(scope: typeof forGym = forGym) {
  const read = async (context: DashboardContext): Promise<Extract<MatDashboardWidget, { id: 'not_seen' }>> => {
    const now = context.clock.now(), cutoff = new Date(now.getTime() - 14 * 86400000);
    const rows = await scope(context.gymId, async tx => {
      const visit = lastVisit(tx, context.gymId, now);
      return tx.select({ memberId: members.id, firstName: members.firstName, lastName: members.lastName,
        lastSeenAt: visit.occurredAt, total: sql<number>`count(*) over()`.mapWith(Number),
      }).from(members).leftJoinLateral(visit, lateralMatch)
        .where(and(eq(members.status, 'active'), or(lte(visit.occurredAt, cutoff),
          and(isNull(visit.occurredAt), lte(members.createdAt, cutoff)))))
        .orderBy(asc(members.lastName), asc(members.firstName), asc(members.id)).limit(100);
    });
    return { id: 'not_seen', titleKey: 'dashboard/dashboard:widget.not_seen', status: 'ready', days: 14,
      count: rows[0]?.total ?? 0, members: rows.map(row => ({ memberId: row.memberId,
        firstName: row.firstName, lastName: row.lastName,
        lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null })) };
  };
  return Object.assign(read, { lastSeen: createLastSeenRead(scope) });
}
