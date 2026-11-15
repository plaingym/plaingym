// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, lte, notExists } from 'drizzle-orm';
import { announcementOptOuts, announcementRecipients, attendances, auditEvents, classBookings, classCreditEntries, classPackSales,
  forGym, households, householdUsers, invoices, leadContacts, leads, memberRanks, members, memberships, memberTagLinks,
  paymentMethods, signedLinks, staffProfiles, waiverSignatures, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { Uploads } from '../../infra/storage/index.js';
import { logError } from '../../core/log.js';

export const dropInCleanupJob = 'public.drop_in.cleanup';
export const dropInAdmissionWindowMs = 24 * 60 * 60 * 1000;
const excluded = ['public.drop_in.received', 'public.drop_in.cleaned', 'public.drop_in.retained'];
export function createDropInCleanup(options: { scope?: typeof forGym; clock: Clock; uploadsFor(gymId: string): Promise<Uploads> }) {
  const scope = options.scope ?? forGym, clock = options.clock;
  const audit = (tx: Transaction, gymId: string, action: string, memberId: string) => writeAudit(tx,
    { gymId, actorKind: 'system', action, targetType: 'member', targetId: memberId, occurredAt: clock.now() });
  async function remove(gymId: string, memberId: string) {
    const uploads = await options.uploadsFor(gymId);
    const claimed = await scope(gymId, async tx => {
      const [admission] = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, memberId),
        eq(auditEvents.action, 'public.drop_in.admitted'))).limit(1);
      if (!admission || admission.occurredAt.getTime() + dropInAdmissionWindowMs > clock.now().getTime()) return false;
      const [person] = await tx.select().from(members).where(eq(members.id, memberId));
      // Audits are append-only: serialize the first claim on the household, then reread its markers.
      // After deletion, retries only repeat idempotent storage work and append a completion marker.
      const [home] = person ? await tx.select().from(households).where(eq(households.id, person.householdId)).for('update') : [];
      const records = await tx.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.targetId, memberId));
      if (records.some(r => excluded.includes(r.action))) return false;
      if (records.some(r => r.action === 'public.drop_in.cleanup.started')) return true;
      const retain = async () => { await audit(tx, gymId, 'public.drop_in.retained', memberId); return false; };
      if (!person) return retain();
      const people = await tx.select().from(members).where(eq(members.householdId, person.householdId)).for('update');
      const fresh = people.find(p => p.id === memberId);
      // Any signed waiver, including a partially submitted visit, must keep its immutable images.
      if (!home || home.revision !== 1 || people.length !== 1 || !fresh || fresh.status !== 'prospect'
        || fresh.anonymizedAt || fresh.revision !== 1
        || (await tx.select({ id: waiverSignatures.id }).from(waiverSignatures).where(eq(waiverSignatures.memberId, memberId)).limit(1)).length) return retain();
      const [lead] = await tx.select().from(leads).where(eq(leads.memberId, memberId)).for('update');
      if (lead && (lead.source !== 'drop_in' || lead.stage !== 'new' || lead.revision !== 1
        || (await tx.select({ id: leadContacts.id }).from(leadContacts).where(eq(leadContacts.leadId, lead.id)).limit(1)).length)) return retain();
      // Staff may have attached billing, account or enrollment work without changing the prospect.
      for (const table of [memberships, invoices, signedLinks, householdUsers, paymentMethods]) {
        if ((await tx.select({ id: table.id }).from(table).where(eq(table.householdId, home.id)).limit(1)).length) return retain();
      }
      // Check-ins, bookings, tags, ranks, credits, mail and staff profiles reference the member and would block its deletion.
      for (const table of [attendances, classBookings, memberTagLinks, memberRanks, classPackSales, classCreditEntries,
        announcementRecipients, announcementOptOuts, staffProfiles]) {
        if ((await tx.select({ memberId: table.memberId }).from(table).where(eq(table.memberId, memberId)).limit(1)).length) return retain();
      }
      await audit(tx, gymId, 'public.drop_in.cleanup.started', memberId);
      if (lead) await tx.delete(leads).where(eq(leads.id, lead.id));
      await tx.delete(members).where(eq(members.id, memberId));
      await tx.delete(households).where(eq(households.id, home.id));
      return true;
    });
    if (!claimed) return false;
    // Storage is outside transactions; the admission and started marker survive interruption for retry.
    for (const image of await uploads.list(`${gymId}/waivers/${memberId}/signatures/`)) await uploads.markDeleted(image.key);
    await scope(gymId, async tx => {
      const [admission] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, memberId),
        eq(auditEvents.action, 'public.drop_in.admitted')));
      if (admission && !(await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, memberId),
        eq(auditEvents.action, 'public.drop_in.cleaned'))).limit(1)).length) await audit(tx, gymId, 'public.drop_in.cleaned', memberId);
    });
    return true;
  }
  async function run(gymId: string) {
    const before = new Date(clock.now().getTime() - dropInAdmissionWindowMs);
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
        try { if (row.memberId && await remove(gymId, row.memberId)) removed++; }
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
