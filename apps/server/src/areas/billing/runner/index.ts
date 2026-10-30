// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNull, lt, lte, notExists, or } from 'drizzle-orm';
import { auditEvents, forGym, households, invoices, memberships, paymentAttempts, paymentMethods, uuidv7, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { addDays, localDate } from '@plaingym/shared/time';
import { clock as defaultClock } from '../../../core/clock.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import type { InvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import type { JobContext, Jobs } from '../../../infra/jobs/index.js';
import { isProviderOutage, type Payments } from '../../../infra/payments/index.js';
import type { MutationContext } from '../../../core/interfaces/common.js';
import { logError, logInfo } from '../../../core/log.js';
import { assignmentInvoices, audit, generateCycle, system } from './store.js';
import { createReconciliation } from './reconciliation.js';
import type { DisputeRefundOptions } from '../disputes-refunds.js';
import { assignmentInvoiceCondition, eligibility, isAssignmentInvoice, skipped, type ChargeMode, type Skipped } from './eligibility.js';
import { abandonedAttempt, createAbandoned } from '../transitions/store.js';
import { releaseActionNeeded, releaseCheckout } from './releases.js';
export { releaseActionNeeded, releaseCheckout } from './releases.js';

export type ChargeOptions = { mode?: 'automatic' | 'retry' } | { mode: 'staff'; context: MutationContext };
export type ChargeResult = Skipped | { status: 'succeeded' | 'failed' | 'action_required' | 'pending' | 'unknown' | 'settled_zero' };
export interface CollectionError { invoiceId: string; }
/** The daily run's job. A stopped collection enqueues it again as its continuation. */
export const dailyRunJob = 'billing.runner.daily';
/** Consecutive provider outage errors that stop the daily collection, and how long its continuation waits. */
const outageLimit = 3, continueAfterMs = 3_600_000;

export interface RunnerOptions {
  scope?: typeof forGym;
  clock?: Clock;
  settings: GymSettingsAccessor;
  transitions: InvoiceTransitions;
  jobs: Pick<Jobs, 'enqueue'>;
  payments(gymId: string): Promise<Payments>;
  /** Publishes owner alerts for disputes that restore reconciliation records. */
  disputeAlerts?: DisputeRefundOptions['disputeAlerts'];
  /** Must exceed the provider's entire request/retry timeout. Default: fifteen minutes. */
  staleAfterMs?: number;
}
export function createChargeRunner(options: RunnerOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const reconciliation = createReconciliation({ ...options, scope, clock });
  async function reserve(context: MutationContext, invoiceId: string, mode: ChargeMode, expiredSession: string | null) {
    const { gymId } = context;
    const gym = await options.settings.get(gymId);
    return scope(gymId, async tx => {
      const check = await eligibility(tx, gym, clock, invoiceId, mode, true);
      if (check.status === 'skipped') return check;
      const { invoice, latest, payment } = check;
      if (!payment) return skipped('not_payable'); // Zero settlement does not reserve an attempt.
      if (invoice.checkoutSessionId !== expiredSession) return skipped('checkout_changed');
      // A newer action-needed attempt must be cancelled before this reservation can proceed.
      if (latest?.status === 'requires_action') return skipped('action_required');
      const attempt = (await tx.insert(paymentAttempts).values({ id: uuidv7(), gymId, invoiceId,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1, amountCents: invoice.amountCents,
        currency: invoice.currency, stripeCustomerId: payment.customerId, savedPaymentMethod: payment.methodId,
        status: 'pending', createdAt: clock.now() }).returning())[0]!;
      await audit(tx, context, clock, 'billing.runner.reserved', 'payment_attempt', attempt.id,
        { invoiceId, attemptNumber: attempt.attemptNumber, mode });
      return { status: 'reserved' as const, attempt };
    });
  }
  /** Rechecks eligibility under the invoice lock. Provider exceptions leave a pending attempt for reconciliation. */
  async function charge(gymId: string, invoiceId: string, request: ChargeOptions = {}): Promise<ChargeResult> {
    const mode = request.mode ?? 'automatic';
    const context = request.mode === 'staff' ? request.context : system(gymId);
    if (context.gymId !== gymId || request.mode === 'staff' && context.actor.kind !== 'user')
      throw new Error('Staff charge requires this gym and a user actor');
    const gym = await options.settings.get(gymId);
    const check = await scope(gymId, tx => eligibility(tx, gym, clock, invoiceId, mode));
    if (check.status === 'skipped') return check;
    const { invoice, latest } = check;
    if (invoice.amountCents === 0) {
      const result = await options.transitions.settleZero(context, { invoiceId });
      return result.outcome === 'applied' ? { status: 'settled_zero' } : skipped('not_payable');
    }
    const provider = await options.payments(gymId);
    if (latest?.status === 'requires_action') {
      if (!latest.paymentIntentId) throw new Error('Action-needed attempt has no PaymentIntent ID');
      if (await releaseActionNeeded(gymId, latest.paymentIntentId, provider, reconciliation, context) === 'paid') return skipped('not_payable');
    }
    if (invoice.checkoutSessionId) {
      const released = await releaseCheckout(gymId, invoiceId, invoice.checkoutSessionId, provider, reconciliation, scope, context);
      if (released === 'paid') return skipped('not_payable');
      if (released === 'changed') return skipped('checkout_changed');
    }
    const reservation = await reserve(context, invoiceId, mode, null);
    if (reservation.status === 'skipped') return reservation;
    const { attempt } = reservation;
    let createStarted = false;
    try {
      // Adoption is idempotent and refuses a stored customer belonging to another gym.
      await provider.adoptCustomer(attempt.stripeCustomerId);
      if (!(await options.settings.get(gymId)).billingEnabled) return skipped('billing_disabled');
      createStarted = true;
    } finally {
      if (!createStarted) await scope(gymId, async tx => {
        const changed = await tx.update(paymentAttempts).set({ status: 'failed', declineCode: createAbandoned, resolvedAt: clock.now() })
          .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, 'pending'),
            isNull(paymentAttempts.paymentIntentId), isNull(paymentAttempts.resolvedAt))).returning();
        if (changed.length) await audit(tx, context, clock, 'billing.runner.create_abandoned', 'payment_attempt', attempt.id, { invoiceId });
      });
    }
    const key = `${invoiceId}:${attempt.attemptNumber}`;
    const intent = await provider.createCharge({ amount: attempt.amountCents, currency: attempt.currency.toLowerCase(),
      customerId: attempt.stripeCustomerId, paymentMethodId: attempt.savedPaymentMethod,
      invoiceId, attemptId: attempt.id, idempotencyKey: `${key}:create` });
    const saved = await scope(gymId, async tx => {
      const changed = await tx.update(paymentAttempts).set({ paymentIntentId: intent.id }).where(and(
        eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, 'pending'),
        isNull(paymentAttempts.paymentIntentId), isNull(paymentAttempts.resolvedAt))).returning();
      if (changed.length) await audit(tx, context, clock, 'billing.runner.intent_saved', 'payment_attempt', attempt.id,
        { invoiceId, paymentIntentId: intent.id });
      return changed.length > 0;
    });
    if (!saved) {
      // A reconciler invalidated this reservation. This worker must NEVER confirm it.
      const current = await scope(gymId, async tx => (await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id)))[0]);
      if (current?.paymentIntentId !== intent.id) await provider.cancelCharge(intent.id);
      return skipped('reservation_lost');
    }
    const stillEligible = await scope(gymId, async tx => {
      const row = (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)))[0];
      if (!row || !['open', 'past_due'].includes(row.status) || row.checkoutSessionId || row.needsReview) return false;
      const home = (await tx.select().from(households).where(eq(households.id, row.householdId)))[0];
      const card = (await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(and(
        eq(paymentMethods.householdId, row.householdId), eq(paymentMethods.processorId, attempt.savedPaymentMethod), isNull(paymentMethods.revokedAt))))[0];
      return home?.stripeCustomerId === attempt.stripeCustomerId && !!card;
    });
    const enabled = (await options.settings.get(gymId)).billingEnabled;
    if (!stillEligible || !enabled) {
      await reconciliation.apply(gymId, await provider.cancelCharge(intent.id), context);
      return skipped(enabled ? 'collection_changed' : 'billing_disabled');
    }
    const outcome = await provider.confirmCharge(intent.id, { idempotencyKey: `${key}:confirm` });
    const applied = await reconciliation.apply(gymId, outcome, context);
    if (!applied && outcome.status !== 'unknown' && outcome.status !== 'pending')
      throw new Error('Charge outcome requires reconciliation');
    return { status: outcome.status };
  }
  /** With `stopAfter`, that many consecutive provider outage errors stop the collection; the rest stays uncollected. */
  async function collect(gymId: string, due: readonly { id: string }[], stopAfter = Infinity) {
    const errors: CollectionError[] = [];
    let attempted = 0, outages = 0, stopped = false;
    for (const invoice of due) {
      try {
        // A skip may never have reached the provider, so only a charge outcome shows that it answered.
        if ((await charge(gymId, invoice.id)).status !== 'skipped') { attempted++; outages = 0; }
      } catch (error) {
        errors.push({ invoiceId: invoice.id });
        logError('billing.runner.charge_failed', { gymId, invoiceId: invoice.id }, error);
        outages = isProviderOutage(error) ? outages + 1 : 0;
        // Each remaining charge would wait out the provider's whole timeout and fail the same way.
        if (outages >= stopAfter) { stopped = true; break; }
      }
    }
    return { attempted, errors, stopped };
  }
  async function collectAssigned(gymId: string, householdId: string) {
    const due = await scope(gymId, async tx => {
      const rows = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.householdId, householdId),
        eq(invoices.kind, 'one_off'), eq(invoices.status, 'open'))).orderBy(asc(invoices.dueOn), asc(invoices.id));
      const eligible = [];
      for (const row of rows) if (await isAssignmentInvoice(tx, row.id) && !(await tx.select({ id: paymentAttempts.id })
        .from(paymentAttempts).where(eq(paymentAttempts.invoiceId, row.id)).limit(1)).length) eligible.push(row);
      return eligible;
    });
    // Assigned collection never stops early, so its result keeps the counts and errors only.
    const { attempted, errors } = await collect(gymId, due);
    return { attempted, errors };
  }
  /**
   * Generates due cycles and collects due invoices. After three consecutive provider outage errors it stops
   * (`stopped`) and enqueues one continuation an hour later, keyed by its gym-local date. A continuation (`continues`
   * names the stopped run's date) that stops again queues nothing: the next daily run collects the rest.
   */
  async function daily(gymId: string, run: { continues?: string } = {}) {
    const gym = await options.settings.get(gymId);
    if (!gym.billingEnabled) return { generatedPeriods: 0, attempted: 0, errors: [] as CollectionError[], stopped: false };
    const today = localDate(clock.now(), gym.timezone);
    const homes = await scope(gymId, tx => tx.selectDistinct({ id: memberships.householdId }).from(memberships)
      .where(and(inArray(memberships.status, ['active', 'frozen']), lte(memberships.nextDueOn, today))));
    let generatedPeriods = 0;
    for (const home of homes) {
      while (await scope(gymId, tx => generateCycle(tx, gym, clock, home.id, today))) generatedPeriods++;
    }
    // Also hold invoices issued before the outage, e.g. a gym that was missing its saved card.
    const needsOverdueReview = (tx: Transaction) => and(eq(invoices.status, 'open'), eq(invoices.needsReview, false),
      lt(invoices.dueOn, addDays(today, -7)), or(eq(invoices.kind, 'cycle'), assignmentInvoiceCondition(tx)),
      notExists(tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.gymId, invoices.gymId),
        eq(auditEvents.action, 'billing.invoice.review_released'), eq(auditEvents.targetId, invoices.id)))));
    const overdue = await scope(gymId, tx => tx.select({ id: invoices.id }).from(invoices).where(needsOverdueReview(tx)));
    for (const bill of overdue) await scope(gymId, async tx => {
      const changed = await tx.update(invoices).set({ needsReview: true }).where(and(eq(invoices.id, bill.id),
        needsOverdueReview(tx))).returning();
      if (changed.length) await audit(tx, system(gymId), clock, 'billing.runner.overdue_held', 'invoice', bill.id, { needsReview: true });
    });
    const due = await scope(gymId, tx => tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.status, 'open'),
      eq(invoices.needsReview, false), lte(invoices.dueOn, today), or(eq(invoices.kind, 'cycle'), assignmentInvoiceCondition(tx))))
      .orderBy(asc(invoices.dueOn), asc(invoices.id)));
    const result = await collect(gymId, due, outageLimit);
    if (result.stopped) {
      // The continuation collects what is left, including these abandoned creates. The key makes a replayed run
      // reuse it; a continuation, even one delayed past midnight, never takes the next day's.
      const continuesAt = run.continues ? null : new Date(clock.now().getTime() + continueAfterMs);
      if (continuesAt) await options.jobs.enqueue(dailyRunJob, { continues: today }, { gymId, timezone: gym.timezone,
        runAt: continuesAt, idempotencyKey: `continue:${today}` });
      logInfo('billing.runner.collection_stopped', { gymId, failures: result.errors.length,
        continuesAt: continuesAt?.toISOString() ?? null });
    }
    return { generatedPeriods, ...result };
  }
  async function deferPendingRetry(invoiceId: string, context: JobContext) {
    const latest = await scope(context.gymId, async tx => (await tx.select({ status: paymentAttempts.status,
      declineCode: paymentAttempts.declineCode }).from(paymentAttempts).where(eq(paymentAttempts.invoiceId, invoiceId))
      .orderBy(desc(paymentAttempts.attemptNumber)).limit(1))[0]);
    // Reconciliation may have abandoned the reservation, or cancelled its unconfirmed intent, between charge() and this read.
    if (!latest || latest.status !== 'pending' && !abandonedAttempt(latest)) return;
    // Queue backoff can exhaust before the stale threshold plus the hourly sweep.
    // Commit a continuation before acknowledging this callback. Replays of the same
    // source job reuse it; a continuation can defer again if reconciliation is delayed.
    await options.jobs.enqueue('billing.runner.retry', { invoiceId }, {
      gymId: context.gymId, timezone: context.timezone,
      runAt: new Date(clock.now().getTime() + (options.staleAfterMs ?? 15 * 60_000) + 61 * 60_000),
      idempotencyKey: `pending:${invoiceId}:${context.jobId}`, maxAttempts: 12,
    });
  }
  async function retry(invoiceId: string, context: JobContext) {
    let result: ChargeResult;
    try { result = await charge(context.gymId, invoiceId, { mode: 'retry' }); }
    catch (error) {
      await deferPendingRetry(invoiceId, context);
      throw error;
    }
    if (result.status === 'pending' || result.status === 'unknown'
      || result.status === 'skipped' && result.reason === 'pending_attempt') await deferPendingRetry(invoiceId, context);
  }
  return { daily, charge, collectAssigned, retry, reconcile: reconciliation.pending, postRestore: reconciliation.postRestore,
    onAssigned: assignmentInvoices(clock) };
}
export type ChargeRunner = ReturnType<typeof createChargeRunner>;
