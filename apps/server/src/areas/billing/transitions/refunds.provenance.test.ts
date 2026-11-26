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

async function measure(request: ProcessorRefundTransition) {
  let tuples = 0;
  const scope: typeof db.forGym = (gymId, work) => db.forGym(gymId, async tx => {
    const before = await auditTuplesRead(tx);
    const value = await work(tx);
    tuples = (await auditTuplesRead(tx)) - before;
    return value;
  });
  const value = await createInvoiceTransitions({ scope, clock: measured.clock }).processorRefund(measured.context, request);
  expect(value.outcome).toBe('ignored');
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

async function legacyFailure(processorId: string, releasedMissing: boolean) {
  const { gymId, clock, report } = measured;
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
