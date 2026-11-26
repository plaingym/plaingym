// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { auditEvents, classPackSales, invoices, payments, refunds, uuidv7, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema, moneySchema, refundReleased } from '@plaingym/shared/contracts';
import { conflict, notFound, type MutationContext } from '../../../core/interfaces/common.js';
import { logWarn } from '../../../core/log.js';
import type { RefundTransition, ProcessorRefundTransition, InvoiceTransitionResult } from '../../../core/interfaces/invoice-transitions.js';
import { pastRefundWindow, sameRefund } from './lapsed-refunds.js';
import { accepted, audit, duplicateReservation, effect, effectCreated, missingFailedBeforeFound, missingFound, missingFoundFailed,
  recorded, result, snapshot, type InvoiceRow, type TransitionEffect } from './store.js';

export type RefundWarning = {
  event: 'billing.refunds.missing_found' | 'billing.refunds.missing_found_failed';
  fields: { gymId: string; invoiceId: string; refundId: string };
};

/** The caller holds the invoice lock; every reservation, audit and effect commits with the refund. `verified` marks a
 * report or pending read the processor returned for the row's own processor ID, which only the processor refund path
 * passes. */
export async function applyRefund(tx: Transaction, context: MutationContext, clock: Clock, invoice: InvoiceRow,
  request: RefundTransition, { appCreated, missing, verified }: { appCreated?: boolean; missing?: boolean; verified?: boolean },
  warnings: RefundWarning[]): Promise<InvoiceTransitionResult> {
  idSchema.parse(request.refundId); moneySchema.parse({ amountCents: request.amountCents, currency: request.currency });
  if (invoice.status === 'processing') conflict('Payment is processing');
  if (request.amountCents <= 0 || !['pending', 'succeeded', 'failed', 'canceled'].includes(request.status)) conflict('Invalid refund');
  if (request.status === 'canceled' && request.processorId === undefined) conflict('Only a processor refund can be canceled');
  const payment = (await tx.select().from(payments).where(eq(payments.id, request.paymentId)))[0] ?? notFound();
  if (payment.invoiceId !== invoice.id) notFound();
  if (request.currency !== payment.currency) conflict('Refund currency does not match');
  const previous = (await tx.select().from(refunds).where(eq(refunds.id, request.refundId)))[0];
  if (previous && (previous.paymentId !== request.paymentId || previous.amountCents !== request.amountCents
    || previous.currency !== request.currency || (previous.processorId !== null && previous.processorId !== request.processorId)))
    conflict('Refund ID reused with different parameters');
  // Only a failure can reverse a succeeded processor refund; a cancellation never does.
  const reversed = previous?.status === 'succeeded' && request.status === 'failed'
    && previous.processorId !== null && previous.processorId === request.processorId;
  // A success for a refund released as missing contradicts that release. Staff reconcile it by hand: the row and the
  // invoice stay as they are, and the first such report is recorded once with a staff notice. A success read before a
  // verified failure that has already committed is stale: it records nothing.
  if (previous?.status === 'failed' && previous.processorId !== null && previous.processorId === request.processorId
    && request.status === 'succeeded') {
    if (await recorded(tx, missingFound, previous.id) || await recorded(tx, missingFailedBeforeFound, previous.id)
      || !await releasedAsMissing(tx, context, clock, invoice.id, previous))
      return result('ignored', invoice);
    await audit(tx, context, clock, missingFound, 'refund', previous.id,
      { processorId: previous.processorId, amountCents: previous.amountCents, currency: previous.currency });
    await effect(tx, context, clock, { kind: 'staff_notice', notice: 'refund_found', invoiceId: invoice.id,
      paymentId: payment.id, refundId: previous.id });
    warnings.push({ event: 'billing.refunds.missing_found',
      fields: { gymId: context.gymId, invoiceId: invoice.id, refundId: previous.id } });
    return result('ignored', invoice);
  }
  // A failure after that success makes the found notice obsolete. The row and the invoice still stay as they are: the
  // first such report is recorded once with a follow-up for staff who may already have acted on the found notice.
  if (previous?.status === 'failed' && previous.processorId !== null && previous.processorId === request.processorId
    && request.status === 'failed' && await recorded(tx, missingFound, previous.id)) {
    if (await recorded(tx, missingFoundFailed, previous.id)) return result('ignored', invoice);
    await audit(tx, context, clock, missingFoundFailed, 'refund', previous.id,
      { processorId: previous.processorId, amountCents: previous.amountCents, currency: previous.currency });
    await effect(tx, context, clock, { kind: 'staff_notice', notice: 'refund_found_failed', invoiceId: invoice.id,
      paymentId: payment.id, refundId: previous.id });
    warnings.push({ event: 'billing.refunds.missing_found_failed',
      fields: { gymId: context.gymId, invoiceId: invoice.id, refundId: previous.id } });
    return result('ignored', invoice);
  }
  // A verified failure before any success confirms the release. The first one is recorded once, so a success the
  // processor returned earlier but that commits later can't tell staff the refund was found. The row, the invoice and
  // the release's own missing notice stay as they are, and staff get no new notice.
  if (verified && previous?.status === 'failed' && previous.processorId !== null && previous.processorId === request.processorId
    && request.status === 'failed') {
    if (await recorded(tx, missingFailedBeforeFound, previous.id)) return result('ignored', invoice);
    if (await releasedAsMissing(tx, context, clock, invoice.id, previous))
      await audit(tx, context, clock, missingFailedBeforeFound, 'refund', previous.id,
        { processorId: previous.processorId, amountCents: previous.amountCents, currency: previous.currency });
    return result('ignored', invoice);
  }
  if (previous && !reversed && (previous.status === request.status && (previous.processorId !== null || request.processorId === undefined)
    || previous.status !== 'pending')) return result('ignored', invoice);
  if (request.processorId !== undefined) {
    const other = (await tx.select().from(refunds).where(eq(refunds.processorId, request.processorId)))[0];
    if (other && other.id !== request.refundId) conflict('Processor refund already recorded');
  }
  const existing = await tx.select().from(refunds).where(eq(refunds.paymentId, payment.id));
  const reserved = existing.filter(row => row.id !== request.refundId && !refundReleased(row))
    .reduce((sum, row) => sum + row.amountCents, 0);
  if (!refundReleased(request) && reserved + request.amountCents > payment.amountCents) conflict('Refund exceeds payment');
  const values = { status: request.status, processorId: request.processorId ?? null,
    resolvedAt: request.status === 'pending' ? null : clock.now() };
  if (previous) await tx.update(refunds).set(values).where(eq(refunds.id, request.refundId));
  else {
    const inserted = await tx.insert(refunds).values({ ...values, id: request.refundId, gymId: context.gymId,
      paymentId: request.paymentId, amountCents: request.amountCents, currency: request.currency, createdAt: clock.now(),
      taggedAt: request.tagged && request.status === 'pending' ? clock.now() : null })
      .onConflictDoNothing().returning();
    if (!inserted.length) conflict('Refund identity already recorded');
  }
  const missingEffectId = missing && request.status === 'failed' ? uuidv7() : undefined;
  const recordedRefund = { paymentId: payment.id, amountCents: request.amountCents, currency: request.currency, ...values,
    ...(request.status === 'failed' ? { releasedMissing: missingEffectId !== undefined } : {}),
    ...(missingEffectId === undefined ? {} : { missingEffectId }) };
  if (!reversed) await audit(tx, context, clock, 'billing.refund.recorded', 'refund', request.refundId, recordedRefund);
  else await audit(tx, context, clock, 'billing.refund.reversed', 'refund', request.refundId, recordedRefund,
    { status: 'succeeded', resolvedAt: previous?.resolvedAt ?? null });
  // A local reservation or its original audit identifies an app-created refund. External pending rows also have
  // a previous row when canceled, so their existence alone must never trigger this notice. A pending row the processor
  // reported missing is released with its own notice and no other.
  if (missingEffectId !== undefined)
    await effect(tx, context, clock, { kind: 'staff_notice', notice: 'refund_missing', invoiceId: invoice.id,
      paymentId: payment.id, refundId: request.refundId }, missingEffectId);
  else if (request.status === 'canceled' && (appCreated || previous && await createdInApp(tx, previous)))
    await effect(tx, context, clock, { kind: 'staff_notice', notice: 'refund_canceled', invoiceId: invoice.id,
      paymentId: payment.id, refundId: request.refundId });
  else if (request.status === 'failed' && values.processorId !== null)
    await effect(tx, context, clock, { kind: 'staff_notice', notice: 'refund_failed', invoiceId: invoice.id,
      paymentId: payment.id, refundId: request.refundId });
  else if (request.status === 'failed' && previous && await duplicateReservation(tx, previous))
    await effect(tx, context, clock, { kind: 'staff_notice', notice: 'duplicate_released', invoiceId: invoice.id,
      paymentId: payment.id, refundId: request.refundId });
  else if (request.status === 'failed' && previous && context.actor.kind === 'system' && pastRefundWindow(previous, clock))
    await effect(tx, context, clock, { kind: 'staff_notice', notice: 'refund_released', invoiceId: invoice.id,
      paymentId: payment.id, refundId: request.refundId });
  if (!(request.status === 'succeeded' || reversed && ['partially_refunded', 'refunded'].includes(invoice.status))
    || !await accepted(tx, payment.id)) return result('applied', invoice);
  const successful = await tx.select({ refund: refunds, payment: payments }).from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId)).where(and(eq(payments.invoiceId, invoice.id), eq(refunds.status, 'succeeded')));
  let total = 0;
  for (const row of successful) if (await accepted(tx, row.payment.id)) total += row.refund.amountCents;
  const next = { ...invoice, status: total === 0 ? 'paid' : total >= invoice.amountCents ? 'refunded' : 'partially_refunded' };
  if (next.status !== invoice.status) {
    await tx.update(invoices).set({ status: next.status }).where(eq(invoices.id, invoice.id));
    await audit(tx, context, clock, reversed ? 'billing.invoice.refund_reversed' : 'billing.invoice.refunded', 'invoice',
      invoice.id, snapshot(next), snapshot(invoice));
    if (next.status === 'refunded' && (await tx.select({ id: classPackSales.id }).from(classPackSales)
      .where(eq(classPackSales.invoiceId, invoice.id)).limit(1)).length)
      await effect(tx, context, clock, { kind: 'reverse_credits', invoiceId: invoice.id });
  }
  return result('applied', next);
}

