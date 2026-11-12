// SPDX-License-Identifier: AGPL-3.0-only
import { auditEvents, memberships, type Transaction } from '@plaingym/db';
import { and, asc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Reviewed fixed JSON status projections, read only inside the caller's forGym transaction.
import { sql } from 'drizzle-orm';

/** One snapshot for rows and history; the audit lookup uses (gym_id, action, target_id). */
export async function membersHistory(tx: Transaction, gymId: string, startsAt: Date) {
  // Lifecycle reconstruction reads only these statuses, never whole request/billing snapshots.
  const statuses = { beforeStatus: sql<unknown>`${auditEvents.before}->>'status'`,
    afterStatus: sql<unknown>`${auditEvents.after}->>'status'`, assignedStatus: sql<unknown>`${auditEvents.after}->'membership'->>'status'` };
  const result = await tx.select({ membership: { id: memberships.id, memberId: memberships.memberId,
    status: memberships.status, startsOn: memberships.startsOn, cancelledAt: memberships.cancelledAt,
    frozenAt: memberships.frozenAt }, event: { targetId: auditEvents.targetId, action: auditEvents.action,
    occurredAt: auditEvents.occurredAt, ...statuses } }).from(memberships)
    .leftJoin(auditEvents, and(eq(auditEvents.gymId, memberships.gymId),
      eq(auditEvents.targetId, memberships.id), eq(auditEvents.targetType, 'membership'),
      inArray(auditEvents.action, ['billing.membership.assigned', 'billing.membership.activated',
        'billing.membership.imported', 'billing.membership.frozen'])))
    .where(and(eq(memberships.gymId, gymId), or(isNull(memberships.cancelledAt), gte(memberships.cancelledAt, startsAt))))
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
  const rows = new Map<string, (typeof result)[number]['membership']>();
  const events: NonNullable<(typeof result)[number]['event']>[] = [];
  for (const item of result) {
    rows.set(item.membership.id, item.membership);
    if (item.event?.targetId) events.push(item.event);
  }
  return { rows: [...rows.values()], events };
}
export type MembersHistory = Awaited<ReturnType<typeof membersHistory>>;
