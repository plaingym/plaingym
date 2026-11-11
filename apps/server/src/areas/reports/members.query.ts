// SPDX-License-Identifier: AGPL-3.0-only
import { auditEvents, memberships, type Transaction } from '@plaingym/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

/** One snapshot for rows and history; the audit lookup uses (gym_id, action, target_id). */
export async function membersHistory(tx: Transaction, gymId: string) {
  const result = await tx.select({ membership: { id: memberships.id, memberId: memberships.memberId,
    status: memberships.status, startsOn: memberships.startsOn, cancelledAt: memberships.cancelledAt,
    frozenAt: memberships.frozenAt }, event: { targetId: auditEvents.targetId, action: auditEvents.action,
    occurredAt: auditEvents.occurredAt, before: auditEvents.before, after: auditEvents.after } }).from(memberships)
    .leftJoin(auditEvents, and(eq(auditEvents.gymId, gymId), eq(auditEvents.gymId, memberships.gymId),
      eq(auditEvents.targetId, memberships.id), eq(auditEvents.targetType, 'membership'),
      inArray(auditEvents.action, ['billing.membership.assigned', 'billing.membership.activated',
        'billing.membership.imported', 'billing.membership.frozen'])))
    .where(eq(memberships.gymId, gymId))
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
  const rows = new Map<string, (typeof result)[number]['membership']>();
  const events: NonNullable<(typeof result)[number]['event']>[] = [];
  for (const item of result) {
    rows.set(item.membership.id, item.membership);
    if (item.event) events.push(item.event);
  }
  return { rows: [...rows.values()], events };
}
export type MembersHistory = Awaited<ReturnType<typeof membersHistory>>;
