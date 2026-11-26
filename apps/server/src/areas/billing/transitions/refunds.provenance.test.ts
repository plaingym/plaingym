// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, inject, it } from 'vitest';
import { and, asc, count, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Read transaction-local statistics from the disposable test database.
import { sql } from 'drizzle-orm';
import { auditEvents, uuidv7, type Transaction } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- ANALYZE uses the disposable database's admin connection.
import { openConnection } from '@plaingym/db/client';
import { databaseUrl, useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import type { ProcessorRefundTransition } from '../../../core/interfaces/invoice-transitions.js';
import { createInvoiceTransitions } from './index.js';
import { effectCreated, missingFailedBeforeFound, missingFound, systemContext } from './store.js';

const db = useTestDatabase(), factory = createFactories(db);
const refundRecorded = 'billing.refund.recorded', refundReversed = 'billing.refund.reversed';
const refundProvenance = 'billing.refund.provenance';

async function fixture() {
  const gymId = uuidv7(), paymentId = uuidv7();
  await factory('gyms', gymId);
  const household = await factory('households', gymId);
  const { id: invoiceId } = await factory('invoices', gymId,
    { householdId: household.id, status: 'open', number: 1, amountCents: 10000, currency: 'USD' });
  const clock = new TestClock('2028-03-10T17:00:00Z'), context = systemContext(gymId);
  const transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  await transitions.cardSucceeded(context, { invoiceId, paymentId, paymentIntentId: 'pi_provenance', chargeId: 'ch_provenance',
    amountCents: 10000, currency: 'USD', paidAt: clock.now().toISOString(), method: 'card' });
  const report = (id: string, amount: number, status: ProcessorRefundTransition['processorRefund']['status'] = 'succeeded'):
  ProcessorRefundTransition => ({
    invoiceId, paymentId, refundId: uuidv7(), pendingRefunds: [],
    processorRefund: { id, amount, status, chargeId: 'ch_provenance', currency: 'usd', metadata: { gymId } },
  });
  const apply = (request: ProcessorRefundTransition) => transitions.processorRefund(context, request);
  const events = (action: string, targetId: string) => db.forGym(gymId, tx => tx.select().from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)))
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id)));
  const notice = (name: string, refundId: string) => db.forGym(gymId, tx => tx.select().from(auditEvents)
    .where(and(eq(auditEvents.action, effectCreated),
      eq(auditEvents.after, { kind: 'staff_notice', notice: name, invoiceId, paymentId, refundId }))));
  return { gymId, household, clock, context, report, apply, events, notice };
}

async function auditTuplesRead(tx: Transaction) {
  // eslint-disable-next-line database/system-tables -- Read PostgreSQL's statistics view through the measured transaction.
  const [stats] = await tx.execute<{ tuples: number }>(sql`
    select (seq_tup_read + coalesce(idx_tup_fetch, 0))::int as tuples
    from pg_stat_xact_user_tables where schemaname = 'public' and relname = 'audit_events'
  `);
  return stats!.tuples;
}

let measured: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  measured = await fixture();
  const { gymId, household, clock } = measured;
  const { id: invoiceId } = await factory('invoices', gymId, { householdId: household.id });
  for (let batch = 0; batch < 20; batch++) {
    await db.forGym(gymId, tx => tx.insert(auditEvents).values(Array.from({ length: 1000 }, () => ({
      id: uuidv7(), gymId, action: effectCreated, targetType: 'invoice_effect', targetId: uuidv7(),
      actorKind: 'system', occurredAt: clock.now(), after: { kind: 'receipt', invoiceId },
    }))));
  }
  const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, db.name), 1);
  try { await admin.sql`analyze audit_events`; } finally { await admin.close(); }
});

/** The `audit_events` tuples a processor refund report reads across all its transactions, including one that throws, and
 * how many transactions it opens. */
async function measureReport(request: ProcessorRefundTransition) {
  let tuples = 0, transactions = 0;
  const scope: typeof db.forGym = (gymId, work) => db.forGym(gymId, async tx => {
    transactions++;
    const before = await auditTuplesRead(tx);
    try { return await work(tx); } finally { tuples += (await auditTuplesRead(tx)) - before; }
  });
  const report = createInvoiceTransitions({ scope, clock: measured.clock }).processorRefund(measured.context, request);
  const settled = await report.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  return { tuples, transactions, ...settled };
}

async function measure(request: ProcessorRefundTransition) {
  const { tuples, value, error } = await measureReport(request);
  if (error !== undefined) throw error;
  expect(value!.outcome).toBe('ignored');
  return tuples;
}

