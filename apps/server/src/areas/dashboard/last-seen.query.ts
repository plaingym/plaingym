// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Isolated lateral join predicate, always inside forGym.
import { sql } from 'drizzle-orm';
import { attendances, forGym, members, type Transaction } from '@plaingym/db';
import type { DashboardContext } from './widgets.js';

/** Shared visit rule for both widgets: either visit kind, including now, ignoring the future. */
export function lastVisit(tx: Transaction, gymId: string, now: Date) {
  return tx.select({ occurredAt: attendances.occurredAt }).from(attendances)
    .where(and(eq(attendances.gymId, gymId), eq(attendances.memberId, members.id),
      lt(attendances.occurredAt, new Date(now.getTime() + 1))))
    .orderBy(desc(attendances.occurredAt)).limit(1).as('last_visit');
}
export const lateralMatch = sql`true`;

export function createLastSeenRead(scope: typeof forGym) {
  return async (context: DashboardContext, memberIds: readonly string[]): Promise<ReadonlyMap<string, string | null>> => {
    if (!memberIds.length) return new Map();
    return scope(context.gymId, async tx => {
      const visit = lastVisit(tx, context.gymId, context.clock.now());
      const rows = await tx.select({ memberId: members.id, lastSeenAt: visit.occurredAt }).from(members)
        .leftJoinLateral(visit, lateralMatch).where(inArray(members.id, [...memberIds])).orderBy(asc(members.id));
      return new Map(rows.map(row => [row.memberId, row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null]));
    });
  };
}
