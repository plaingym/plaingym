// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { households, invoices, paymentAttempts, payments, refunds, uuidv7 } from '@plaingym/db';
import type { ChargeOutcome, PaymentObject, PaymentObjectReference, Payments } from '../../../infra/payments/index.js';
import { applyChargeOutcome } from '../transitions/outcomes.js';
import { audit, system } from './store.js';
import type { RunnerOptions } from './index.js';
import type { MutationContext } from '../../../core/interfaces/common.js';

export interface ReconciliationIssue { kind: string; id: string; reason: string; }
type Options = Omit<RunnerOptions, 'jobs'> & Required<Pick<RunnerOptions, 'scope' | 'clock'>>;
export function createReconciliation(options: Options) {
  const { scope, clock } = options;
  const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error('Invalid reconciliation threshold');
  /** Returns false for unknown, unmatched, or still-processing objects. Never guesses from search. */
  async function apply(gymId: string, outcome: ChargeOutcome, context: MutationContext = system(gymId)): Promise<boolean> {
    if (context.gymId !== gymId) throw new Error('Payment outcome actor gym mismatch');
    if (outcome.status === 'unknown' || outcome.status === 'pending') return false;
    if (outcome.metadata.gymId !== gymId) return false;
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
      if (!invoiceId) return null;
      const invoice = (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update'))[0];
      if (!invoice || invoice.status === 'draft' || invoice.status === 'void'
        || (outcome.metadata.invoiceId !== undefined && invoice.id !== outcome.metadata.invoiceId)
        || (outcome.metadata.attemptId && outcome.metadata.attemptId !== attempt?.id)) return null;
      const home = (await tx.select().from(households).where(eq(households.id, invoice.householdId)))[0]!;
      if ((attempt?.stripeCustomerId ?? home.stripeCustomerId) !== outcome.customerId || invoice.currency !== outcome.currency.toUpperCase()
        || invoice.amountCents !== outcome.amount) return null;
      if (attempt) {
        if (attempt.amountCents !== outcome.amount || attempt.currency !== outcome.currency.toUpperCase()
          || attempt.stripeCustomerId !== outcome.customerId
          || (outcome.paymentMethodId && outcome.paymentMethodId !== attempt.savedPaymentMethod)) return null;
        if (attempt.paymentIntentId !== outcome.id) {
          // A restored snapshot can predate the worker's ID commit. Only an unresolved reservation can be recovered.
          const changed = await tx.update(paymentAttempts).set({ paymentIntentId: outcome.id }).where(and(
            eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, 'pending'),
            isNull(paymentAttempts.paymentIntentId), isNull(paymentAttempts.resolvedAt))).returning();
          if (!changed.length) return null;
          await audit(tx, context, clock, 'billing.runner.intent_recovered', 'payment_attempt', attempt.id,
            { paymentIntentId: outcome.id });
        }
      } else if (outcome.status !== 'succeeded') return false;
      return { invoice, attempt };
    });
    if (!linked) return false;
    await applyChargeOutcome(options.transitions, context, { invoiceId: linked.invoice.id, paymentId: uuidv7(),
      ...(linked.attempt ? { attemptId: linked.attempt.id } : {}), paidAt },
    // The stored processor ID can supply missing optional invoice metadata; conflicting metadata was rejected above.
    { ...outcome, metadata: { ...outcome.metadata, invoiceId: linked.invoice.id } });
    return true;
  }
  async function checkout(gymId: string, id: string, provider: Payments, context: MutationContext = system(gymId)) {
    const found = await provider.readPaymentObject({ kind: 'checkout', id });
    if (found.status !== 'found' || found.value.kind !== 'checkout') return false;
    const session = found.value.object;
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
  async function object(gymId: string, value: PaymentObject, provider: Payments): Promise<boolean> {
    if (value.kind === 'charge') {
      const outcome = value.object;
      if (outcome.status !== 'pending') return apply(gymId, outcome);
      // Cancel only stale/unconfirmed work; the adapter serializes cancel against confirm and re-reads races.
      const attempt = await scope(gymId, async tx => (await tx.select().from(paymentAttempts)
        .where(eq(paymentAttempts.paymentIntentId, outcome.id)))[0]);
      if (attempt && attempt.createdAt.getTime() > clock.now().getTime() - staleAfterMs) return false;
      const canceled = await provider.cancelCharge(outcome.id);
      if (await apply(gymId, canceled)) return true;
      // An orphan can safely be discarded only after Stripe confirms cancellation.
      return !attempt && canceled.status === 'failed' && canceled.code === 'canceled';
    }
    if (value.kind === 'checkout') return checkout(gymId, value.object.id, provider);
    if (value.kind === 'setup' || value.kind === 'payment_method') return true; // Card collection is webhook-owned.
    const remote = value.object;
    // The payments adapter resolves dashboard Refund/Dispute -> Charge -> PaymentIntent.
    let payment = await scope(gymId, async tx => (await tx.select().from(payments).where(or(
      eq(payments.paymentIntentId, remote.chargeId), eq(payments.chargeId, remote.chargeId))))[0]);
    if (!payment) {
      await apply(gymId, await provider.findCharge({ kind: 'charge', id: remote.chargeId }, { includeSuccessTime: true }));
      payment = await scope(gymId, async tx => (await tx.select().from(payments).where(or(
        eq(payments.paymentIntentId, remote.chargeId), eq(payments.chargeId, remote.chargeId))))[0]);
    }
    if (!payment) return false;
    if (value.kind === 'refund') {
      const refund = value.object;
      if (refund.metadata.gymId !== gymId || refund.currency.toUpperCase() !== payment.currency) return false;
      const previous = await scope(gymId, async tx => (await tx.select().from(refunds).where(eq(refunds.processorId, refund.id)))[0]);
      try {
        await options.transitions.refund(system(gymId), { invoiceId: payment.invoiceId, paymentId: payment.id,
          refundId: previous?.id ?? uuidv7(), processorId: refund.id, amountCents: refund.amount,
          currency: payment.currency as 'USD' | 'CAD', status: refund.status });
      } catch (error) {
        // A concurrent pass may have inserted this processor refund with another local UUID.
        const raced = await scope(gymId, async tx => (await tx.select().from(refunds).where(eq(refunds.processorId, refund.id)))[0]);
        if (!raced || raced.paymentId !== payment.id || raced.amountCents !== refund.amount || raced.currency !== payment.currency) throw error;
        await options.transitions.refund(system(gymId), { invoiceId: payment.invoiceId, paymentId: payment.id,
          refundId: raced.id, processorId: refund.id, amountCents: refund.amount,
          currency: payment.currency as 'USD' | 'CAD', status: refund.status });
      }
      return refund.status !== 'pending';
    }
    const dispute = value.object;
    return scope(gymId, async tx => {
      const invoice = (await tx.select().from(invoices).where(eq(invoices.id, payment.invoiceId)).for('update'))[0]!;
      if (invoice.disputeId && invoice.disputeId !== dispute.id) return false;
      if (invoice.disputeId === dispute.id && (invoice.disputeStatus === dispute.status
        || invoice.disputeStatus === 'won' || invoice.disputeStatus === 'lost' || invoice.disputeStatus === 'closed')) return true;
      const after = { disputeId: dispute.id, disputeStatus: dispute.status };
      await tx.update(invoices).set(after).where(eq(invoices.id, invoice.id));
      await audit(tx, system(gymId), clock, 'billing.invoice.disputed', 'invoice', invoice.id, after,
        { disputeId: invoice.disputeId, disputeStatus: invoice.disputeStatus });
      return true;
    });
  }
  async function pending(gymId: string) {
    const before = new Date(clock.now().getTime() - staleAfterMs);
    const attempts = await scope(gymId, tx => tx.select().from(paymentAttempts).where(and(
      eq(paymentAttempts.status, 'pending'), lte(paymentAttempts.createdAt, before))));
    if (!attempts.length) return { inspected: 0, issues: [] };
    let provider: Payments | undefined;
    const issues: ReconciliationIssue[] = [];
    for (const attempt of attempts) {
      if (!attempt.paymentIntentId) {
        await scope(gymId, async tx => {
          const changed = await tx.update(paymentAttempts).set({ status: 'failed', declineCode: 'create_abandoned', resolvedAt: clock.now() })
            .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.status, 'pending'),
              isNull(paymentAttempts.paymentIntentId), isNull(paymentAttempts.resolvedAt))).returning();
          if (changed.length) await audit(tx, system(gymId), clock, 'billing.runner.create_abandoned', 'payment_attempt', attempt.id,
            { invoiceId: attempt.invoiceId });
        });
        continue;
      }
      try {
        provider ??= await options.payments(gymId);
        const outcome = await provider.findCharge({ kind: 'charge', id: attempt.paymentIntentId }, { includeSuccessTime: true });
        if (!await object(gymId, { kind: 'charge', object: outcome }, provider))
          issues.push({ kind: 'charge', id: attempt.paymentIntentId, reason: 'unresolved' });
      } catch { issues.push({ kind: 'charge', id: attempt.paymentIntentId, reason: 'provider_or_transition_error' }); }
    }
    return { inspected: attempts.length, issues };
  }
  /** Never enables billing. The owner must review the report and explicitly resume it. */
  async function postRestore(gymId: string, snapshotAt: Date) {
    if (!Number.isFinite(snapshotAt.getTime()) || snapshotAt > clock.now()) throw new Error('Invalid snapshot time');
    if ((await options.settings.get(gymId)).billingEnabled) throw new Error('Pause billing before restore reconciliation');
    const provider = await options.payments(gymId);
    const issues: ReconciliationIssue[] = [];
    const references = await scope(gymId, async tx => {
      const attempts = await tx.select({ paymentIntentId: paymentAttempts.paymentIntentId }).from(paymentAttempts)
        .where(inArray(paymentAttempts.status, ['pending', 'requires_action']));
      const checkouts = await tx.select({ checkoutSessionId: invoices.checkoutSessionId }).from(invoices)
        .where(inArray(invoices.status, ['open', 'past_due']));
      const disputes = await tx.select({ disputeId: invoices.disputeId }).from(invoices).where(eq(invoices.disputeStatus, 'open'));
      const returns = await tx.select({ processorId: refunds.processorId }).from(refunds).where(eq(refunds.status, 'pending'));
      return [
        ...attempts.flatMap(row => row.paymentIntentId ? [{ kind: 'charge' as const, id: row.paymentIntentId }] : []),
        ...checkouts.flatMap(row => row.checkoutSessionId ? [{ kind: 'checkout' as const, id: row.checkoutSessionId }] : []),
        ...disputes.flatMap(row => row.disputeId ? [{ kind: 'dispute' as const, id: row.disputeId }] : []),
        ...returns.flatMap(row => row.processorId ? [{ kind: 'refund' as const, id: row.processorId }] : []),
      ];
    });
    async function refresh(ref: PaymentObjectReference) {
      try {
        if (ref.kind === 'charge') {
          const outcome = await provider.findCharge({ kind: 'charge', id: ref.id }, { includeSuccessTime: true });
          if (!await object(gymId, { kind: 'charge', object: outcome }, provider))
            issues.push({ ...ref, reason: 'manual_resolution_required' });
          return;
        }
        const read = await provider.readPaymentObject(ref);
        if (read.status !== 'found' || !await object(gymId, read.value, provider))
          issues.push({ ...ref, reason: 'manual_resolution_required' });
      } catch { issues.push({ ...ref, reason: 'provider_or_transition_error' }); }
    }
    for (const ref of references) await refresh(ref);
    // The adapter enumerates events plus creation-time lists (including refunds/disputes), with pinned-version re-fetches.
    // List BEFORE invalidating no-ID reservations: the snapshot may precede their successful intent-ID commit.
    const since = new Date(snapshotAt.getTime() - 5 * 60_000);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let inspected = references.length;
    do {
      const page = await provider.listChangesSince(since, cursor ? { cursor } : {});
      for (const change of page.changes) {
        const id = change.kind === 'charge' && change.object.status === 'unknown' ? change.object.reference.id : 'id' in change.object ? change.object.id : '';
        await refresh({ kind: change.kind, id });
        inspected++;
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated reconciliation cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const pendingResult = await pending(gymId);
    issues.push(...pendingResult.issues);
    const remaining = await scope(gymId, tx => tx.select({ id: paymentAttempts.id }).from(paymentAttempts)
      .where(eq(paymentAttempts.status, 'pending')));
    issues.push(...remaining.map(row => ({ kind: 'attempt', id: row.id, reason: 'unresolved' })));
    const pendingRefunds = await scope(gymId, tx => tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.status, 'pending')));
    issues.push(...pendingRefunds.map(row => ({ kind: 'refund', id: row.id, reason: 'unresolved' })));
    const unique = [...new Map(issues.map(issue => [`${issue.kind}:${issue.id}`, issue])).values()];
    await scope(gymId, tx => audit(tx, system(gymId), clock, 'billing.runner.restore_checked', 'gym', gymId,
      { snapshotAt: snapshotAt.toISOString(), inspected, unresolved: unique.length, issues: unique }));
    return { inspected, readyForOwnerReview: unique.length === 0, issues: unique };
  }
  return { apply, checkout, pending, postRestore };
}