it('reads at most 50 audit tuples for success and failure reports on an ordinary failed refund', async () => {
  const { report, apply, events } = measured;
  const failed = report('re_ordinary', 1000, 'failed');
  expect((await apply(failed)).outcome).toBe('applied');
  expect(await measure(report('re_ordinary', 1000))).toBeLessThanOrEqual(50);
  expect(await measure(failed)).toBeLessThanOrEqual(50);
  expect(await events(missingFound, failed.refundId)).toHaveLength(0);
  expect(await events(missingFailedBeforeFound, failed.refundId)).toHaveLength(0);
  expect(await events(refundProvenance, failed.refundId)).toHaveLength(0);
});

async function legacyFailure(processorId: string, releasedMissing: boolean,
  { gymId, clock, report }: Pick<typeof measured, 'gymId' | 'clock' | 'report'> = measured) {
  const request = report(processorId, 2000), resolvedAt = clock.now();
  const after = { paymentId: request.paymentId, processorId, amountCents: 2000, currency: 'USD', status: 'failed', resolvedAt };
  await factory('refunds', gymId, { id: request.refundId, ...after });
  await factory('auditEvents', gymId, { action: refundRecorded, targetType: 'refund', targetId: request.refundId,
    after, occurredAt: resolvedAt });
  if (releasedMissing) await factory('auditEvents', gymId, { action: effectCreated, targetType: 'invoice_effect', occurredAt: resolvedAt,
    after: { kind: 'staff_notice', notice: 'refund_missing', invoiceId: request.invoiceId, paymentId: request.paymentId,
      refundId: request.refundId } });
  return request;
}

it('finds a legacy release once, records provenance for older failures, and skips the effect scan on later reports', async () => {
  const { gymId, events, notice, report } = measured;
  const found = await legacyFailure('re_legacy_found', true);
  const failedFirst = await legacyFailure('re_legacy_failed_first', true);
  const ordinary = await legacyFailure('re_legacy_ordinary', false);
  // The lower bound shows the measure sees the effect search that older failures fall back to.
  expect(await measure(found)).toBeGreaterThan(10_000);
  expect(await events(missingFound, found.refundId)).toHaveLength(1);
  expect(await notice('refund_found', found.refundId)).toHaveLength(1);
  expect(await events(refundProvenance, found.refundId)).toMatchObject([
    { targetType: 'refund', targetId: found.refundId, after: { releasedMissing: true } },
  ]);

  // First report on an ordinary legacy failure searches once and records false provenance.
  expect(await measure(ordinary)).toBeGreaterThan(10_000);
  expect(await events(missingFound, ordinary.refundId)).toHaveLength(0);
  expect(await notice('refund_found', ordinary.refundId)).toHaveLength(0);
  expect(await events(refundProvenance, ordinary.refundId)).toMatchObject([
    { targetType: 'refund', targetId: ordinary.refundId, after: { releasedMissing: false } },
  ]);

  const failure = report('re_legacy_failed_first', 2000, 'failed');
  await measure(failure);
  expect(await events(missingFailedBeforeFound, failedFirst.refundId)).toHaveLength(1);
  expect(await events(refundProvenance, failedFirst.refundId)).toMatchObject([
    { targetType: 'refund', targetId: failedFirst.refundId, after: { releasedMissing: true } },
  ]);

  // Later reports read the markers or the indexed provenance audit instead of scanning effects, and write no audits.
  const auditCount = async () => (await db.forGym(gymId, tx => tx.select({ total: count() }).from(auditEvents)))[0]!.total;
  const before = await auditCount();
  expect(await measure(found)).toBeLessThanOrEqual(50);
  expect(await measure(failedFirst)).toBeLessThanOrEqual(50);
  expect(await measure(failure)).toBeLessThanOrEqual(50);
  expect(await measure(ordinary)).toBeLessThanOrEqual(50);
  expect(await measure(report('re_legacy_ordinary', 2000, 'failed'))).toBeLessThanOrEqual(50);
  expect(await auditCount()).toBe(before);
  expect(await events(refundProvenance, ordinary.refundId)).toHaveLength(1);
  expect(await events(refundProvenance, found.refundId)).toHaveLength(1);
  expect(await events(refundProvenance, failedFirst.refundId)).toHaveLength(1);
});