/** Select the refund row and make room for an external refund under the invoice lock. */
export async function applyProcessorRefund(tx: Transaction, context: MutationContext, clock: Clock, invoice: InvoiceRow,
  input: ProcessorRefundTransition, warnings: RefundWarning[]): Promise<InvoiceTransitionResult> {
  const value = input.processorRefund;
  const request: RefundTransition = { invoiceId: input.invoiceId, paymentId: input.paymentId, refundId: input.refundId,
    processorId: value.id, amountCents: value.amount, currency: value.currency.toUpperCase(), status: value.status };
  const payment = (await tx.select().from(payments).where(eq(payments.id, request.paymentId)))[0] ?? notFound();
  if (payment.invoiceId !== invoice.id) notFound();
  if (value.metadata.gymId !== context.gymId || value.currency.toUpperCase() !== payment.currency
    || ![payment.paymentIntentId, payment.chargeId].includes(value.chargeId)) notFound();
  let rows = await tx.select().from(refunds).where(eq(refunds.paymentId, payment.id));
  // A pending read taken for this report can show another refund failed after a concurrent write released that row as
  // missing. That read is as verified as the refund's own report, so it gets the same treatment before this report's
  // own write, on every path below. Rows it doesn't match exactly are left alone.
  for (const row of rows) {
    const current = input.pendingRefunds.find(refund => refund.id === row.processorId);
    if (row.status === 'failed' && row.processorId !== null && row.processorId !== value.id && current?.status === 'failed'
      && sameRefund(current, row, payment, context.gymId))
      await applyRefund(tx, context, clock, invoice, { invoiceId: invoice.id, paymentId: payment.id, refundId: row.id,
        processorId: row.processorId, amountCents: row.amountCents, currency: row.currency, status: 'failed' }, { verified: true }, warnings);
  }
  const appCreated = rows.some(row => row.taggedAt !== null && row.id === value.reservationId
    && row.amountCents === value.amount && row.currency === request.currency);
  const recorded = rows.find(row => row.processorId === value.id);
  if (recorded) return applyRefund(tx, context, clock, invoice, { ...request, refundId: recorded.id }, { appCreated, verified: true }, warnings);
  const reservations = rows.filter(row => row.processorId === null && row.status === 'pending');
  const own = reservations.find(row => row.taggedAt !== null && row.id === value.reservationId && row.amountCents === value.amount);
  if (own) return applyRefund(tx, context, clock, invoice, { ...request, refundId: own.id }, {}, warnings);
  const untagged = reservations.filter(row => row.taggedAt === null);
  if (value.reservationId === undefined && untagged.length) {
    if (untagged.length !== 1 || untagged[0]!.amountCents !== value.amount || untagged[0]!.currency !== request.currency)
      throw new Error('Refund reservation is ambiguous');
    return applyRefund(tx, context, clock, invoice, { ...request, refundId: untagged[0]!.id }, {}, warnings);
  }
  if (!refundReleased(value)) {
    // Unread processor rows keep their reservations, including rows linked after the processor reads.
    // Release confirmed missing rows newest first. If the external refund still needs room, an unread row forces a retry.
    const unread: string[] = [];
    const missing: (typeof refunds.$inferSelect)[] = [];
    for (const row of rows.filter(row => row.processorId !== null && row.status === 'pending')) {
      const current = input.pendingRefunds.find(refund => refund.id === row.processorId);
      if (!current && input.missingRefunds?.includes(row.processorId!)) {
        missing.push(row);
        continue;
      }
      if (!current || !sameRefund(current, row, payment, context.gymId)) {
        unread.push(row.id);
        continue;
      }
      if (refundReleased(current)) await applyRefund(tx, context, clock, invoice, { ...request,
        refundId: row.id, processorId: current.id, amountCents: current.amount, currency: row.currency, status: current.status }, {}, warnings);
    }
    rows = await tx.select().from(refunds).where(eq(refunds.paymentId, payment.id));
    let excess = rows.filter(row => !refundReleased(row)).reduce((sum, row) => sum + row.amountCents, value.amount - payment.amountCents);
    const newestFirst = (a: typeof refunds.$inferSelect, b: typeof refunds.$inferSelect) =>
      b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
    for (const row of missing.sort(newestFirst)) {
      if (excess <= 0) break;
      await applyRefund(tx, context, clock, invoice, { invoiceId: invoice.id, paymentId: payment.id, refundId: row.id,
        processorId: row.processorId!, amountCents: row.amountCents, currency: row.currency, status: 'failed' }, { missing: true }, warnings);
      excess -= row.amountCents;
    }
    if (excess > 0 && unread.length) {
      // An unverified row (an unread, unknown or mismatched read) blocks until the processor confirms it.
      for (const refundId of unread) logWarn('billing.refunds.unverified', { gymId: context.gymId, invoiceId: invoice.id, refundId });
      conflict('Pending refund must be reconciled before recording an external refund');
    }
    const outrun = [...reservations].sort(newestFirst);
    if (excess > outrun.reduce((sum, row) => sum + row.amountCents, 0)) conflict('Refund exceeds payment');
    for (const row of outrun) {
      if (excess <= 0) break;
      await applyRefund(tx, context, clock, invoice, { invoiceId: invoice.id, paymentId: payment.id, refundId: row.id,
        amountCents: row.amountCents, currency: row.currency, status: 'failed' }, {}, warnings);
      excess -= row.amountCents;
    }
  }
  return applyRefund(tx, context, clock, invoice, request, { appCreated }, warnings);
}

