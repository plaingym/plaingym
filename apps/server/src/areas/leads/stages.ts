// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { leads, members, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import type { AttendanceMutation } from '../attendance/attendance.js';
import { isLeadMember } from './eligibility.js';

interface StageInput {
  gymId: string; memberId: string; now: Date; occurredAt?: Date; memberStatus?: string;
  actor: AttendanceMutation['actor'];
}
/** The caller owns the transaction. Lock before deciding so concurrent retries audit once. */
async function advance(tx: Transaction, input: StageInput, stage: 'trial_attended' | 'won') {
  const { gymId, memberId, now, actor } = input;
  const where = and(eq(leads.gymId, gymId), eq(leads.memberId, memberId));
  let [before] = await tx.select().from(leads).where(where).for('update');
  let created = false;
  if (!before) {
    // Acquire the FK's member lock before reserving a unique lead key. Attendance
    // already holds the member lock; reversing that order can deadlock activation.
    let status = input.memberStatus;
    if (status === undefined) {
      const [member] = await tx.select({ status: members.status }).from(members)
        .where(and(eq(members.gymId, gymId), eq(members.id, memberId))).for('key share');
      status = member?.status;
    }
    if (!status || !isLeadMember(status)) return;
    const inserted = await tx.insert(leads).values({ id: uuidv7(now.getTime()), gymId, memberId, createdAt: now })
      .onConflictDoNothing({ target: [leads.gymId, leads.memberId] }).returning({ id: leads.id });
    created = inserted.length > 0;
    if (created) await writeAudit(tx, { gymId, actorKind: actor.kind,
      ...(actor.kind === 'user' ? { actorUserId: actor.userId } : {}),
      ...(actor.kind === 'device' ? { actorDeviceId: actor.deviceId } : {}),
      action: 'lead.created', targetType: 'lead', targetId: inserted[0]!.id,
      after: { source: null }, occurredAt: now, createdAt: now });
    [before] = await tx.select().from(leads).where(where).for('update');
  }
  if (!before || before.stage === stage) return;
  if (stage === 'trial_attended' && !['new', 'contacted', 'trial_booked'].includes(before.stage)) return;
  // A lost lead that wins drops its lost reason and time, as reopening does.
  const changes = stage === 'trial_attended'
    ? { trialAttendedAt: before.trialAttendedAt ?? input.occurredAt ?? now } : { wonAt: before.wonAt ?? now, lostReason: null, lostAt: null };
  await tx.update(leads).set({ stage, ...changes, revision: before.revision + 1 }).where(where);
  await writeAudit(tx, { gymId, actorKind: actor.kind,
    ...(actor.kind === 'user' ? { actorUserId: actor.userId } : {}),
    ...(actor.kind === 'device' ? { actorDeviceId: actor.deviceId } : {}),
    action: 'lead.stage_changed', targetType: 'lead', targetId: before.id,
    before: created ? null : { stage: before.stage, revision: before.revision }, after: { stage, revision: before.revision + 1 },
    occurredAt: now, createdAt: now });
}

export function advanceLeadOnCheckIn(tx: Transaction, input: StageInput) { return advance(tx, input, 'trial_attended'); }
export function markLeadWon(tx: Transaction, input: StageInput) { return advance(tx, input, 'won'); }
