// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gt, inArray, lt, notExists } from 'drizzle-orm';
import { auditEvents, forGym, households, householdUsers, invoiceLineItems, invoices, leads, members, memberships,
  paymentMethods, signedLinks, waiverSignatures, writeAudit, type Transaction } from '@plaingym/db';
import { z } from 'zod';
import type { Clock } from '@plaingym/shared';
import { dateSchema, idSchema } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { checkSubmittedJoin, joinFollowedUp, submittedJoinSessions, voidAbandonedJoinInvoice, voidSubmittedJoin,
  type SubmittedJoin } from '../../areas/billing/transitions/join-cleanup.js';
import { endDiscount, liveDiscounts, releaseDiscountUses } from '../../areas/billing/discounts/apply.js';
import { createMembershipService } from '../../areas/billing/memberships.js';
import type { Payments } from '../../infra/payments/index.js';
import type { Uploads } from '../../infra/storage/index.js';
import { logError, logInfo } from '../../core/log.js';
import { joinAdmissionExpired, unpaidJoinExpired } from './join.expiry.js';

export const joinCleanupJob = 'public.join.cleanup';
const dayMs = 86_400_000;
const record = z.object({ memberIds: z.array(idSchema).min(1).max(6) });
const admission = record.extend({ joinedOn: dateSchema });
const excludedActions = ['public.join.submitting', 'public.join.received', 'public.join.completed', 'public.join.cleaned', 'public.join.retained'];
/** A submitted join that completed, was voided or is kept for staff is never voided. */
const settledActions = ['public.join.completed', 'public.join.voided', 'public.join.retained', 'public.join.cleanup.started', 'public.join.cleaned'];
/** The parts of `public.join.received` and `public.join.discounted` (join.service.ts) the void reads. */
const submitted = z.object({ invoiceId: idSchema, linkId: idSchema, membershipIds: z.array(idSchema).min(1).max(6) });
const discountedRecord = z.object({ discountId: idSchema, uses: z.int32().positive() });
export interface JoinCleanupOptions {
  scope?: typeof forGym;
  clock: Clock;
  uploadsFor(gymId: string): Promise<Uploads>;
  /** Confirms a submitted join's Checkout sessions closed before its invoice is voided. Without it (or with no provider
   * configured), a join that started a Checkout is never voided; one that never started one still is. */
  paymentsFor?(gymId: string): Promise<Payments | null>;
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
        inArray(auditEvents.action, excludedActions))).limit(1)).length) return null;
      const retain = async () => { await audit(tx, gymId, 'public.join.retained', householdId); return null; };
      const parsed = record.parse(event.after);
      // Rows are removed before storage I/O. The admission's audit retains the image prefixes for crash recovery.
      if ((await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, householdId), eq(auditEvents.action, 'public.join.cleanup.started'))).limit(1)).length)
        return parsed.memberIds;
      if (!home || home.revision !== 1) return retain();
      const people = await tx.select().from(members).where(eq(members.householdId, householdId)).for('update');
      // Staff may have adopted an abandoned prospect or attached records. Keep that work.
      if (people.some(p => !parsed.memberIds.includes(p.id) || p.status !== 'prospect' || p.anonymizedAt || p.revision !== 1)) return retain();
      if ((await tx.select({ id: waiverSignatures.id }).from(waiverSignatures).where(inArray(waiverSignatures.memberId, parsed.memberIds)).limit(1)).length) return retain();
      // A lead row (a staff edit or logged contact on the Leads screen, or a check-in) is staff work on the prospect too,
      // and its foreign key would refuse the member's deletion. The member locks above hold off a new one.
      if ((await tx.select({ id: leads.id }).from(leads).where(inArray(leads.memberId, parsed.memberIds)).limit(1)).length) return retain();
      const subscriptions = await tx.select().from(memberships).where(eq(memberships.householdId, householdId)).for('update');
      if (subscriptions.some(m => m.status !== 'pending' || !parsed.memberIds.includes(m.memberId))) return retain();
      if ((await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.householdId, householdId)).limit(1)).length
        || (await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.householdId, householdId)).limit(1)).length) return retain();
      const links = await tx.select({ id: signedLinks.id }).from(signedLinks).where(eq(signedLinks.householdId, householdId)).for('update');
      const bills = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.householdId, householdId)).for('update');
      // A join creates exactly one invoice. Additional staff billing makes this household ineligible.
      if (bills.length > 1 || bills[0] && !await voidAbandonedJoinInvoice(tx, gymId, householdId, bills[0].id, clock)) return retain();
      if (links.length && !bills.length) return retain();
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
  /**
   * Voids a submitted join whose first invoice is still unpaid from the seventh gym-local day after submission: its invoice
   * voided and link revoked, its pending memberships cancelled, and the uses its code took given back, once. The prospects,
   * their signed waivers and leads, the household and the invoice stay for staff follow-up, as a retained admission's do.
   * Returns whether it voided the join.
   */
  async function voidUnpaid(gymId: string, householdId: string, timezone: string) {
    const read = async (tx: Transaction) => {
      const [event] = await tx.select({ after: auditEvents.after, occurredAt: auditEvents.occurredAt }).from(auditEvents)
        .where(and(eq(auditEvents.action, 'public.join.received'), eq(auditEvents.targetId, householdId))).limit(1);
      if (!event || (await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.targetId, householdId),
        inArray(auditEvents.action, settledActions))).limit(1)).length) return null;
      if (!unpaidJoinExpired(localDate(event.occurredAt, timezone), clock.now(), timezone)) return null;
      const join: SubmittedJoin & z.infer<typeof submitted> = { ...submitted.parse(event.after), householdId };
      return join;
    };
    const found = await scope(gymId, async tx => {
      const join = await read(tx);
      // A join staff followed up on is kept below: its sessions, a payer's live one among them, are left alone.
      return join && { join, sessions: await joinFollowedUp(tx, join) ? [] : await submittedJoinSessions(tx, join) };
    });
    if (!found) return false;
    // Each session the join's link started must be confirmed closed by the provider, outside any transaction. A completed
    // one may hold a payment not yet recorded: the join waits for it.
    const closed = new Set<string>();
    if (found.sessions.length) {
      const provider = await options.paymentsFor?.(gymId);
      if (!provider) return false;
      for (const id of found.sessions) {
        const expiry = await provider.expireCheckout(id);
        if (expiry.status !== 'expired') {
          logInfo('public.join.void_waiting', { gymId, householdId, checkout: expiry.status });
          return false;
        }
        closed.add(id);
      }
    }
    return scope(gymId, async tx => {
      const [home] = await tx.select({ id: households.id }).from(households).where(eq(households.id, householdId)).for('update');
      const join = home ? await read(tx) : null;
      if (!join) return false;
      const check = await checkSubmittedJoin(tx, join, closed, clock);
      const retain = async () => { await audit(tx, gymId, 'public.join.retained', householdId); return false; };
      if (check.outcome !== 'ready') return check.outcome === 'keep' ? retain() : false;
      const rows = await tx.select().from(memberships).where(eq(memberships.householdId, householdId)).for('update');
      // Staff added or started a membership, or linked a login: the household is theirs to follow up.
      if (rows.length !== join.membershipIds.length || rows.some(m => !join.membershipIds.includes(m.id) || m.status !== 'pending')
        || (await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.householdId, householdId)).limit(1)).length)
        return retain();
      await voidSubmittedJoin(tx, gymId, join, check.invoice, clock);
      const context = { gymId, actor: { kind: 'system' as const } };
      const [record] = await tx.select({ after: auditEvents.after }).from(auditEvents)
        .where(and(eq(auditEvents.action, 'public.join.discounted'), eq(auditEvents.targetId, householdId))).limit(1);
      const discounted = record ? discountedRecord.parse(record.after) : null;
      const live = await liveDiscounts(tx, rows.map(m => m.id));
      // The membership service runs in this transaction, so the void, the cancellations and the release commit together.
      const within = createMembershipService({ scope: async (_gymId, work) => work(tx), clock });
      for (const membership of rows) {
        // Only the code's application is released; cancelling ends any other one as staff cancelling would.
        if (discounted && live.get(membership.id)?.discountId === discounted.discountId) await endDiscount(tx, context, clock, membership.id, 'released');
        await within.cancel(context, { membershipId: membership.id, revision: membership.revision });
      }
      // The voided record below, under the household lock, is what keeps a replay or a second run from releasing again.
      const released = discounted ? await releaseDiscountUses(tx, context, clock, discounted.discountId, discounted.uses) : 0;
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'public.join.voided', targetType: 'household', targetId: householdId,
        occurredAt: clock.now(), after: { invoiceId: join.invoiceId, linkId: join.linkId, membershipIds: join.membershipIds,
          ...(discounted ? { discountId: discounted.discountId, usesReleased: released } : {}) } });
      return true;
    });
  }
  async function voidExpired(gymId: string, timezone: string) {
    // A coarse bound: seven local days are never less than five elapsed, even across a daylight saving change.
    const before = new Date(clock.now().getTime() - 5 * dayMs);
    let voided = 0, cursor: string | undefined, failure: { error: unknown } | undefined;
    for (;;) {
      const rows = await scope(gymId, tx => {
        const joins = tx.select({ id: auditEvents.id, householdId: auditEvents.targetId, occurredAt: auditEvents.occurredAt })
          .from(auditEvents).where(eq(auditEvents.action, 'public.join.received')).as('joins');
        return tx.select({ id: joins.id, householdId: joins.householdId }).from(joins).where(and(
          lt(joins.occurredAt, before), notExists(tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
            eq(auditEvents.targetId, joins.householdId), inArray(auditEvents.action, settledActions)))), cursor ? gt(joins.id, cursor) : undefined))
          .orderBy(asc(joins.id)).limit(100);
      });
      for (const row of rows) {
        try { if (await voidUnpaid(gymId, row.householdId, timezone)) voided++; }
        catch (error) { failure ??= { error }; logError('public.join.void_failed', { gymId, householdId: row.householdId }, error); }
      }
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
    return { voided, failure };
  }
  /** The nightly run: removes expired unsubmitted admissions, then voids unpaid submitted joins. Returns how many of each. */
  async function run(gymId: string, timezone: string) {
    const admissions = await removeExpired(gymId, timezone), joins = await voidExpired(gymId, timezone);
    const failure = admissions.failure ?? joins.failure;
    if (failure) throw failure.error;
    return admissions.removed + joins.voided;
  }
  async function removeExpired(gymId: string, timezone: string) {
    const before = new Date(clock.now().getTime() - dayMs);
    let removed = 0, cursor: string | undefined, failure: { error: unknown } | undefined;
    for (;;) {
      const rows = await scope(gymId, tx => {
        const admissions = tx.select({ id: auditEvents.id, householdId: auditEvents.targetId, after: auditEvents.after, occurredAt: auditEvents.occurredAt })
          .from(auditEvents).where(eq(auditEvents.action, 'public.join.admitted')).as('admissions');
        return tx.select({ id: admissions.id, householdId: admissions.householdId, after: admissions.after }).from(admissions).where(and(
          lt(admissions.occurredAt, before), notExists(tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
            eq(auditEvents.targetId, admissions.householdId), inArray(auditEvents.action, excludedActions)))), cursor ? gt(admissions.id, cursor) : undefined))
          .orderBy(asc(admissions.id)).limit(100);
      });
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
    return { removed, failure };
  }
  return { run, remove, voidUnpaid };
}