const refundProvenance = 'billing.refund.provenance';

/** Whether the row's failure released it because the processor couldn't find the refund, as recorded: the row's own
 * failure audit, then for an older failure without that flag, its provenance audit. `null` when neither records it. Both
 * reads go through the audits' gym, action and target index. */
export async function knownRefundRelease(tx: Transaction, gymId: string, row: Pick<typeof refunds.$inferSelect, 'id'>):
Promise<boolean | null> {
  const events = await tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), inArray(auditEvents.action, ['billing.refund.recorded', 'billing.refund.reversed']),
      eq(auditEvents.targetId, row.id)))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id));
  const failure = events.map(event => event.after as { status?: string; releasedMissing?: boolean } | null)
    .find(after => after?.status === 'failed');
  if (typeof failure?.releasedMissing === 'boolean') return failure.releasedMissing;
  const [provenance] = await tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, refundProvenance), eq(auditEvents.targetId, row.id)))
    .limit(1);
  const cached = (provenance?.after as { releasedMissing?: boolean } | null)?.releasedMissing;
  return typeof cached === 'boolean' ? cached : null;
}

/** Older failures record a release only in their `refund_missing` staff notice effect: search the gym's effects for it.
 * This reads the gym's whole effect history, so a writer records the answer as provenance once. */