/** Another paid 10000 invoice in the measured gym, with its own charge. */
async function paidInvoice(name: string, number = 2) {
  const { gymId, household, clock, context } = measured;
  const paymentId = uuidv7(), chargeId = `ch_${name}`;
  const { id: invoiceId } = await factory('invoices', gymId, { householdId: household.id, status: 'open', number, amountCents: 10000, currency: 'USD' });
  await createInvoiceTransitions({ scope: db.forGym, clock }).cardSucceeded(context, { invoiceId, paymentId, paymentIntentId: `pi_${name}`,
    chargeId, amountCents: 10000, currency: 'USD', paidAt: clock.now().toISOString(), method: 'card' });
  const refund = (id: string, amount: number, status: ProcessorRefundTransition['processorRefund']['status']):
  ProcessorRefundTransition['processorRefund'] => ({ id, amount, status, chargeId, currency: 'usd', metadata: { gymId } });
  return { invoiceId, paymentId, refund };
}

it('keeps an older failure\'s provenance when the report then conflicts, so a retry skips the effect scan', async () => {
  const { gymId, clock, events } = measured;
  const { invoiceId, paymentId, refund } = await paidInvoice('conflict');
  const legacyId = uuidv7(), resolvedAt = clock.now();
  const after = { paymentId, processorId: 're_conflict_legacy', amountCents: 2000, currency: 'USD', status: 'failed', resolvedAt };
  await factory('refunds', gymId, { id: legacyId, ...after });
  await factory('auditEvents', gymId, { action: refundRecorded, targetType: 'refund', targetId: legacyId, after, occurredAt: resolvedAt });
  // A pending refund the report reads nothing for keeps its room, so the external refund that needs it conflicts.
  await factory('refunds', gymId, { id: uuidv7(), paymentId, processorId: 're_conflict_unread', amountCents: 5000, currency: 'USD',
    status: 'pending' });
  const external: ProcessorRefundTransition = { invoiceId, paymentId, refundId: uuidv7(),
    pendingRefunds: [refund('re_conflict_legacy', 2000, 'failed')], processorRefund: refund('re_conflict_external', 6000, 'succeeded') };
  const conflictMessage = 'Pending refund must be reconciled before recording an external refund';

  const first = await measureReport(external);
  expect(first.error).toBeInstanceOf(Error);
  expect((first.error as Error).message).toBe(conflictMessage);
  expect(first.tuples).toBeGreaterThan(10_000);
  expect(await events(refundProvenance, legacyId)).toMatchObject([
    { targetType: 'refund', targetId: legacyId, after: { releasedMissing: false } },
  ]);

  const second = await measureReport(external);
  expect((second.error as Error).message).toBe(conflictMessage);
  expect(second.tuples).toBeLessThanOrEqual(50);
  expect(await events(refundProvenance, legacyId)).toHaveLength(1);
});

/** An older failed refund on the payment: its failure audit has no `releasedMissing` flag and it has no provenance audit,
 * but its `refund_missing` staff notice shows it was released as missing. */
async function legacyRow(invoiceId: string, paymentId: string, processorId: string, amountCents: number) {
  const { gymId, clock } = measured;
  const refundId = uuidv7(), resolvedAt = clock.now();
  const after = { paymentId, processorId, amountCents, currency: 'USD', status: 'failed', resolvedAt };
  await factory('refunds', gymId, { id: refundId, ...after });
  await factory('auditEvents', gymId, { action: refundRecorded, targetType: 'refund', targetId: refundId, after, occurredAt: resolvedAt });
  await factory('auditEvents', gymId, { action: effectCreated, targetType: 'invoice_effect', occurredAt: resolvedAt,
    after: { kind: 'staff_notice', notice: 'refund_missing', invoiceId, paymentId, refundId } });
  return refundId;
}

it('runs a report on a payment with no failed refund in one transaction', async () => {
  const { invoiceId, paymentId, refund } = await paidInvoice('single', 3);
  const request: ProcessorRefundTransition = { invoiceId, paymentId, refundId: uuidv7(), pendingRefunds: [],
    processorRefund: refund('re_single', 1000, 'succeeded') };
  const first = await measureReport(request);
  expect(first.error).toBeUndefined();
  expect(first.value!.outcome).toBe('applied');
  expect(first.transactions).toBe(1);
  const replay = await measureReport(request);
  expect(replay.value!.outcome).toBe('ignored');
  expect(replay.transactions).toBe(1);
});

it('records no provenance for a report rejected before it asks about any refund', async () => {
  const { events } = measured;
  const { invoiceId, paymentId, refund } = await paidInvoice('foreign', 4);
  const legacyId = await legacyRow(invoiceId, paymentId, 're_foreign_legacy', 2000);
  const request: ProcessorRefundTransition = { invoiceId, paymentId, refundId: uuidv7(),
    pendingRefunds: [refund('re_foreign_legacy', 2000, 'failed')],
    processorRefund: { ...refund('re_foreign_external', 1000, 'succeeded'), metadata: { gymId: uuidv7() } } };
  const rejected = await measureReport(request);
  expect(rejected.error).toMatchObject({ code: 'not_found' });
  expect(rejected.tuples).toBeLessThanOrEqual(50);
  expect(rejected.transactions).toBe(1);
  expect(await events(refundProvenance, legacyId)).toHaveLength(0);
});

