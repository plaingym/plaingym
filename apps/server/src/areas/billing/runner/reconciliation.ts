// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull, lt, lte, not, notExists, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Extract two fields from the gym-scoped late processing audit to match its intent and Stripe generation.
import { sql } from 'drizzle-orm';
import { AppError } from '@plaingym/shared';
import { auditEvents, households, invoices, paymentAttempts, payments, refunds, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import type { ChargeOutcome, CheckoutSession, PaymentObject, PaymentObjectReference, Payments } from '../../../infra/payments/index.js';
import { invoiceLateProcessing, invoiceProcessing } from '../transitions/bank.js';
import { applyChargeOutcome } from '../transitions/outcomes.js';
import { createAbandoned, terminal, terminalInvoiceStatuses } from '../transitions/store.js';
import { createDisputeRefundWriter } from '../disputes-refunds.js';
import { testModeDispute } from '../alerts/disputes.query.js';
import { assertStripeSnapshot, latestTestSwitchId, stripeSwitchSnapshot, stripeWriteScope, StripeTestModeSwitched,
  withProviderWrites } from '../stripe-writes.js';
import { holdRestoreCheckStart, readRestoreCheckStart, stripeConfigStored } from '../../settings/go-live.restore.js';
import { audit, system } from './store.js';
import type { RunnerOptions } from './index.js';
import type { MutationContext } from '../../../core/interfaces/common.js';

export interface ReconciliationIssue { kind: string; id: string; reason: string; }
/** `stripeConfigured` is absent when the check didn't run (a delayed job for an earlier restore). */
export interface RestoreCheck { inspected: number; readyForOwnerReview: boolean; issues: ReconciliationIssue[]; stripeConfigured?: boolean; stripeMode?: 'test' | 'live' | null; }
/** A stored Stripe reference on a gym with no payments provider: connecting Stripe and checking again resolves it. */
export const notConfigured = 'stripe_not_configured';
const checkoutReviewReasons = ['customer_mismatch', 'pending', 'attempt_resolved'] as const;
type CheckoutReview = (typeof checkoutReviewReasons)[number];
export function checkoutNeedsReview(issue: ReconciliationIssue) {
  return issue.kind === 'checkout_debit' && checkoutReviewReasons.some(reason => reason === issue.reason);
}
export const checkoutReviewAction = 'billing.runner.checkout_debit_unresolved';
export const lateProcessingResolved = 'billing.invoice.late_processing_resolved';
type Options = Omit<RunnerOptions, 'jobs'> & Required<Pick<RunnerOptions, 'scope' | 'clock'>>;
type CheckoutDebit = { invoiceId: string; paymentIntentId: string; late: boolean };
/**
 * The open disputes restore reads with the gym's key. One on a Stripe test-mode payment (marked by a switch to live) is in
 * the test account, which the live key can't read; the switch closed those it found. A dispute's own payment is recorded
 * with it (`paymentId` in its `billing.invoice.disputed` audit), so it is skipped when that payment is marked, whatever
 * else paid the invoice. One recorded without it is skipped only when every payment on its invoice is marked.
 */
async function restorableDisputes(tx: Transaction, gymId: string) {
  return tx.select({ id: invoices.id, disputeId: invoices.disputeId }).from(invoices)
    .where(and(eq(invoices.disputeStatus, 'open'), not(testModeDispute(tx, gymId))));
}

async function staleProcessingCheckouts(tx: Transaction, before: Date): Promise<CheckoutDebit[]> {
  const inFlight = tx.select({ id: paymentAttempts.id }).from(paymentAttempts)
    .where(and(eq(paymentAttempts.gymId, invoices.gymId), eq(paymentAttempts.invoiceId, invoices.id),
      inArray(paymentAttempts.status, ['pending', 'processing'])));
  const audits = await tx.select({ invoiceId: invoices.id, occurredAt: auditEvents.occurredAt, after: auditEvents.after })
    .from(invoices).innerJoin(auditEvents, and(eq(auditEvents.gymId, invoices.gymId), eq(auditEvents.targetId, invoices.id),
      eq(auditEvents.targetType, 'invoice'), eq(auditEvents.action, invoiceProcessing)))
    .where(and(eq(invoices.status, 'processing'), notExists(inFlight)));
  const latest = new Map<string, { paymentIntentId: string; sequence: number; occurredAt: Date }>();
  for (const { invoiceId, occurredAt, after } of audits) {
    const event = after as { paymentIntentId: string; sequence: number };
    const previous = latest.get(invoiceId);
    // The transition assigns a sequence under the invoice lock, even when timestamps tie.
    if (!previous || event.sequence > previous.sequence)
      latest.set(invoiceId, { ...event, occurredAt });
  }
  return [...latest].flatMap(([invoiceId, event]) => event.occurredAt < before
    ? [{ invoiceId, paymentIntentId: event.paymentIntentId, late: false }] : []);
}

async function staleLateCheckouts(tx: Transaction, before: Date, switched: string | null): Promise<CheckoutDebit[]> {
  const paymentIntentId = sql<string>`${auditEvents.after}->>'paymentIntentId'`;
  const generation = sql<string>`${auditEvents.after}->>'stripeTestSwitchId'`;
  const paid = tx.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.gymId, invoices.gymId), eq(payments.paymentIntentId, paymentIntentId)));
  const rows = await tx.select({ invoiceId: invoices.id, paymentIntentId }).from(invoices)
    .innerJoin(auditEvents, and(eq(auditEvents.gymId, invoices.gymId), eq(auditEvents.targetId, invoices.id),
      eq(auditEvents.targetType, 'invoice'), eq(auditEvents.action, invoiceLateProcessing)))
    .where(and(inArray(invoices.status, terminalInvoiceStatuses), lt(auditEvents.occurredAt, before),
      switched === null ? isNull(generation) : eq(generation, switched), notExists(paid)));
  if (!rows.length) return [];
  const invoiceIds = [...new Set(rows.map(row => row.invoiceId))];
  const resolutions = await tx.select({ invoiceId: auditEvents.targetId, paymentIntentId }).from(auditEvents)
    .where(and(eq(auditEvents.targetType, 'invoice'), eq(auditEvents.action, lateProcessingResolved),
      inArray(auditEvents.targetId, invoiceIds)));
  const resolved = new Set(resolutions.map(row => `${row.invoiceId}:${row.paymentIntentId}`));
  return rows.filter(row => !resolved.has(`${row.invoiceId}:${row.paymentIntentId}`)).map(row => ({ ...row, late: true }));
}

