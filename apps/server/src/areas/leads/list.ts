// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, ilike, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { forGym, leads, members, uuidv7, writeAudit, revisionGuard, assertRevised, RevisionConflictError, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';

const memberFields = { memberId: members.id, householdId: members.householdId, firstName: members.firstName,
  lastName: members.lastName, email: members.email, phone: members.phone, status: members.status, createdAt: members.createdAt };
type Person = { [K in keyof typeof memberFields]: (typeof members.$inferSelect)[K extends 'memberId' ? 'id' : K] };
type Lead = typeof leads.$inferSelect;
const eligible = and(isNull(members.anonymizedAt), or(isNotNull(leads.id), inArray(members.status, ['prospect', 'trial'])));
const join = and(eq(leads.gymId, members.gymId), eq(leads.memberId, members.id));
function detail(person: Person, lead: Lead | null | undefined) {
  return c.leadDetailSchema.parse({ ...person, source: lead?.source ?? null, stage: lead?.stage ?? 'new',
    revision: lead?.revision ?? 0, nextFollowUpOn: lead?.nextFollowUpOn ?? null,
    lastContactedAt: lead?.lastContactedAt?.toISOString() ?? null, createdAt: person.createdAt.toISOString(),
    lostReason: lead?.lostReason ?? null });
}
function missing(): never { throw new AppError('not_found', 'Lead not found'); }
function conflict(): never { throw new AppError('conflict', 'This lead stage cannot be changed this way'); }

export function createLeadsService(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  async function mutate(context: MutationContext, memberId: string, revision: number,
    action: string, changes: (before: Lead | undefined, now: Date) => Partial<Lead>) {
    return scope(context.gymId, async tx => {
      // Block erasure until this edit commits. Lock the member before a lead key,
      // matching erasure and the automatic-stage path's first insert.
      const [person] = await tx.select(memberFields).from(members)
        .where(and(eq(members.id, memberId), isNull(members.anonymizedAt))).for('share');
      if (!person) missing();
      const [before] = await tx.select().from(leads).where(eq(leads.memberId, memberId)).for('update');
      if (!before && !['prospect', 'trial'].includes(person.status)) missing();
      if ((before?.revision ?? 0) !== revision) throw new RevisionConflictError();
      const now = clock.now(), patch = changes(before, now);
      let row: Lead;
      if (before) {
        const guard = revisionGuard(leads.revision, revision);
        row = assertRevised(await tx.update(leads).set({ ...patch, revision: guard.next })
          .where(and(eq(leads.id, before.id), guard.matches)).returning());
      } else {
        row = assertRevised(await tx.insert(leads).values({ ...patch, id: uuidv7(now.getTime()), gymId: context.gymId,
          memberId, createdAt: now, revision: 1 }).onConflictDoNothing({ target: [leads.gymId, leads.memberId] }).returning());
      }
      await audit(tx, context, action, before, row, now);
      return { data: detail(person, row) };
    });
  }
  return {
    async list(gym: { gymId: string; timezone: string }, input: c.LeadListQuery = {}) {
      const query = c.leadListQuerySchema.parse(input);
      const stages = query.stage ? (Array.isArray(query.stage) ? query.stage : [query.stage])
        : c.leadStageSchema.options.filter(stage => query.includeLost || stage !== 'lost');
      const pattern = query.search ? '%' + query.search.replace(/[\\%_]/g, '\\$&') + '%' : undefined;
      const where = and(eligible,
        or(inArray(leads.stage, stages), stages.includes('new') ? isNull(leads.id) : undefined),
        query.source === 'unknown' ? isNull(leads.source) : query.source ? eq(leads.source, query.source) : undefined,
        query.due ? and(inArray(leads.stage, ['new', 'contacted', 'trial_booked', 'trial_attended']),
          lte(leads.nextFollowUpOn, localDate(clock.now(), gym.timezone))) : undefined,
        pattern ? or(ilike(members.firstName, pattern), ilike(members.lastName, pattern)) : undefined);
      return scope(gym.gymId, async tx => {
        const groups = await tx.select({ stage: leads.stage, count: count() }).from(members).leftJoin(leads, join)
          .where(where).groupBy(leads.stage);
        const counts = { new: 0, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 };
        for (const group of groups) counts[c.leadStageSchema.parse(group.stage ?? 'new')] += group.count;
        const rows = await tx.select({ person: memberFields, lead: leads }).from(members).leftJoin(leads, join)
          .where(where).orderBy(asc(members.lastName), asc(members.firstName), asc(members.id)).limit(query.limit).offset(query.offset);
        return { data: rows.map(row => c.leadSchema.strip().parse(detail(row.person, row.lead))), counts,
          pagination: { limit: query.limit, offset: query.offset, total: Object.values(counts).reduce((a, b) => a + b, 0) } };
      });
    },
    async read(gymId: string, memberId: string) {
      return scope(gymId, async tx => {
        const [row] = await tx.select({ person: memberFields, lead: leads }).from(members).leftJoin(leads, join)
          .where(and(eligible, eq(members.id, memberId)));
        if (!row) missing();
        return { data: detail(row.person, row.lead) };
      });
    },
    async edit(context: MutationContext, memberId: string, input: c.UpdateLeadRequest) {
      const { revision, ...patch } = c.updateLeadRequestSchema.parse(input);
      return mutate(context, memberId, revision, 'lead.updated', (before, now) => {
        if (patch.stage && (patch.stage === 'won' || patch.stage === 'lost' || before?.stage === 'won' || before?.stage === 'lost')) conflict();
        return { ...(patch.source !== undefined ? { source: patch.source } : {}),
          ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
          ...(patch.nextFollowUpOn !== undefined ? { nextFollowUpOn: patch.nextFollowUpOn } : {}),
          ...(patch.stage === 'trial_attended' ? { trialAttendedAt: before?.trialAttendedAt ?? now } : {}) };
      });
    },
    async lost(context: MutationContext, memberId: string, input: c.LoseLeadRequest) {
      const { revision, reason } = c.loseLeadRequestSchema.parse(input);
      return mutate(context, memberId, revision, 'lead.lost', (before, now) => {
        if (before?.stage === 'won' || before?.stage === 'lost') conflict();
        return { stage: 'lost', lostReason: reason, lostAt: now };
      });
    },
    async reopen(context: MutationContext, memberId: string, input: c.ReopenLeadRequest) {
      const { revision } = c.reopenLeadRequestSchema.parse(input);
      return mutate(context, memberId, revision, 'lead.reopened', before => {
        if (before?.stage !== 'lost') conflict();
        return { stage: 'contacted', lostReason: null, lostAt: null };
      });
    },
  };
}
async function audit(tx: Transaction, context: MutationContext, action: string, before: Lead | undefined, after: Lead, now: Date) {
  const fields = (lead: Lead | undefined) => ({ stage: lead?.stage ?? 'new', source: lead?.source ?? null,
    nextFollowUpOn: lead?.nextFollowUpOn ?? null, revision: lead?.revision ?? 0 });
  await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}), action,
    targetType: 'lead', targetId: after.id, before: fields(before), after: fields(after), occurredAt: now, createdAt: now });
}
