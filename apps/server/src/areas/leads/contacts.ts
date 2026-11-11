// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { forGym, leadContacts, leads, members, staffProfiles, uuidv7, writeAudit, revisionGuard, assertRevised,
  RevisionConflictError } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { detail, eligible, join, memberFields, type Lead } from './list.js';

/** Contacts are logged by a signed-in staff user, who is recorded on the row. */
export interface ContactContext { readonly gymId: string; readonly actor: { readonly kind: 'user'; readonly userId: string } }
type ContactRow = typeof leadContacts.$inferSelect;
function missing(): never { throw new AppError('not_found', 'Lead not found'); }
function contact(row: ContactRow, createdByName: string | null) {
  return c.leadContactSchema.parse({ id: row.id, occurredAt: row.occurredAt.toISOString(), channel: row.channel,
    note: row.note, createdBy: row.createdBy, createdByName });
}

export function createLeadContactsService(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  return {
    /** Newest first. A lead with no row yet has no contacts; an erased, missing or ordinary member is 404. */
    async list(gymId: string, memberId: string, input: c.LeadContactListQuery = {}) {
      const query = c.leadContactListQuerySchema.parse(input);
      return scope(gymId, async tx => {
        const [row] = await tx.select({ leadId: leads.id }).from(members).leftJoin(leads, join)
          .where(and(eligible, eq(members.id, memberId)));
        if (!row) missing();
        const pagination = { limit: query.limit, offset: query.offset, total: 0 };
        if (!row.leadId) return { data: [], pagination };
        const [total] = await tx.select({ value: count() }).from(leadContacts).where(eq(leadContacts.leadId, row.leadId));
        const rows = await tx.select({ row: leadContacts, name: staffProfiles.displayName }).from(leadContacts)
          .leftJoin(staffProfiles, and(eq(staffProfiles.gymId, leadContacts.gymId), eq(staffProfiles.userId, leadContacts.createdBy)))
          .where(eq(leadContacts.leadId, row.leadId))
          .orderBy(desc(leadContacts.occurredAt), desc(leadContacts.id)).limit(query.limit).offset(query.offset);
        return { data: rows.map(item => contact(item.row, item.name)), pagination: { ...pagination, total: total?.value ?? 0 } };
      });
    },
    /** Records a contact now. A `new` lead (or a prospect or trial member without a lead row) becomes `contacted`;
     * later stages keep theirs. The audit holds the channel, never the note. */
    async log(context: ContactContext, memberId: string, input: c.CreateLeadContactRequest) {
      const { revision, channel, note, nextFollowUpOn } = c.createLeadContactRequestSchema.parse(input);
      return scope(context.gymId, async tx => {
        // Lock the member before the lead key, as edits, erasure and automatic stages do; this blocks erasure until commit.
        const [person] = await tx.select(memberFields).from(members)
          .where(and(eq(members.id, memberId), isNull(members.anonymizedAt))).for('share');
        if (!person) missing();
        const [before] = await tx.select().from(leads).where(eq(leads.memberId, memberId)).for('update');
        if (!before && !['prospect', 'trial'].includes(person.status)) missing();
        if ((before?.revision ?? 0) !== revision) throw new RevisionConflictError();
        const now = clock.now();
        const patch: Partial<Lead> = { lastContactedAt: now, ...(nextFollowUpOn !== undefined ? { nextFollowUpOn } : {}),
          ...(!before || before.stage === 'new' ? { stage: 'contacted' } : {}) };
        let lead: Lead;
        if (before) {
          const guard = revisionGuard(leads.revision, revision);
          lead = assertRevised(await tx.update(leads).set({ ...patch, revision: guard.next })
            .where(and(eq(leads.id, before.id), guard.matches)).returning());
        } else {
          lead = assertRevised(await tx.insert(leads).values({ ...patch, id: uuidv7(now.getTime()), gymId: context.gymId,
            memberId, createdAt: now, revision: 1 }).onConflictDoNothing({ target: [leads.gymId, leads.memberId] }).returning());
        }
        const [row] = await tx.insert(leadContacts).values({ id: uuidv7(now.getTime()), gymId: context.gymId, leadId: lead.id,
          occurredAt: now, channel, note: note || null, createdBy: context.actor.userId, createdAt: now }).returning();
        const [profile] = await tx.select({ name: staffProfiles.displayName }).from(staffProfiles)
          .where(eq(staffProfiles.userId, context.actor.userId));
        const fields = (value: Lead | undefined) => ({ stage: value?.stage ?? 'new', nextFollowUpOn: value?.nextFollowUpOn ?? null,
          revision: value?.revision ?? 0 });
        await writeAudit(tx, { gymId: context.gymId, actorKind: 'user', actorUserId: context.actor.userId, action: 'lead.contacted',
          targetType: 'lead', targetId: lead.id, before: fields(before), after: { ...fields(lead), channel, contactId: row!.id },
          occurredAt: now, createdAt: now });
        return { data: { lead: detail(person, lead), contact: contact(row!, profile?.name ?? null) } };
      });
    },
  };
}