export async function refundEffectSearch(tx: Transaction, gymId: string, invoiceId: string,
  row: Pick<typeof refunds.$inferSelect, 'id' | 'paymentId'>): Promise<boolean> {
  const work: TransitionEffect = { kind: 'staff_notice', notice: 'refund_missing', invoiceId, paymentId: row.paymentId, refundId: row.id };
  return (await tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, effectCreated), eq(auditEvents.after, work))).limit(1)).length > 0;
}

/** Record the provenance of the invoice's failed refunds with these processor IDs that have none yet, in a transaction of
 * its own, so a processor refund report that then fails keeps it and the restore check reads it on later passes. A report
 * passes the IDs `provenanceNeeded` returned. The caller holds the invoice lock, which every provenance writer takes and
 * then rereads under, so a refund gets at most one provenance audit. */
export async function recordRefundProvenance(tx: Transaction, context: MutationContext, clock: Clock, invoiceId: string,
  processorIds: readonly string[]) {
  if (!processorIds.length) return;
  const failed = await tx.select({ refund: refunds }).from(refunds).innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(and(eq(payments.invoiceId, invoiceId), eq(refunds.status, 'failed'), inArray(refunds.processorId, [...processorIds])));
  for (const { refund } of failed) await releasedAsMissing(tx, context, clock, invoiceId, refund);
}

