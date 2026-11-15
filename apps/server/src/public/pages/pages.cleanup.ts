// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, exists, gt, inArray, lte, notExists, or } from 'drizzle-orm';
import { announcementOptOuts, announcementRecipients, attendances, auditEvents, classBookings, classCreditEntries, classPackSales,
  forGym, households, householdUsers, invoices, leadContacts, leads, memberRanks, members, memberships, memberTagLinks,
  paymentMethods, signedLinks, staffProfiles, waiverSignatures } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { Uploads } from '../../infra/storage/index.js';
import { logError } from '../../core/log.js';
import { createAdmissionCleanup } from './admission.cleanup.js';

export const dropInCleanupJob = 'public.drop_in.cleanup';
export const dropInAdmissionWindowMs = 24 * 60 * 60 * 1000;
const excluded = ['public.drop_in.received', 'public.drop_in.cleaned', 'public.drop_in.retained'];
export function createDropInCleanup(options: { scope?: typeof forGym; clock: Clock; uploadsFor(gymId: string): Promise<Uploads> }) {
  const scope = options.scope ?? forGym, clock = options.clock;
  const removal = createAdmissionCleanup({ scope, clock, uploadsFor: options.uploadsFor,
    prefix: 'public.drop_in', targetType: 'member', excluded,
    memberIds: admission => [admission.targetId!],
    ready: admission => admission.occurredAt.getTime() + dropInAdmissionWindowMs <= clock.now().getTime(),
    lock: async (tx, memberId) => {
      const [person] = await tx.select().from(members).where(eq(members.id, memberId));
      const [home] = person ? await tx.select().from(households).where(eq(households.id, person.householdId)).for('update') : [];
      const people = home ? await tx.select().from(members).where(eq(members.householdId, home.id)).for('update') : [];
      return { home, people };
    },
    claim: async (tx, _gymId, memberId, { home, people }) => {
      const fresh = people.find(p => p.id === memberId);
      // Any signed waiver, including a partially submitted visit, must keep its immutable images.
      if (!home || home.revision !== 1 || people.length !== 1 || !fresh || fresh.status !== 'prospect'
        || fresh.anonymizedAt || fresh.revision !== 1) return false;
      const [lead] = await tx.select().from(leads).where(eq(leads.memberId, memberId)).for('update');
      if (lead && (lead.source !== 'drop_in' || lead.stage !== 'new' || lead.revision !== 1)) return false;
      // One query checks every attachment under the member/household/lead locks. Foreign keys serialize new
      // references with deletion, and any reference already committed means this prospect belongs to staff.
      const [attached] = await tx.select({ id: members.id }).from(members).where(and(eq(members.id, memberId), or(
        exists(tx.select({ id: waiverSignatures.id }).from(waiverSignatures).where(eq(waiverSignatures.memberId, memberId))),
        lead ? exists(tx.select({ id: leadContacts.id }).from(leadContacts).where(eq(leadContacts.leadId, lead.id))) : undefined,
        ...[memberships, invoices, signedLinks, householdUsers, paymentMethods].map(table =>
          exists(tx.select({ id: table.id }).from(table).where(eq(table.householdId, home.id)))),
        ...[attendances, classBookings, memberTagLinks, memberRanks, classPackSales, classCreditEntries,
          announcementRecipients, announcementOptOuts, staffProfiles].map(table =>
          exists(tx.select({ memberId: table.memberId }).from(table).where(eq(table.memberId, memberId)))),
      ))).limit(1);
      if (attached) return false;
      if (lead) await tx.delete(leads).where(eq(leads.id, lead.id));
      await tx.delete(members).where(eq(members.id, memberId));
      await tx.delete(households).where(eq(households.id, home.id));
      return true;
    },
  });
  const remove = removal.remove;
  async function run(gymId: string) {
    const before = new Date(clock.now().getTime() - dropInAdmissionWindowMs);
    const uploads = removal.uploadsForRun(gymId);
    let removed = 0, cursor: string | undefined, failure: { error: unknown } | undefined;
    for (;;) {
      const rows = await scope(gymId, tx => {
        const admissions = tx.select({ id: auditEvents.id, memberId: auditEvents.targetId, occurredAt: auditEvents.occurredAt })
          .from(auditEvents).where(eq(auditEvents.action, 'public.drop_in.admitted')).as('admissions');
        return tx.select({ id: admissions.id, memberId: admissions.memberId }).from(admissions).where(and(
          lte(admissions.occurredAt, before), notExists(tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
            eq(auditEvents.targetId, admissions.memberId), inArray(auditEvents.action, excluded)))), cursor ? gt(admissions.id, cursor) : undefined))
          .orderBy(asc(admissions.id)).limit(100);
      });
      for (const row of rows) {
        try { if (row.memberId && await remove(gymId, row.memberId, uploads)) removed++; }
        catch (error) { failure ??= { error }; logError('public.drop_in.cleanup_failed', { gymId, memberId: row.memberId }, error); }
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
    if (failure) throw failure.error;
    return removed;
  }
  return { run, remove };
}
