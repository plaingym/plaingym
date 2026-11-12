// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, lt, notInArray } from 'drizzle-orm';
import { auditEvents, forGym, households, householdUsers, invoiceLineItems, invoices, leads, members, memberships,
  paymentMethods, signedLinks, waiverSignatures, writeAudit, type Transaction } from '@plaingym/db';
import { z } from 'zod';
import type { Clock } from '@plaingym/shared';
import { dateSchema, idSchema } from '@plaingym/shared/contracts';
import { voidAbandonedJoinInvoice } from '../../areas/billing/transitions/join-cleanup.js';
import type { Uploads } from '../../infra/storage/index.js';
import { logError } from '../../core/log.js';
import { joinAdmissionExpired } from './join.expiry.js';

export const joinCleanupJob = 'public.join.cleanup';
const dayMs = 86_400_000;
const record = z.object({ memberIds: z.array(idSchema).min(1).max(6) });
const admission = record.extend({ joinedOn: dateSchema });
export interface JoinCleanupOptions {
  scope?: typeof forGym;
  clock: Clock;
  uploadsFor(gymId: string): Promise<Uploads>;
}
export function createJoinCleanup(options: JoinCleanupOptions) {
  const scope = options.scope ?? forGym, clock = options.clock;
  const audit = (tx: Transaction, gymId: string, action: string, householdId: string) =>
    writeAudit(tx, { gymId, actorKind: 'system', action, targetType: 'household', targetId: householdId, occurredAt: clock.now() });
  async function remove(gymId: string, householdId: string) {
    const uploads = await options.uploadsFor(gymId);
    const ids = await scope(gymId, async tx => {
      const [home] = await tx.select().from(households).where(eq(households.id, householdId)).for('update');
      const [event] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'public.join.admitted'), eq(auditEvents.targetId, householdId))).limit(1);
      if (!event) return null;
      if ((await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, householdId),
        inArray(auditEvents.action, ['public.join.submitting', 'public.join.received', 'public.join.completed', 'public.join.cleaned']))).limit(1)).length) return null;
      const parsed = record.parse(event.after);
      // Rows are removed before storage I/O. The admission's audit retains the image prefixes for crash recovery.
      if ((await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, householdId), eq(auditEvents.action, 'public.join.cleanup.started'))).limit(1)).length)
        return parsed.memberIds;
      if (!home) return null;
      if (home.revision !== 1) return null;
      const people = await tx.select().from(members).where(eq(members.householdId, householdId)).for('update');
      // Staff may have adopted an abandoned prospect or attached records. Keep that work.
      if (people.some(p => !parsed.memberIds.includes(p.id) || p.status !== 'prospect' || p.anonymizedAt || p.revision !== 1)) return null;
      if ((await tx.select({ id: waiverSignatures.id }).from(waiverSignatures).where(inArray(waiverSignatures.memberId, parsed.memberIds)).limit(1)).length) return null;
      // A lead row (a staff edit or logged contact on the Leads screen, or a check-in) is staff work on the prospect too,
      // and its foreign key would refuse the member's deletion. The member locks above hold off a new one.
      if ((await tx.select({ id: leads.id }).from(leads).where(inArray(leads.memberId, parsed.memberIds)).limit(1)).length) return null;
      const subscriptions = await tx.select().from(memberships).where(eq(memberships.householdId, householdId)).for('update');
      if (subscriptions.some(m => m.status !== 'pending' || !parsed.memberIds.includes(m.memberId))) return null;
      if ((await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.householdId, householdId)).limit(1)).length
        || (await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.householdId, householdId)).limit(1)).length) return null;
      const links = await tx.select({ id: signedLinks.id }).from(signedLinks).where(eq(signedLinks.householdId, householdId)).for('update');
      const bills = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.householdId, householdId)).for('update');
      // A join creates exactly one invoice. Additional staff billing makes this household ineligible.
      if (bills.length > 1 || bills[0] && !await voidAbandonedJoinInvoice(tx, gymId, householdId, bills[0].id, clock)) return null;
      if (links.length && !bills.length) return null;
      // This durable claim makes a racing submission fail before signing. Failed storage work can retry.
      await audit(tx, gymId, 'public.join.cleanup.started', householdId);
      // Remove under the same locks as the eligibility check: a staff signature cannot race file deletion.
      await tx.update(invoiceLineItems).set({ membershipId: null }).where(eq(invoiceLineItems.householdId, householdId));
      await tx.delete(memberships).where(eq(memberships.householdId, householdId));
      await tx.delete(members).where(and(eq(members.householdId, householdId), inArray(members.id, parsed.memberIds)));
      await tx.update(signedLinks).set({ revokedAt: clock.now() }).where(eq(signedLinks.householdId, householdId));
      // Accounting retains its household and invoice, but the abandoned prospects are removed.
      if (!bills.length) await tx.delete(households).where(eq(households.id, householdId));
      return parsed.memberIds;
    });
    if (!ids) return false;
    for (const id of ids) for (const image of await uploads.list(`${gymId}/waivers/${id}/signatures/`)) await uploads.markDeleted(image.key);
    await scope(gymId, async tx => {
      const [event] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, householdId), eq(auditEvents.action, 'public.join.admitted')));
      if (event && !(await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, householdId), eq(auditEvents.action, 'public.join.cleaned'))).limit(1)).length)
        await audit(tx, gymId, 'public.join.cleaned', householdId);
    });
    return true;
  }
  async function run(gymId: string, timezone: string) {
    const before = new Date(clock.now().getTime() - dayMs);
    let removed = 0, cursor: string | undefined, failure: { error: unknown } | undefined;
    for (;;) {
      const rows = await scope(gymId, tx => tx.select({ id: auditEvents.id, householdId: auditEvents.targetId, after: auditEvents.after }).from(auditEvents).where(and(
        eq(auditEvents.action, 'public.join.admitted'), lt(auditEvents.occurredAt, before), notInArray(auditEvents.targetId,
          tx.select({ id: auditEvents.targetId }).from(auditEvents).where(inArray(auditEvents.action,
            ['public.join.submitting', 'public.join.received', 'public.join.completed', 'public.join.cleaned']))), cursor ? gt(auditEvents.id, cursor) : undefined))
        .orderBy(asc(auditEvents.id)).limit(100));
      // One failing household must not hold back the rest of the gym's cleanup; the run still fails so the job retries it.
      for (const row of rows) {
        try {
          if (joinAdmissionExpired(admission.parse(row.after).joinedOn, clock.now(), timezone) && await remove(gymId, row.householdId)) removed++;
        }
        catch (error) { failure ??= { error }; logError('public.join.cleanup_failed', { gymId, householdId: row.householdId }, error); }
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
    if (failure) throw failure.error;
    return removed;
  }
  return { run, remove };
}
