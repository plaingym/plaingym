// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Match linked IDs in gym-scoped audit JSON and bound reset history by audit time.
import { and, asc, eq, exists, gt, gte, inArray, isNull, lte, max, notExists, notInArray, sql, type SQL } from 'drizzle-orm';
import { auditEvents, classCreditEntries, classPackSales, forGym, invoiceLineItems, invoices, paymentAttempts, payments, refunds, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { ExhaustedEffect } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../../core/clock.js';
import { logError } from '../../../core/log.js';
import { conflict, notFound, type MutationContext } from '../../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import type { MembershipLifecycle } from '../../../core/interfaces/membership-lifecycle.js';
import type { GymSettings, GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import type { Jobs, JobContext, JobRecovery } from '../../../infra/jobs/index.js';
import { withJobTransaction } from '../../../infra/jobs/index.js';
import type { Payments, Refund } from '../../../infra/payments/index.js';
import type { TransitionNotifications } from './notifications.js';
import { retryAt } from '../runner/eligibility.js';
import { retriesStopped } from './bank.js';
import { createPackCredits } from '../packs/credits.js';
import { pastRefundWindow, sameRefund, settleLapsed } from './lapsed-refunds.js';
import { abandonedAttempt, audit, effectCompleted, effectCreated, effectPublished, lockInvoice, recorded, snapshot, systemContext as system, terminal,
  type TransitionEffect } from './store.js';

export const effectJob = 'billing.transitions.effect';
/** How far back the publisher looks. A publish normally follows its commit at once, or within the hour. */
export const publishWindowDays = 30;
export const effectRecoveryDelayMs = 15 * 60_000, effectRecoveryLimit = 5;
/** Queue attempts for one effect job, whether published or enqueued again by a staff Retry. */
const effectMaxAttempts = 12;
export const effectRetried = 'billing.transition.effect.retried';
export const effectRecoveryExhausted = 'billing.transition.effect.recovery_exhausted';
export const effectStaffRetried = 'billing.transition.effect.staff_retried';
export const effectDismissed = 'billing.transition.effect.dismissed';
function openExhaustions(tx: Transaction, gymId: string, effectId?: string) {
  const exhausted = tx.select({ id: auditEvents.id, effectId: auditEvents.targetId, at: auditEvents.occurredAt })
    .from(auditEvents).where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, effectRecoveryExhausted),
      effectId ? eq(auditEvents.targetId, effectId) : undefined)).as('exhausted_effect');
  const forEffect = (action: string, match?: SQL) => tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), eq(auditEvents.action, action), eq(auditEvents.targetId, exhausted.effectId),
    match));
  return tx.select({ id: exhausted.id, effectId: exhausted.effectId, exhaustedAt: exhausted.at }).from(exhausted).where(and(
    notExists(forEffect(effectCompleted)), notExists(forEffect(effectDismissed)),
    notExists(forEffect(effectStaffRetried, eq(sql`${auditEvents.after}->>'exhaustedId'`, sql`${exhausted.id}::text`)))))
    .orderBy(asc(exhausted.at), asc(exhausted.id));
}
function recoveryHistory(tx: Transaction, gymId: string, effectId: string) {
  const lastStaffRetry = tx.select({ at: max(auditEvents.occurredAt) }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), eq(auditEvents.action, effectStaffRetried), eq(auditEvents.targetId, effectId)));
  return tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
    eq(auditEvents.gymId, gymId), eq(auditEvents.action, effectRetried), eq(auditEvents.targetId, effectId),
    gt(auditEvents.occurredAt, sql`coalesce((${lastStaffRetry}), '-infinity'::timestamptz)`))).limit(effectRecoveryLimit);
}
/** The Health tile's count: the open exhaustions alone, so the tile stays in error even if the list can't load. */
export async function countExhaustedEffects(gymId: string, scope: typeof forGym = forGym): Promise<number> {
  return scope(gymId, async tx => (await openExhaustions(tx, gymId)).length);
}
/** Independent of queue retention: Health reads the durable outbox, including arbitrarily old effects. */
export async function listExhaustedEffects(gymId: string, scope: typeof forGym = forGym): Promise<ExhaustedEffect[]> {
  return scope(gymId, async tx => {
    const exhausted = await openExhaustions(tx, gymId);
    if (!exhausted.length) return [];
    const created = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, effectCreated),
      inArray(auditEvents.targetId, exhausted.map(row => row.effectId))));
    const work = new Map(created.map(row => [row.targetId, row.after as TransitionEffect]));
    const bills = await tx.select().from(invoices).where(inArray(invoices.id, [...work.values()].map(row => row.invoiceId)));
    const byInvoice = new Map(bills.map(row => [row.id, row]));
    const paymentIds = [...work.values()].flatMap(row => row.kind === 'refund_duplicate' && row.paymentId ? [row.paymentId] : []);
    const paid = paymentIds.length ? await tx.select().from(payments).where(inArray(payments.id, paymentIds)) : [];
    return exhausted.map(row => {
      const effect = work.get(row.effectId) ?? notFound(), bill = byInvoice.get(effect.invoiceId) ?? notFound();
      const payment = paid.find(payment => payment.id === effect.paymentId && payment.invoiceId === bill.id);
      if (effect.kind === 'refund_duplicate' && !payment) notFound();
      return { effectId: row.effectId, invoiceId: bill.id, number: bill.number, kind: effect.kind,
        refund: effect.kind === 'refund_duplicate' && payment ? { amountCents: payment.amountCents, currency: payment.currency } : null,
        exhaustedAt: row.exhaustedAt.toISOString() };
    });
  });
}
export interface TransitionEffectOptions {
  scope?: typeof forGym;
  clock?: Clock;
  jobs: Jobs;
  /** The runtime's queue recovery capability; the hourly sweep resets the original exhausted jobs. */
  recovery?: JobRecovery;
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
  async function effectState(tx: Transaction, gymId: string, effectId: string) {
    const event = await recorded(tx, effectCreated, effectId) ?? notFound();
    const work = event.after as TransitionEffect;
    await lockInvoice(tx, work.invoiceId);
    const completed = await recorded(tx, effectCompleted, effectId), dismissed = await recorded(tx, effectDismissed, effectId);
    const [exhausted] = await openExhaustions(tx, gymId, effectId).limit(1);
    return { work, completed, dismissed, exhausted };
  }
  async function retryEffect(context: MutationContext, effectId: string) {
    const recovery = options.recovery;
    if (!recovery) conflict('Effect recovery is unavailable');
    const gym = await options.settings.get(context.gymId);
    return withJobTransaction(scope, context.gymId, async transaction => {
      const { tx } = transaction, state = await effectState(tx, context.gymId, effectId);
      if (state.completed || state.dismissed) conflict('Effect is completed or dismissed');
      if (!state.exhausted) {
        if (await recorded(tx, effectStaffRetried, effectId)) return { changed: false };
        conflict('Effect has not exhausted recovery');
      }
      const [failed] = await recovery.failedJobs(effectJob, [effectId], { gymId: context.gymId }, transaction);
      if (!failed || !await recovery.retryFailed(failed.jobId, { gymId: context.gymId, runAt: clock.now() }, transaction))
        await options.jobs.enqueue(effectJob, { effectId }, { gymId: context.gymId, timezone: gym.timezone,
        idempotencyKey: effectId, runAt: clock.now(), maxAttempts: effectMaxAttempts }, transaction);
      await audit(tx, context, clock, effectStaffRetried, 'invoice_effect', effectId,
        { invoiceId: state.work.invoiceId, kind: state.work.kind, exhaustedId: state.exhausted.id });
      return { changed: true };
    });
  }
  async function dismissEffect(context: MutationContext, effectId: string) {
    const recovery = options.recovery;
    return withJobTransaction(scope, context.gymId, async transaction => {
      const { tx } = transaction, state = await effectState(tx, context.gymId, effectId);
      if (state.completed || state.dismissed || !state.exhausted) conflict('Effect is no longer exhausted');
      if (recovery?.acknowledgeFailed) {
        const [failed] = await recovery.failedJobs(effectJob, [effectId], { gymId: context.gymId }, transaction);
        if (failed) await recovery.acknowledgeFailed(failed.jobId, { gymId: context.gymId, at: clock.now() }, transaction);
      }
      await audit(tx, context, clock, effectDismissed, 'invoice_effect', effectId,
        { invoiceId: state.work.invoiceId, kind: state.work.kind, reason: 'handled_by_hand' });
      return { changed: true };
    });
  }
  async function settleZeroInvoices(gymId: string, settings?: GymSettings) {
    const gym = settings ?? await options.settings.get(gymId);
    const rows = await scope(gymId, tx => tx.select({ id: invoices.id }).from(invoices).where(and(
      eq(invoices.kind, 'one_off'), eq(invoices.amountCents, 0), inArray(invoices.status, ['open', 'past_due']),
      lte(invoices.dueOn, localDate(clock.now(), gym.timezone)), isNull(invoices.checkoutSessionId),
      // A held invoice waits for staff, as it does in the charge runner.
      eq(invoices.needsReview, false)))
      .orderBy(asc(invoices.dueOn), asc(invoices.id)).limit(100));
    // One invoice that can't settle (voided meanwhile, say) doesn't hold up the rest; the job still fails after them.
    let failure: unknown;
    for (const row of rows) {
      try { await options.transitions.settleZero(system(gymId), { invoiceId: row.id }); }
      catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
    return rows.length;
  }
  async function publish(gymId: string, settings?: GymSettings) {
    const gym = settings ?? await options.settings.get(gymId);
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
      const canceled = work.kind === 'retry' && await scope(gymId, tx => recorded(tx, retriesStopped, work.invoiceId));
      const runAt = work.kind === 'retry' ? retryAt(localDate(row.occurredAt, gym.timezone), work.retryDay!, gym.timezone)
        : clock.now();
      if (!canceled) await options.jobs.enqueue(effectJob, { effectId: row.targetId },
        { gymId, timezone: gym.timezone, runAt, idempotencyKey: row.targetId, maxAttempts: effectMaxAttempts });
      await scope(gymId, async tx => {
        await lockInvoice(tx, work.invoiceId);
        if (!await recorded(tx, effectPublished, row.targetId))
          await audit(tx, system(gymId), clock, effectPublished, 'invoice_effect', row.targetId, { invoiceId: work.invoiceId });
      });
    }
    return rows.length;
  }
  async function recoverFailed(gymId: string) {
    const recovery = options.recovery;
    let recovered = 0, exhausted = 0;
    if (!recovery) return { recovered, exhausted };
    let cursor: string | undefined;
    for (;;) {
      // Each correlated lookup uses (gym_id, action, target_id), including for old effects.
      const rows = await scope(gymId, tx => {
        const created = tx.select({ id: auditEvents.id, targetId: auditEvents.targetId })
          .from(auditEvents).where(eq(auditEvents.action, effectCreated)).as('created_effect');
        const auditFor = (action: string) => tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
          eq(auditEvents.gymId, gymId), eq(auditEvents.action, action), eq(auditEvents.targetId, created.targetId)));
        const open = openExhaustions(tx, gymId).as('open_exhaustions');
        return tx.select({ id: created.id, effectId: created.targetId })
          .from(created).where(and(cursor ? gt(created.id, cursor) : undefined, exists(auditFor(effectPublished)),
            notExists(auditFor(effectCompleted)), notExists(auditFor(effectDismissed)),
            notInArray(created.targetId, tx.select({ effectId: open.effectId }).from(open))))
          .orderBy(asc(created.id)).limit(100);
      });
      if (!rows.length) break;
      for (const job of await recovery.failedJobs(effectJob, rows.map(row => row.effectId), { gymId })) {
        const effectId = job.idempotencyKey;
        try {
          // A spent budget can be exhausted immediately. Check it without locking the invoice while backoff is active.
          if (clock.now().getTime() - job.failedAt.getTime() < effectRecoveryDelayMs) {
            const history = await scope(gymId, tx => recoveryHistory(tx, gymId, effectId));
            if (history.length < effectRecoveryLimit) continue;
          }
          const outcome = await withJobTransaction(scope, gymId, async transaction => {
            const { tx } = transaction, state = await effectState(tx, gymId, effectId);
            if (state.completed || state.dismissed || state.exhausted) return 'none';
            const [current] = await recovery.failedJobs(effectJob, [effectId], { gymId }, transaction);
            if (!current) return 'none';
            const { work } = state;
            const history = await recoveryHistory(tx, gymId, effectId);
            if (history.length >= effectRecoveryLimit) {
              await audit(tx, system(gymId), clock, effectRecoveryExhausted, 'invoice_effect', effectId,
                { invoiceId: work.invoiceId, kind: work.kind, jobId: current.jobId, resets: history.length });
              return 'exhausted';
            }
            const now = clock.now(), delayMs = effectRecoveryDelayMs * 2 ** history.length;
            if (now.getTime() - current.failedAt.getTime() < delayMs) return 'none';
            if (!await recovery.retryFailed(current.jobId, { gymId, runAt: now }, transaction)) return 'none';
            await audit(tx, system(gymId), clock, effectRetried, 'invoice_effect', effectId,
              { invoiceId: work.invoiceId, jobId: current.jobId, delayMs });
            return 'recovered';
          });
          if (outcome === 'exhausted') exhausted++;
          if (outcome === 'recovered') recovered++;
        } catch (error) {
          logError('billing.transition.effect.recovery_failed', { gymId, effectId, jobId: job.jobId }, error);
        }
      }
      cursor = rows.at(-1)!.id;
    }
    return { recovered, exhausted };
  }
  async function run(effectId: string, context: JobContext) {
    const { gymId } = context;
    const loaded = await scope(gymId, async tx => {
      const event = await recorded(tx, effectCreated, effectId) ?? notFound();
      const work = event.after as TransitionEffect;
      const invoice = await lockInvoice(tx, work.invoiceId);
      if (await recorded(tx, effectCompleted, effectId) || await recorded(tx, effectDismissed, effectId)) return null;
      const payment = work.paymentId ? (await tx.select().from(payments).where(eq(payments.id, work.paymentId)))[0] : undefined;
      if (payment && payment.invoiceId !== invoice.id) notFound();
      const refund = (work.notice === 'refund_failed' || work.notice === 'refund_canceled' || work.notice === 'refund_released'
        || work.notice === 'refund_missing' || work.notice === 'refund_arrived') && work.refundId
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
      const [sale] = work.kind === 'activate_memberships' || work.notice === 'credits_not_granted' || work.notice === 'refund_failed'
        ? await tx.select().from(classPackSales).where(eq(classPackSales.invoiceId, invoice.id)) : [];
      const reversedCredits = sale && work.notice === 'refund_failed'
        ? (await tx.select({ credits: classCreditEntries.credits }).from(classCreditEntries).where(and(
          eq(classCreditEntries.saleId, sale.id), eq(classCreditEntries.kind, 'reverse')))).reduce((total, row) => total - row.credits, 0) : 0;
      const retryStopped = work.kind === 'retry' && await recorded(tx, retriesStopped, invoice.id);
      return { event, work, invoice, payment, refund, refunded, reversed, attempt, latestAttempt, lines, sale, reversedCredits, retryStopped };
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
      if (sale) await credits.grant(gymId, invoice.id);
      await options.afterInvoicePaid?.(gymId, invoice.id);
    } else if (work.kind === 'reverse_credits') {
      await credits.reverse(gymId, invoice.id);
    } else if (work.kind === 'dunning') {
      const bankFailure = work.bankCode || work.checkoutBankFailure;
      if ((invoice.kind === 'cycle' || bankFailure) && ['open', 'past_due'].includes(invoice.status)
        && (bankFailure && !work.attemptId || attempt?.id === latestAttempt?.id))
        await options.notifications.dunning({ ...data, actionRequired: attempt?.status === 'requires_action',
          ...(work.bankCode ? { bankCode: work.bankCode } : {}) });
    } else if (work.kind === 'retry') {
      if (!loaded.retryStopped && (invoice.kind === 'cycle' || invoice.status === 'past_due') && !terminal(invoice)
        && invoice.status !== 'processing' && (await options.settings.get(gymId)).billingEnabled)
        await options.retry(invoice.id, context);
    } else if (work.kind === 'staff_notice') {
      if (work.notice === 'duplicate_released') {
        if (!payment) throw new Error('Released duplicate refund notice has no payment');
        // Only succeeded refunds count; a pending one may still fail or be canceled.
        const unrefundedCents = refunded.reduce((left, row) => left - row.amountCents, payment.amountCents);
        if (unrefundedCents > 0) await options.notifications.staffNotice({ ...data, reason: 'duplicate_released', unrefundedCents });
      } else if (work.notice === 'credits_not_granted') {
        if (!sale) throw new Error('Credits notice has no class pack sale');
        await options.notifications.staffNotice({ ...data, reason: 'credits_not_granted', credits: sale.credits });
      } else if (work.notice === 'refund_canceled') {
        if (!refund) throw new Error('Canceled refund notice has no refund');
        await options.notifications.staffNotice({ ...data, reason: 'refund_canceled', refund });
      } else if (work.notice === 'refund_released') {
        if (!refund) throw new Error('Released refund notice has no refund');
        await options.notifications.staffNotice({ ...data, reason: 'refund_released', refund });
      } else if (work.notice === 'refund_arrived') {
        if (!refund) throw new Error('Late refund notice has no refund');
        // A later processor failure has its own notice; don't send an obsolete success correction after it.
        if (refund.status === 'succeeded') await options.notifications.staffNotice({ ...data, reason: 'refund_arrived', refund });
      } else if (work.notice === 'refund_missing') {
        if (!refund) throw new Error('Missing refund notice has no refund');
        await options.notifications.staffNotice({ ...data, reason: 'refund_missing', refund });
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
  const settings = (gymId: string) => options.settings.get(gymId);
  return { publish, run, settleZeroInvoices, recoverFailed, settings, retryEffect, dismissEffect,
    exhaustedEffects: (gymId: string) => listExhaustedEffects(gymId, scope) };
}
export type TransitionEffects = ReturnType<typeof createTransitionEffects>;
