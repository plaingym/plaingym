// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, notInArray } from 'drizzle-orm';
import { auditEvents, classCreditEntries, classPackSales, forGym, invoiceLineItems, paymentAttempts, payments, refunds } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../../core/clock.js';
import { notFound } from '../../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import type { MembershipLifecycle } from '../../../core/interfaces/membership-lifecycle.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import type { Jobs, JobContext } from '../../../infra/jobs/index.js';
import type { Payments, Refund } from '../../../infra/payments/index.js';
import type { TransitionNotifications } from './notifications.js';
import { retryAt } from '../runner/eligibility.js';
import { createPackCredits } from '../packs/credits.js';
import { pastRefundWindow, sameRefund, settleLapsed } from './lapsed-refunds.js';
import { abandonedAttempt, audit, effectCompleted, effectCreated, effectPublished, lockInvoice, recorded, snapshot, terminal,
  type TransitionEffect } from './store.js';

export const effectJob = 'billing.transitions.effect';
/** How far back the publisher looks. A publish normally follows its commit at once, or within the hour. */
export const publishWindowDays = 30;
/** A release is committed just before the refund that caused it. Waiting lets the notice's amount count that refund. */
export const releasedNoticeDelayMs = 15 * 60_000;
export interface TransitionEffectOptions {
  scope?: typeof forGym;
  clock?: Clock;
  jobs: Jobs;
  settings: GymSettingsAccessor;
  transitions: InvoiceTransitions;
  memberships: MembershipLifecycle;
  payments(gymId: string): Promise<Payments>;
  notifications: TransitionNotifications;
  /** Charge runner must recheck unpaid state and expire/reconcile Checkout before charging. */
  retry(invoiceId: string, context: JobContext): Promise<void>;
  /** Runs after a paid or zero-settled invoice's memberships are activated, however it was paid. It may run again
   * until the effect completes, so it must be idempotent; throwing retries the effect job. */
  afterInvoicePaid?(gymId: string, invoiceId: string): Promise<void>;
}
export function createTransitionEffects(options: TransitionEffectOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const credits = createPackCredits({ scope, clock, settings: options.settings });
  const system = (gymId: string) => ({ gymId, actor: { kind: 'system' as const } });
  async function publish(gymId: string) {
    const gym = await options.settings.get(gymId);
    // Effects are published right after their transition commits, or by the hourly sweep. Searching a bounded
    // window keeps this on the (gym, time) audit index instead of scanning the gym's whole audit history.
    const since = new Date(clock.now().getTime() - publishWindowDays * 86_400_000);
    const rows = await scope(gymId, tx => tx.select().from(auditEvents).where(and(
      eq(auditEvents.action, effectCreated), gte(auditEvents.occurredAt, since), notInArray(auditEvents.targetId,
        tx.select({ id: auditEvents.targetId }).from(auditEvents)
          .where(and(eq(auditEvents.action, effectPublished), gte(auditEvents.occurredAt, since))))))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id)).limit(100));
    for (const row of rows) {
      const work = row.after as TransitionEffect;
      const runAt = work.kind === 'retry' ? retryAt(localDate(row.occurredAt, gym.timezone), work.retryDay!, gym.timezone)
        : work.notice === 'duplicate_released' ? new Date(clock.now().getTime() + releasedNoticeDelayMs) : clock.now();
      await options.jobs.enqueue(effectJob, { effectId: row.targetId },
        { gymId, timezone: gym.timezone, runAt, idempotencyKey: row.targetId, maxAttempts: 12 });
      await scope(gymId, async tx => {
        await lockInvoice(tx, work.invoiceId);
        if (!await recorded(tx, effectPublished, row.targetId))
          await audit(tx, system(gymId), clock, effectPublished, 'invoice_effect', row.targetId, { invoiceId: work.invoiceId });
      });
    }
    return rows.length;
  }
  async function run(effectId: string, context: JobContext) {
    const { gymId } = context;
    const loaded = await scope(gymId, async tx => {
      const event = await recorded(tx, effectCreated, effectId) ?? notFound();
      if (await recorded(tx, effectCompleted, effectId)) return null;
      const work = event.after as TransitionEffect;
      const invoice = await lockInvoice(tx, work.invoiceId);
      const payment = work.paymentId ? (await tx.select().from(payments).where(eq(payments.id, work.paymentId)))[0] : undefined;
      if (payment && payment.invoiceId !== invoice.id) notFound();
      const refund = (work.notice === 'refund_failed' || work.notice === 'refund_released') && work.refundId
        ? (await tx.select().from(refunds).where(eq(refunds.id, work.refundId)))[0] : undefined;
      if (refund && refund.paymentId !== payment?.id) notFound();
      const refunded = work.notice === 'duplicate_released' && payment
        ? await tx.select({ amountCents: refunds.amountCents }).from(refunds).where(and(eq(refunds.paymentId, payment.id), eq(refunds.status, 'succeeded'))) : [];
      // A refund that failed after it was reported successful gets its own wording.
      const reversed = refund ? Boolean(await recorded(tx, 'billing.refund.reversed', refund.id)) : false;
      const attempt = work.attemptId ? (await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, work.attemptId)))[0] : undefined;
      // An attempt abandoned before the card was charged never replaces the failure a member must hear about.
      const latestAttempt = (await tx.select().from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoice.id))
        .orderBy(asc(paymentAttempts.attemptNumber))).filter(row => !abandonedAttempt(row)).at(-1);
      const lines = work.kind === 'activate_memberships' ? await tx.select({ membershipId: invoiceLineItems.membershipId })
        .from(invoiceLineItems).where(and(eq(invoiceLineItems.invoiceId, invoice.id), eq(invoiceLineItems.kind, 'membership'))) : [];
      // A class pack sale's credits: those not granted (an erased member), or those a full refund took back before it failed.
      const [sale] = work.notice === 'credits_not_granted' || work.notice === 'refund_failed'
        ? await tx.select().from(classPackSales).where(eq(classPackSales.invoiceId, invoice.id)) : [];
      const reversedCredits = sale && work.notice === 'refund_failed'
        ? (await tx.select({ credits: classCreditEntries.credits }).from(classCreditEntries).where(and(
          eq(classCreditEntries.saleId, sale.id), eq(classCreditEntries.kind, 'reverse')))).reduce((total, row) => total - row.credits, 0) : 0;
      return { event, work, invoice, payment, refund, refunded, reversed, attempt, latestAttempt, lines, sale, reversedCredits };
    });
    if (!loaded) return;
    const { work, invoice, payment, refund, refunded, reversed, attempt, latestAttempt, lines, sale, reversedCredits } = loaded;
    const data = { gymId, generation: effectId, invoice: snapshot(invoice), ...(payment ? { payment } : {}) };
    if (work.kind === 'receipt') await options.notifications.receipt(data);
    else if (work.kind === 'activate_memberships') {
      for (const membershipId of new Set(lines.map(line => line.membershipId).filter((id): id is string => id !== null))) {
        const membership = await options.memberships.get(gymId, membershipId);
        if (membership.householdId !== invoice.householdId) throw new Error('Membership household mismatch');
        // Never resume a frozen membership or revive a cancellation because an old invoice was paid.
        if (membership.status === 'pending' || membership.status === 'trial')
          await options.memberships.activate(system(gymId), { membershipId, revision: membership.revision });
      }
      await credits.grant(gymId, invoice.id);
      await options.afterInvoicePaid?.(gymId, invoice.id);
    } else if (work.kind === 'reverse_credits') {
      await credits.reverse(gymId, invoice.id);
    } else if (work.kind === 'dunning') {
      if (invoice.kind === 'cycle' && !terminal(invoice) && attempt?.id === latestAttempt?.id)
        await options.notifications.dunning({ ...data, actionRequired: attempt?.status === 'requires_action' });
    } else if (work.kind === 'retry') {
      if (invoice.kind === 'cycle' && !terminal(invoice) && (await options.settings.get(gymId)).billingEnabled)
        await options.retry(invoice.id, context);
    } else if (work.kind === 'staff_notice') {
      if (work.notice === 'duplicate_released') {
        if (!payment) throw new Error('Released duplicate refund notice has no payment');
        // Only recorded refunds count: a pending one can still be canceled, and then nothing else would say so.
        const unrefundedCents = refunded.reduce((left, row) => left - row.amountCents, payment.amountCents);
        if (unrefundedCents > 0) await options.notifications.staffNotice({ ...data, reason: 'duplicate_released', unrefundedCents });
      } else if (work.notice === 'credits_not_granted') {
        if (!sale) throw new Error('Credits notice has no class pack sale');
        await options.notifications.staffNotice({ ...data, reason: 'credits_not_granted', credits: sale.credits });
      } else if (work.notice === 'refund_released') {
        if (!refund) throw new Error('Released refund notice has no refund');
        await options.notifications.staffNotice({ ...data, reason: 'refund_released', refund });
      } else if (work.notice !== 'refund_failed') await options.notifications.staffNotice(data);
      else if (refund) await options.notifications.staffNotice({ ...data, reason: 'refund_failed', refund, reversed,
        ...(reversedCredits > 0 ? { reversedCredits } : {}) });
      else throw new Error('Failed refund notice has no refund');
    }
    else if (work.kind === 'refund_duplicate') {
      if (!payment || !work.refundId || !payment.paymentIntentId) throw new Error('Duplicate payment has no processor identity');
      const reservation = await scope(gymId, async tx => (await tx.select().from(refunds).where(eq(refunds.id, work.refundId!)))[0] ?? notFound());
      // A failed or canceled refund is final (the transition that recorded a failure or a release queued its staff
      // notice), so this work is done.
      if (reservation.status === 'pending') {
        const provider = await options.payments(gymId);
        let refund: Refund | undefined;
        if (reservation.processorId) {
          const found = await provider.readPaymentObject({ kind: 'refund', id: reservation.processorId });
          if (found.status !== 'found' || found.value.kind !== 'refund') throw new Error('Refund cannot be reconciled');
          refund = found.value.object;
        } else {
          // A lost response must be reconciled before another refund request, including after process restart. A tagged
          // reservation takes only the refund that names it; any other is external, which the webhook records. An
          // untagged one, from before the marker, can only match by its payment.
          const lapsed = () => reservation.taggedAt !== null && pastRefundWindow(reservation, clock);
          const settle = () => settleLapsed({ scope, clock, transitions: options.transitions }, system(gymId), async () => provider, payment, [reservation]);
          if (lapsed()) await settle();
          else {
            const tag = reservation.taggedAt ? { reservationId: reservation.id } : {};
            const matches = new Map<string, Refund>();
            if (reservation.taggedAt) {
              for (const refund of await provider.listRefunds(payment.paymentIntentId))
                if (refund.reservationId === reservation.id) matches.set(refund.id, refund);
            } else {
              let cursor: string | undefined;
              do {
                const page = await provider.listChangesSince(reservation.createdAt, cursor ? { cursor } : {});
                for (const change of page.changes) if (change.kind === 'refund'
                  && [payment.chargeId, payment.paymentIntentId].includes(change.object.chargeId)) matches.set(change.object.id, change.object);
                cursor = page.nextCursor ?? undefined;
              } while (cursor !== undefined);
            }
            if (matches.size > 1) throw new Error('Ambiguous duplicate refund; staff resolution required');
            refund = [...matches.values()][0];
            // The window may have passed while Stripe was read: a tagged reservation is then settled like any lapsed one.
            if (!refund && lapsed()) await settle();
            else if (!refund) {
              if (pastRefundWindow(reservation, clock))
                throw new Error('Refund idempotency window elapsed; reconciliation required');
              refund = await provider.refund({ chargeId: payment.paymentIntentId, amount: payment.amountCents,
                idempotencyKey: `invoice:${invoice.id}:duplicate:${payment.id}`, ...tag });
            }
          }
        }
        if (refund) {
          if (!sameRefund(refund, payment, payment, gymId)) throw new Error('Refund identity or money mismatch');
          await options.transitions.refund(system(gymId), { invoiceId: invoice.id, paymentId: payment.id,
            refundId: reservation.id, processorId: refund.id, amountCents: refund.amount,
            currency: payment.currency, status: refund.status });
        }
      }
    }
    await scope(gymId, async tx => {
      await lockInvoice(tx, invoice.id);
      if (!await recorded(tx, effectCompleted, effectId)) await audit(tx, system(gymId), clock,
        effectCompleted, 'invoice_effect', effectId, { invoiceId: invoice.id });
    });
  }
  return { publish, run };
}
export type TransitionEffects = ReturnType<typeof createTransitionEffects>;