it('records no provenance for a pending report on its own older failure or a mismatched pending read', async () => {
  const { events } = measured;
  const { invoiceId, paymentId, refund } = await paidInvoice('unasked', 5);
  const ownId = await legacyRow(invoiceId, paymentId, 're_unasked_own', 2000);
  const pending = await measureReport({ invoiceId, paymentId, refundId: uuidv7(), pendingRefunds: [],
    processorRefund: refund('re_unasked_own', 2000, 'pending') });
  expect(pending.value!.outcome).toBe('ignored');
  expect(pending.tuples).toBeLessThanOrEqual(50);
  expect(await events(refundProvenance, ownId)).toHaveLength(0);

  const otherId = await legacyRow(invoiceId, paymentId, 're_unasked_other', 2000);
  const mismatched = await measureReport({ invoiceId, paymentId, refundId: uuidv7(),
    pendingRefunds: [refund('re_unasked_other', 1500, 'failed')], processorRefund: refund('re_unasked_external', 1000, 'succeeded') });
  expect(mismatched.value!.outcome).toBe('applied');
  expect(mismatched.tuples).toBeLessThanOrEqual(50);
  expect(await events(refundProvenance, otherId)).toHaveLength(0);
  expect(await events(refundProvenance, ownId)).toHaveLength(0);
});

it('leaves one provenance audit per older failure when two reports for the invoice race', async () => {
  const f = await fixture();
  const found = await legacyFailure('re_race_found', true, f), ordinary = await legacyFailure('re_race_ordinary', false, f);
  // Both reports' pending reads show the older failures, so both ask about them.
  const pendingRefunds = [f.report('re_race_found', 2000, 'failed').processorRefund, f.report('re_race_ordinary', 2000, 'failed').processorRefund];
  const results = await Promise.all(['re_race_a', 're_race_b'].map(id => f.apply({ ...f.report(id, 1000), pendingRefunds })));
  expect(results.map(value => value.outcome)).toEqual(['applied', 'applied']);
  expect(await f.events(refundProvenance, found.refundId)).toMatchObject([{ after: { releasedMissing: true } }]);
  expect(await f.events(refundProvenance, ordinary.refundId)).toMatchObject([{ after: { releasedMissing: false } }]);
});

it('links the missing notice from the failure audit and records false on ordinary failures and reversals', async () => {
  const { apply, clock, report, events, notice } = await fixture();
  const missing = report('re_missing', 2000, 'pending');
  await apply(missing);
  clock.advance(1000);
  const external = report('re_external', 9000);
  await apply({ ...external, missingRefunds: ['re_missing'] });
  const missingNotices = await notice('refund_missing', missing.refundId);
  expect(missingNotices).toHaveLength(1);
  const [pending, release] = await events(refundRecorded, missing.refundId);
  expect(pending?.after).toMatchObject({ status: 'pending' });
  expect(pending?.after).not.toHaveProperty('releasedMissing');
  expect(release?.after).toMatchObject({ status: 'failed', releasedMissing: true, missingEffectId: missingNotices[0]!.targetId });
  await apply(report('re_missing', 2000, 'succeeded'));
  expect(await events(missingFound, missing.refundId)).toHaveLength(1);
  expect(await events(refundProvenance, missing.refundId)).toHaveLength(0);
  const [succeeded] = await events(refundRecorded, external.refundId);
  expect(succeeded?.after).toMatchObject({ status: 'succeeded' });
  expect(succeeded?.after).not.toHaveProperty('releasedMissing');

  const failed = report('re_failed', 1000, 'failed');
  await apply(failed);
  expect(await notice('refund_failed', failed.refundId)).toHaveLength(1);
  const [failure] = await events(refundRecorded, failed.refundId);
  expect(failure?.after).toMatchObject({ status: 'failed', releasedMissing: false });
  expect(failure?.after).not.toHaveProperty('missingEffectId');
  await apply(report('re_failed', 1000, 'succeeded'));
  expect(await events(refundProvenance, failed.refundId)).toHaveLength(0);
  await apply(report('re_external', 9000, 'failed'));
  const [reversed] = await events(refundReversed, external.refundId);
  expect(reversed?.after).toMatchObject({ status: 'failed', releasedMissing: false });
  expect(reversed?.after).not.toHaveProperty('missingEffectId');
  await apply(report('re_external', 9000, 'succeeded'));
  expect(await events(refundProvenance, external.refundId)).toHaveLength(0);
});
