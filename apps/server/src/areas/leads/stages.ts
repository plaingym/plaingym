// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, ne } from 'drizzle-orm';
import { attendances, leads, members, uuidv7, auditActor, writeAudit, type Transaction } from '@plaingym/db';
import type { AttendanceMutation } from '../attendance/attendance.js';
import { isLeadMember } from './eligibility.js';

interface StageInput {
  gymId: string; memberId: string; now: Date; occurredAt?: Date; memberStatus?: string;
  actor: AttendanceMutation['actor'];
}
interface StageOptions { create?: boolean }
/** The caller owns the transaction. Lock before deciding so concurrent retries audit once. */
async function advance(tx: Transaction, input: StageInput, stage: 'trial_attended' | 'won', options: StageOptions = {}) {
  const { gymId, memberId, now, actor } = input;
  const where = and(eq(leads.gymId, gymId), eq(leads.memberId, memberId));
  let [before] = await tx.select().from(leads).where(where).for('update');
  let created = false;
  if (!before) {
    if (options.create === false) return;
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
    if (created) await writeAudit(tx, { gymId, ...auditActor(actor),
      action: 'lead.created', targetType: 'lead', targetId: inserted[0]!.id,
      after: { source: null }, occurredAt: now, createdAt: now });
    [before] = await tx.select().from(leads).where(where).for('update');
  }
  if (!before) return;
  const occurredAt = input.occurredAt ?? now;
  const trialAttendedAt = before.trialAttendedAt && before.trialAttendedAt < occurredAt ? before.trialAttendedAt : occurredAt;
  if (before.stage === stage) {
    if (stage !== 'trial_attended' || before.trialAttendedAt?.getTime() === trialAttendedAt.getTime()) return;
    await tx.update(leads).set({ trialAttendedAt, revision: before.revision + 1 }).where(where);
    await writeAudit(tx, { gymId, ...auditActor(actor),
      action: 'lead.trial_attendance_corrected', targetType: 'lead', targetId: before.id,
      before: { trialAttendedAt: before.trialAttendedAt?.toISOString() ?? null, revision: before.revision },
      after: { trialAttendedAt: trialAttendedAt.toISOString(), revision: before.revision + 1 },
      occurredAt: now, createdAt: now });
    return;
  }
  if (stage === 'trial_attended' && !['new', 'contacted', 'trial_booked'].includes(before.stage)) return;
  // A lost lead that wins drops its lost reason and time, as reopening does.
  const changes = stage === 'trial_attended'
    ? { trialAttendedAt } : { wonAt: before.wonAt ?? now, lostReason: null, lostAt: null };
  await tx.update(leads).set({ stage, ...changes, revision: before.revision + 1 }).where(where);
  await writeAudit(tx, { gymId, ...auditActor(actor),
    action: 'lead.stage_changed', targetType: 'lead', targetId: before.id,
    before: created ? null : { stage: before.stage, revision: before.revision }, after: { stage, revision: before.revision + 1 },
    occurredAt: now, createdAt: now });
}

export interface CorrectLeadAfterUndoInput {
  gymId: string; memberId: string; undoneAt: Date; now: Date; actor: AttendanceMutation['actor'];
}
/** Recompute the trial time after the visit that set it is undone. The caller owns the transaction and already holds the member and attendance locks. */
export async function correctLeadAfterUndo(tx: Transaction, input: CorrectLeadAfterUndoInput) {
  const { gymId, memberId, undoneAt, now, actor } = input;
  const where = and(eq(leads.gymId, gymId), eq(leads.memberId, memberId));
  const [before] = await tx.select().from(leads).where(where).for('update');
  if (!before || before.stage !== 'trial_attended') return;
  const stored = before.trialAttendedAt;
  if (!stored || stored.getTime() !== undoneAt.getTime()) return;
  const [earliest] = await tx.select({ occurredAt: attendances.occurredAt }).from(attendances)
    .where(and(eq(attendances.gymId, gymId), eq(attendances.memberId, memberId), ne(attendances.source, 'import')))
    .orderBy(asc(attendances.occurredAt)).limit(1);
  if (!earliest || earliest.occurredAt.getTime() === stored.getTime()) return;
  const trialAttendedAt = earliest.occurredAt;
  await tx.update(leads).set({ trialAttendedAt, revision: before.revision + 1 }).where(where);
  await writeAudit(tx, { gymId, ...auditActor(actor),
    action: 'lead.trial_attendance_corrected', targetType: 'lead', targetId: before.id,
    before: { trialAttendedAt: stored.toISOString(), revision: before.revision },
    after: { trialAttendedAt: trialAttendedAt.toISOString(), revision: before.revision + 1 },
    occurredAt: now, createdAt: now });
}
export function advanceLeadOnCheckIn(tx: Transaction, input: StageInput) { return advance(tx, input, 'trial_attended'); }
export function markLeadWon(tx: Transaction, input: StageInput, options: StageOptions = {}) { return advance(tx, input, 'won', options); }