export function createReconciliation(options: Options) {
  const { clock } = options, scope = stripeWriteScope(options.scope);
  const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error('Invalid reconciliation threshold');
  const writer = createDisputeRefundWriter({ ...options, scope, clock });
  /**
   * The gym's provider, or null when the gym has no payments provider: the runtime's resolver throws `unavailable` only
   * when no Stripe settings are stored (it reads them from the database and makes no Stripe call). Any other failure,
   * such as unreadable settings, stays an error.
   */
  async function configuredProvider(gymId: string): Promise<Payments | null> {
    try { return await options.payments(gymId) as Payments | null; }
    catch (error) { if (error instanceof AppError && error.code === 'unavailable') return null; throw error; }
  }
  /** Returns an issue for an outcome that cannot be applied. Never guesses from search. */
  async function applyOutcome(gymId: string, outcome: ChargeOutcome, context: MutationContext,
    checkout?: CheckoutDebit): Promise<'unresolved' | CheckoutReview | undefined> {
    if (context.gymId !== gymId) throw new Error('Payment outcome actor gym mismatch');
    if (outcome.status === 'unknown' || (checkout ? outcome.id !== checkout.paymentIntentId : outcome.status === 'pending')) return 'unresolved';
    if (outcome.metadata.gymId !== gymId) return 'unresolved';
    let paidAt: string;
    if (outcome.status === 'succeeded') {
      // Confirm/cancel responses may omit the Charge timestamp. Resolve it by ID,
      // including when confirmation won a cancellation race, before writing anything.
      const timed = outcome.succeededAt ? outcome : await (await options.payments(gymId))
        .findCharge({ kind: 'charge', id: outcome.id }, { includeSuccessTime: true });
      if (timed.status !== 'succeeded' || !timed.succeededAt || !Number.isFinite(timed.succeededAt.getTime()))
        throw new Error('Payment success time is unresolved');
      paidAt = timed.succeededAt.toISOString();
    } else paidAt = clock.now().toISOString();
    const linked = await scope(gymId, async tx => {
      const attempt = (await tx.select().from(paymentAttempts).where(or(eq(paymentAttempts.paymentIntentId, outcome.id),
        ...(outcome.metadata.attemptId ? [eq(paymentAttempts.id, outcome.metadata.attemptId)] : []))))[0];
      const payment = (await tx.select().from(payments).where(eq(payments.paymentIntentId, outcome.id)))[0];
      const invoiceId = attempt?.invoiceId ?? payment?.invoiceId ?? outcome.metadata.invoiceId;
      if (!invoiceId) return 'unresolved';
      const invoice = (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update'))[0];
      if (!invoice || invoice.status === 'draft'
        || (outcome.metadata.invoiceId !== undefined && invoice.id !== outcome.metadata.invoiceId)
        || (checkout && invoice.id !== checkout.invoiceId)
        || (outcome.metadata.attemptId && outcome.metadata.attemptId !== attempt?.id)) return 'unresolved';
      const reportCheckout = async (reason: CheckoutReview) => {
        // The invoice lock serializes the first audit, including two sweeps of the same invoice.
        const previous = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
          eq(auditEvents.targetType, 'invoice'), eq(auditEvents.targetId, invoice.id), eq(auditEvents.action, checkoutReviewAction)));
        if (!previous.some(event => (event.after as { reason?: CheckoutReview } | null)?.reason === reason))
          await audit(tx, context, clock, checkoutReviewAction, 'invoice', invoice.id, { reason, paymentIntentId: outcome.id });
        return reason;
      };
      if (checkout && !checkout.late && invoice.status !== 'processing' && outcome.status !== 'succeeded') return undefined;
      if (checkout && attempt) {
        // A newly in-flight attempt belongs to the runner on the next sweep.
        if (attempt.status === 'pending' || attempt.status === 'processing') return undefined;
        return reportCheckout('attempt_resolved');
      }
      if (checkout?.late && outcome.status === 'failed') {
        const [resolved] = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
          eq(auditEvents.targetType, 'invoice'), eq(auditEvents.targetId, invoice.id), eq(auditEvents.action, lateProcessingResolved),
          eq(sql<string>`${auditEvents.after}->>'paymentIntentId'`, outcome.id))).limit(1);
        if (!resolved) await audit(tx, context, clock, lateProcessingResolved, 'invoice', invoice.id,
          { paymentIntentId: outcome.id, code: outcome.code });
        return undefined;
      }
      // Late success still needs its duplicate refund. Any other outcome on a terminal invoice only closes a still-unresolved
      // attempt; one already resolved is ignored before ID recovery, so it is never rewritten.
      if (!checkout?.late && terminal(invoice) && outcome.status !== 'succeeded' && outcome.status !== 'processing'
        && !(attempt && ['pending', 'processing', 'requires_action'].includes(attempt.status))) return 'unresolved';
      const home = (await tx.select().from(households).where(eq(households.id, invoice.householdId)))[0]!;
      if (invoice.currency !== outcome.currency.toUpperCase() || invoice.amountCents !== outcome.amount) return 'unresolved';
      if ((attempt?.stripeCustomerId ?? home.stripeCustomerId) !== outcome.customerId)
        return checkout ? reportCheckout('customer_mismatch') : 'unresolved';
      if (outcome.status === 'pending') return reportCheckout('pending');
      if (checkout?.late && outcome.status !== 'succeeded') return undefined;
      if (attempt) {
        if (attempt.amountCents !== outcome.amount || attempt.currency !== outcome.currency.toUpperCase()
          || attempt.stripeCustomerId !== outcome.customerId
          || (outcome.paymentMethodId && outcome.paymentMethodId !== attempt.savedPaymentMethod)) return 'unresolved';
        if (attempt.paymentIntentId !== outcome.id) {
          // A restored snapshot can predate the worker's ID commit. Only an unresolved reservation can be recovered.
          const changed = await tx.update(paymentAttempts).set({ paymentIntentId: outcome.id }).where(and(
            eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, 'pending'),
            isNull(paymentAttempts.paymentIntentId), isNull(paymentAttempts.resolvedAt))).returning();
          if (!changed.length) return 'unresolved';
          await audit(tx, context, clock, 'billing.runner.intent_recovered', 'payment_attempt', attempt.id,
            { paymentIntentId: outcome.id });
        }
      } else if (outcome.status !== 'succeeded' && outcome.status !== 'processing'
        && !(outcome.status === 'failed' && (checkout || outcome.code === 'insufficient_funds'
          || outcome.code === 'payment_method_unusable'))) return 'unresolved';
      return { invoice, attempt };
    });
    if (typeof linked !== 'object') return linked;
    await applyChargeOutcome(options.transitions, context, { invoiceId: linked.invoice.id, paymentId: uuidv7(),
      ...(linked.attempt ? { attemptId: linked.attempt.id } : {}), paidAt },
    // The stored processor ID can supply missing optional invoice metadata; conflicting metadata was rejected above.
    { ...outcome, metadata: { ...outcome.metadata, invoiceId: linked.invoice.id } });
    return undefined;
  }
  async function apply(gymId: string, outcome: ChargeOutcome, context: MutationContext = system(gymId)) {
    return await applyOutcome(gymId, outcome, context) === undefined;
  }
  async function checkout(gymId: string, id: string, provider: Payments, context: MutationContext = system(gymId)) {
    const found = await provider.readPaymentObject({ kind: 'checkout', id });
    if (found.status !== 'found' || found.value.kind !== 'checkout') return false;
    return applyCheckout(gymId, id, found.value.object, provider, context);
  }
  async function applyCheckout(gymId: string, id: string, session: CheckoutSession, provider: Payments, context: MutationContext) {
    if (session.metadata.gymId !== gymId || session.mode !== 'payment') return false;
    const invoice = await scope(gymId, async tx => (await tx.select().from(invoices).where(eq(invoices.checkoutSessionId, id)))[0]);
    if (!invoice || session.metadata.invoiceId !== invoice.id) return false;
    if (session.status === 'expired') return scope(gymId, async tx => {
      const current = (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).for('update'))[0];
      if (!current || current.checkoutSessionId !== id) return false;
      await tx.update(invoices).set({ checkoutSessionId: null }).where(eq(invoices.id, current.id));
      await audit(tx, context, clock, 'billing.runner.checkout_released', 'invoice', current.id, { checkoutSessionId: null, expiredSessionId: id });
      return true;
    });
    if (session.status !== 'complete') return false;
    return apply(gymId, await provider.findCharge({ kind: 'checkout', id }, { includeSuccessTime: true }), context);
  }
  /** `switched` is the snapshot read before `provider` was resolved; a write to Stripe first compares it. */
  async function object(gymId: string, value: PaymentObject, provider: Payments, switched: string | null): Promise<boolean> {
    if (value.kind === 'charge') {
      const outcome = value.object;
      if (outcome.status !== 'pending') return apply(gymId, outcome);
      // Cancel only stale/unconfirmed work; the adapter serializes cancel against confirm and re-reads races.
      const attempt = await scope(gymId, async tx => {
        // Under the gym row lock and whatever the key mode: never cancel with a key a switch has since replaced.
        await assertStripeSnapshot(tx, gymId, switched);
        return (await tx.select().from(paymentAttempts).where(eq(paymentAttempts.paymentIntentId, outcome.id)))[0];
      });
      if (attempt && (attempt.status === 'processing' || attempt.createdAt.getTime() > clock.now().getTime() - staleAfterMs)) return false;
      const canceled = await provider.cancelCharge(outcome.id);
      if (await apply(gymId, canceled)) return true;
      // An orphan can safely be discarded only after Stripe confirms cancellation.
      return !attempt && canceled.status === 'failed' && canceled.code === 'canceled';
    }
    if (value.kind === 'checkout') return applyCheckout(gymId, value.object.id, value.object, provider, system(gymId));
    if (value.kind === 'setup' || value.kind === 'payment_method') return true; // Card collection is webhook-owned.
    // Refunds and disputes are written by the same module as webhook processing, matched through their PaymentIntent.
    // A payment already recorded needs no processor read.
    const payment = await writer.recordedPayment(gymId, value.object.chargeId)
      ?? (await writer.parentPayment(gymId, provider, value.object.chargeId, success => apply(gymId, success))).payment;
    if (!payment) return false;
    if (value.kind === 'refund') return await writer.refund(gymId, payment, value.object, provider) && value.object.status !== 'pending';
    return await writer.dispute(gymId, payment, value.object) !== 'conflict';
  }
  /**
   * `resolved` is a provider already resolved by the caller, with the switch snapshot read before it; a null provider means
   * the gym has none, so stored intents are listed unread. Every key mode stops at the first switch it sees.
   */
  async function pending(gymId: string, resolved?: { provider: Payments | null; switched: string | null }) {
    const now = clock.now().getTime();
    const before = new Date(now - staleAfterMs), processingBefore = new Date(now - 10 * 86400_000);
    const { attempts, checkouts, switched } = await scope(gymId, async tx => {
      if (resolved) await assertStripeSnapshot(tx, gymId, resolved.switched);
      const switched = resolved ? resolved.switched : await stripeSwitchSnapshot(tx, gymId);
      const attempts = await tx.select().from(paymentAttempts).where(or(and(eq(paymentAttempts.status, 'pending'), lte(paymentAttempts.createdAt, before)),
        and(eq(paymentAttempts.status, 'processing'), lt(paymentAttempts.processingAt, processingBefore))));
      const checkouts = [...await staleProcessingCheckouts(tx, processingBefore),
        ...await staleLateCheckouts(tx, processingBefore, await latestTestSwitchId(tx, gymId))];
      return { attempts, checkouts, switched };
    });
    let provider = resolved?.provider;
    const issues: ReconciliationIssue[] = [];
    async function refresh(kind: 'charge' | 'checkout_debit', id: string,
      handle: (outcome: ChargeOutcome, provider: Payments) => Promise<string | undefined>) {
      try {
        if (provider === undefined) provider = await configuredProvider(gymId);
        if (!provider) { issues.push({ kind, id, reason: notConfigured }); return; }
        const current = provider;
        const read = async () => {
          let reason: string | undefined;
          try {
            const outcome = await current.findCharge({ kind: 'charge', id }, { includeSuccessTime: true });
            reason = await handle(outcome, current);
          } catch (error) {
            if (error instanceof StripeTestModeSwitched) throw error;
            reason = 'provider_or_transition_error';
          }
          // The read may have ended with no guarded transaction, and a live key has none: a switch since then stops the
          // run before its issue or the next read.
          await scope(gymId, tx => assertStripeSnapshot(tx, gymId, switched));
          if (reason) issues.push({ kind, id, reason });
        };
        await withProviderWrites(current, gymId, switched, read);
      } catch (error) {
        // A switch stops the run: every later read would use the old key.
        if (error instanceof StripeTestModeSwitched) throw error;
        issues.push({ kind, id, reason: 'provider_or_transition_error' });
      }
    }
    for (const attempt of attempts) {
      if (!attempt.paymentIntentId) {
        await scope(gymId, async tx => {
          const changed = await tx.update(paymentAttempts).set({ status: 'failed', declineCode: createAbandoned, resolvedAt: clock.now() })
            .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, 'pending'),
              isNull(paymentAttempts.paymentIntentId), isNull(paymentAttempts.resolvedAt))).returning();
          if (changed.length) await audit(tx, system(gymId), clock, 'billing.runner.create_abandoned', 'payment_attempt', attempt.id,
            { invoiceId: attempt.invoiceId });
        });
        continue;
      }
      await refresh('charge', attempt.paymentIntentId, async (outcome, current) =>
        await object(gymId, { kind: 'charge', object: outcome }, current, switched) ? undefined : 'unresolved');
    }
    for (const checkout of checkouts) {
      // Read only. Even an unexpected unconfirmed snapshot of a Checkout debit cannot reach cancellation.
      await refresh('checkout_debit', checkout.paymentIntentId, outcome => applyOutcome(gymId, outcome, system(gymId), checkout));
    }
    return { inspected: attempts.length + checkouts.length, issues };
  }
  /**
   * Never enables billing. The owner must review the report and explicitly resume it. A gym with no payments provider
   * is checked against what the database holds: with no Stripe references the check is clear; each reference it holds
   * is an issue (`stripe_not_configured`) the owner resolves by connecting Stripe and checking again.
   */
  async function postRestore(gymId: string, snapshotAt: Date, restoreId?: string): Promise<RestoreCheck> {
    if (!Number.isFinite(snapshotAt.getTime()) || snapshotAt > clock.now()) throw new Error('Invalid snapshot time');
    if ((await options.settings.get(gymId)).billingEnabled) throw new Error('Pause billing before restore reconciliation');
    const latestRestore = await scope(gymId, async tx => (await tx.select({ id: auditEvents.id }).from(auditEvents)
      .where(eq(auditEvents.action, 'restore.completed')).orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1))[0]);
    // A delayed job for an earlier restore must never clear the current restore's gate.
    if (restoreId && latestRestore?.id !== restoreId) return { inspected: 0, readyForOwnerReview: false, issues: [] };
    restoreId ??= latestRestore?.id;
    const check = await scope(gymId, tx => started(tx, gymId, snapshotAt, restoreId));
    return restoreCheck(gymId, snapshotAt, check.id);
  }
  /**
   * A busy check's follow-up, run under the restore lease. Returns null, with no check, when billing is on, the restore
   * isn't the latest, or the latest check for this restore is already clear for the saved Stripe mode: the owner may be
   * reviewing it. It decides that first, before it reads the Stripe credentials, so a follow-up with nothing to do ends
   * even when they can't be read. It reads the switch snapshot before it resolves the provider, so the guard covers the
   * key it resolved. It then decides again and records the start in one transaction under the gym row lock that turning
   * billing on takes, so billing can't turn on while it starts and a start bars billing until its report. A switch
   * committed since the snapshot throws there, with no start and no Stripe call, and the retry resolves the current key;
   * so do Stripe settings saved since the resolver found none. One seen during the check throws too, whatever the key
   * mode, with no report and no further Stripe call (`restoreCheck`).
   */
  async function followUpRestore(gymId: string, snapshotAt: Date, restoreId?: string): Promise<RestoreCheck | null> {
    if (!Number.isFinite(snapshotAt.getTime()) || snapshotAt > clock.now()) throw new Error('Invalid snapshot time');
    const early = await scope(gymId, async tx => ({
      switched: await stripeSwitchSnapshot(tx, gymId), gate: await readRestoreCheckStart(tx, gymId, restoreId) }));
    if (!early.gate.start) return null;
    const provider = await configuredProvider(gymId);
    const check = await scope(gymId, async tx => {
      const gate = await holdRestoreCheckStart(tx, gymId, restoreId, !!provider);
      if (await stripeSwitchSnapshot(tx, gymId) !== early.switched) throw new StripeTestModeSwitched();
      // Stripe settings saved since the early read found none: the retry inspects the new account.
      if (!provider && !early.gate.stripeStored && gate.stripeStored) throw new StripeTestModeSwitched();
      return gate.start ? started(tx, gymId, snapshotAt, gate.restoreId) : null;
    });
    return check && restoreCheck(gymId, snapshotAt, check.id, { provider, switched: early.switched, stored: early.gate.stripeStored });
  }
  function started(tx: Transaction, gymId: string, snapshotAt: Date, restoreId: string | undefined) {
    return writeAudit(tx, { gymId, actorKind: 'system',
      action: 'billing.runner.restore_check_started', targetType: restoreId ? 'restore' : 'gym', targetId: restoreId ?? gymId,
      after: { snapshotAt: snapshotAt.toISOString() }, occurredAt: clock.now() });
  }
  /**
   * Runs a started check and records its report against `checkId`. A follow-up, which resolved the provider, passes it
   * with the switch snapshot it read before resolving it; otherwise both are read here, the snapshot first. Whatever the
   * key mode, the check compares the snapshot after each read that ends with no guarded transaction, before each Stripe
   * write and before its report. A switch seen during the check ends it with the incomplete report in the mode it ran
   * with, except in a follow-up: there it throws with no report, so the retry resolves the current key.
   */
  async function restoreCheck(gymId: string, snapshotAt: Date, checkId: string,
    resolved?: { provider: Payments | null; switched: string | null; stored: boolean }): Promise<RestoreCheck> {
    let ranMode: 'test' | 'live' | undefined;
    try {
      const switched = resolved ? resolved.switched : await scope(gymId, tx => stripeSwitchSnapshot(tx, gymId));
      const provider = resolved ? resolved.provider : await configuredProvider(gymId);
      ranMode = provider?.keyMode;
      const assertCurrent = () => scope(gymId, tx => assertStripeSnapshot(tx, gymId, switched));
      return await (provider ? withProviderWrites(provider, gymId, switched, inspect) : inspect());
      async function inspect(): Promise<RestoreCheck> {
        const stripeMode = provider?.keyMode ?? null;
        const issues: ReconciliationIssue[] = [];
        const references = await scope(gymId, async tx => {
          const attempts = await tx.select({ paymentIntentId: paymentAttempts.paymentIntentId }).from(paymentAttempts)
            .where(inArray(paymentAttempts.status, ['pending', 'processing', 'requires_action']));
          const checkouts = await tx.select({ checkoutSessionId: invoices.checkoutSessionId }).from(invoices)
            .where(inArray(invoices.status, ['open', 'past_due', 'processing']));
          const disputes = await restorableDisputes(tx, gymId);
          const returns = await tx.select({ processorId: refunds.processorId }).from(refunds).where(eq(refunds.status, 'pending'));
          return [
            ...attempts.flatMap(row => row.paymentIntentId ? [{ kind: 'charge' as const, id: row.paymentIntentId }] : []),
            ...checkouts.flatMap(row => row.checkoutSessionId ? [{ kind: 'checkout' as const, id: row.checkoutSessionId }] : []),
            ...disputes.flatMap(row => row.disputeId ? [{ kind: 'dispute' as const, id: row.disputeId }] : []),
            ...returns.flatMap(row => row.processorId ? [{ kind: 'refund' as const, id: row.processorId }] : []),
          ];
        });
        async function refresh(ref: PaymentObjectReference) {
          if (!provider) { issues.push({ ...ref, reason: notConfigured }); return; }
          let reason: string | undefined;
          try {
            let done: boolean;
            if (ref.kind === 'charge') {
              const outcome = await provider.findCharge({ kind: 'charge', id: ref.id }, { includeSuccessTime: true });
              done = await object(gymId, { kind: 'charge', object: outcome }, provider, switched);
            } else {
              const read = await provider.readPaymentObject(ref);
              done = read.status === 'found' && await object(gymId, read.value, provider, switched);
            }
            if (!done) reason = 'manual_resolution_required';
          } catch (error) {
            // A switch ends the check below, with no further Stripe call.
            if (error instanceof StripeTestModeSwitched) throw error;
            reason = 'provider_or_transition_error';
          }
          // A missing object or a failed read ends with no guarded transaction, and a live key has none: check for a
          // switch before the next read.
          await assertCurrent();
          if (reason) issues.push({ ...ref, reason });
        }
        for (const ref of references) await refresh(ref);
        // The adapter enumerates events plus creation-time lists (including refunds/disputes), with pinned-version re-fetches.
        // List BEFORE invalidating no-ID reservations: the snapshot may precede their successful intent-ID commit.
        const since = new Date(snapshotAt.getTime() - 5 * 60_000);
        let cursor: string | undefined;
        const cursors = new Set<string>();
        let inspected = references.length;
        // A restore keeps the gym's Stripe settings, so a gym without them had none at the snapshot and there are no
        // changes this install can list. Connecting Stripe later and checking again reads them.
        if (provider) do {
          const page = await provider.listChangesSince(since, cursor ? { cursor } : {})
            .finally(assertCurrent);
          for (const change of page.changes) {
            const id = change.kind === 'charge' && change.object.status === 'unknown' ? change.object.reference.id : 'id' in change.object ? change.object.id : '';
            await refresh({ kind: change.kind, id });
            inspected++;
          }
          cursor = page.nextCursor ?? undefined;
          if (cursor && cursors.has(cursor)) throw new Error('Repeated reconciliation cursor');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        const pendingResult = await pending(gymId, { provider, switched });
        issues.push(...pendingResult.issues);
        const remaining = await scope(gymId, tx => tx.select({ id: paymentAttempts.id, invoiceId: paymentAttempts.invoiceId }).from(paymentAttempts)
          .where(inArray(paymentAttempts.status, ['pending', 'processing'])));
        issues.push(...remaining.map(row => ({ kind: 'attempt', id: row.id, reason: 'unresolved' })));
        const unresolvedInvoices = new Set(remaining.map(row => row.invoiceId));
        const settling = await scope(gymId, tx => tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.status, 'processing')));
        for (const row of settling) if (!unresolvedInvoices.has(row.id)) issues.push({ kind: 'invoice', id: row.id, reason: 'unresolved' });
        const pendingRefunds = await scope(gymId, tx => tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.status, 'pending')));
        issues.push(...pendingRefunds.map(row => ({ kind: 'refund', id: row.id, reason: 'unresolved' })));
        const unique = [...new Map(issues.map(issue => [`${issue.kind}:${issue.id}`, issue])).values()];
        await scope(gymId, async tx => {
          // Published only for the settings it read: no switch since the snapshot, and in a follow-up that found no
          // Stripe settings, still none (a first save makes the retry inspect the new account).
          await assertStripeSnapshot(tx, gymId, switched);
          if (resolved && !provider && !resolved.stored && await stripeConfigStored(tx, gymId)) throw new StripeTestModeSwitched();
          return writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.runner.restore_checked',
            targetType: 'restore_check', targetId: checkId, occurredAt: clock.now(),
            after: { snapshotAt: snapshotAt.toISOString(), inspected, unresolved: unique.length, issues: unique,
              stripeConfigured: !!provider, stripeMode } });
        });
        return { inspected, readyForOwnerReview: unique.length === 0, issues: unique, stripeConfigured: !!provider, stripeMode };
      }
    } catch (error) {
      const stale = error instanceof StripeTestModeSwitched;
      if (stale && resolved) throw error;
      const issues = [{ kind: 'provider', id: gymId, reason: 'provider_or_transition_error' }];
      // A test provider, or one with no mode, keeps the test-mode report; a live provider stopped by a switch reports live.
      const stripeMode = ranMode === 'live' ? 'live' as const : 'test' as const;
      await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.runner.restore_checked',
        targetType: 'restore_check', targetId: checkId, occurredAt: clock.now(),
        after: { snapshotAt: snapshotAt.toISOString(), inspected: 0, unresolved: 1,
          issues, ...(stale ? { stripeConfigured: true, stripeMode } : {}) } }));
      // A switch makes this report incomplete, not an outage: keep its original mode for the owner's restore gate.
      if (stale) return { inspected: 0, readyForOwnerReview: false, issues, stripeConfigured: true, stripeMode };
      throw error;
    }
  }
  return { apply, checkout, pending, postRestore, followUpRestore };
}