/** The processor IDs of the failed refunds a processor refund report would ask `releasedAsMissing` about that have no
 * recorded release yet, read under the invoice lock without writing. A report for another payment, gym, currency or charge,
 * or on a processing invoice, asks about none, since `applyProcessorRefund` rejects it first. Otherwise the report asks
 * about its own failed row when it reports that row succeeded or failed with the same amount and currency, and about
 * another failed row its pending read for that ID shows failed with the same refund. A row already recorded as found or as
 * failed before found is never asked about, as `applyRefund` returns before `releasedAsMissing` for it. */
export async function provenanceNeeded(tx: Transaction, context: MutationContext, invoice: InvoiceRow,
  input: ProcessorRefundTransition): Promise<string[]> {
  const value = input.processorRefund;
  if (invoice.status === 'processing') return [];
  const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId));
  if (!payment || payment.invoiceId !== invoice.id || value.metadata.gymId !== context.gymId
    || value.currency.toUpperCase() !== payment.currency || ![payment.paymentIntentId, payment.chargeId].includes(value.chargeId))
    return [];
  const failed = await tx.select().from(refunds)
    .where(and(eq(refunds.paymentId, payment.id), eq(refunds.status, 'failed'), isNotNull(refunds.processorId)));
  const asked = failed.filter(row => {
    if (row.processorId === value.id)
      return (value.status === 'succeeded' || value.status === 'failed') && row.amountCents === value.amount
        && row.currency === payment.currency;
    const current = input.pendingRefunds.find(refund => refund.id === row.processorId);
    return current?.status === 'failed' && sameRefund(current, row, payment, context.gymId);
  });
  const needed: string[] = [];
  for (const row of asked) {
    if (await recorded(tx, missingFound, row.id) || await recorded(tx, missingFailedBeforeFound, row.id)) continue;
    if (await knownRefundRelease(tx, context.gymId, row) === null) needed.push(row.processorId!);
  }
  return needed;
}

/** Whether the row's failure released it because the processor couldn't find the refund: as recorded, or for an older
 * failure with no record, from a one-time effect search under the invoice lock whose answer is recorded as provenance. */
async function releasedAsMissing(tx: Transaction, context: MutationContext, clock: Clock, invoiceId: string,
  row: typeof refunds.$inferSelect): Promise<boolean> {
  const known = await knownRefundRelease(tx, row.gymId, row);
  if (known !== null) return known;
  const releasedMissing = await refundEffectSearch(tx, row.gymId, invoiceId, row);
  await audit(tx, context, clock, refundProvenance, 'refund', row.id, { releasedMissing });
  return releasedMissing;
}

async function createdInApp(tx: Transaction, row: typeof refunds.$inferSelect): Promise<boolean> {
  if (row.processorId === null || row.taggedAt !== null || await recorded(tx, 'billing.refund.requested', row.id)
    || await duplicateReservation(tx, row)) return true;
  // Legacy app reservations have no tag, and may already have been linked to a pending processor refund. Their
  // original audit distinguishes them from external refunds first observed pending with a processor ID.
  const events = await tx.select({ after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.action, 'billing.refund.recorded'), eq(auditEvents.targetId, row.id)));
  return events.some(event => {
    const original = event.after as { status?: string; processorId?: string | null } | null;
    return original?.status === 'pending' && original.processorId === null;
  });
}
