// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq } from 'drizzle-orm';
import { forGym, leadContacts, leads, members, staffProfiles, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { createLeadMutation, eligible, join, missing } from './list.js';

/** Contacts are logged by a signed-in staff user, who is recorded on the row. */
export interface ContactContext { readonly gymId: string; readonly actor: { readonly kind: 'user'; readonly userId: string } }
type ContactRow = typeof leadContacts.$inferSelect;
function contact(row: ContactRow, createdByName: string | null) {
  return c.leadContactSchema.parse({ id: row.id, occurredAt: row.occurredAt.toISOString(), channel: row.channel,
    note: row.note, createdBy: row.createdBy, createdByName });
}

export function createLeadContactsService(options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const scope = options.scope ?? forGym, mutate = createLeadMutation(options);
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
      const result = await mutate(context, memberId, revision, 'lead.contacted', (before, now) => ({
        lastContactedAt: now, ...(nextFollowUpOn !== undefined ? { nextFollowUpOn } : {}),
        ...(!before || before.stage === 'new' ? { stage: 'contacted' } : {}),
      }), async (tx, _before, lead, now) => {
        const [row] = await tx.insert(leadContacts).values({ id: uuidv7(now.getTime()), gymId: context.gymId, leadId: lead.id,
          occurredAt: now, channel, note: note || null, createdBy: context.actor.userId, createdAt: now }).returning();
        const [profile] = await tx.select({ name: staffProfiles.displayName }).from(staffProfiles)
          .where(eq(staffProfiles.userId, context.actor.userId));
        return { value: contact(row!, profile?.name ?? null), audit: { channel, contactId: row!.id } };
      });
      return { data: { lead: result.data, contact: result.value! } };
    },
  };
}
