// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, inject, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- Read transaction-local statistics from the disposable test database.
import { sql } from 'drizzle-orm';
import { auditEvents, uuidv7, type Transaction } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports, database/system-tables -- ANALYZE uses the disposable database's admin connection.
import { openConnection } from '@plaingym/db/client';
import { databaseUrl, useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { effectCreated } from '../transitions/store.js';
import { releasedAsMissing } from './reconciliation.js';

const db = useTestDatabase(), factory = createFactories(db);
const occurredAt = new Date('2028-03-10T17:00:00Z');
let gymId: string, invoiceId: string, paymentId: string;

async function auditTuplesRead(tx: Transaction) {
  // eslint-disable-next-line database/system-tables -- Read PostgreSQL's statistics view through the measured transaction.
  const [stats] = await tx.execute<{ tuples: number }>(sql`
    select (seq_tup_read + coalesce(idx_tup_fetch, 0))::int as tuples
    from pg_stat_xact_user_tables where schemaname = 'public' and relname = 'audit_events'
  `);
  return stats!.tuples;
}

/** The released processor IDs of one restore check's read, and the `audit_events` tuples it read. */
async function released(processorIds: string[]) {
  return db.forGym(gymId, async tx => {
    const before = await auditTuplesRead(tx);
    const value = await releasedAsMissing(tx, gymId, new Set(processorIds));
    return { released: [...value], tuples: (await auditTuplesRead(tx)) - before };
  });
}

/** A failed processor refund on the gym's payment, with its failure audit and, as given, its provenance audit and its
 * `refund_missing` staff notice. */
async function failedRefund(processorId: string, { flag, provenance, notice }:
{ flag?: boolean; provenance?: boolean; notice?: boolean }) {
  const refundId = uuidv7();
  const after = { paymentId, processorId, amountCents: 1000, currency: 'USD', status: 'failed', resolvedAt: occurredAt,
    ...(flag === undefined ? {} : { releasedMissing: flag }) };
  await factory('refunds', gymId, { id: refundId, paymentId, processorId, amountCents: 1000, currency: 'USD', status: 'failed',
    resolvedAt: occurredAt });
  await factory('auditEvents', gymId, { action: 'billing.refund.recorded', targetType: 'refund', targetId: refundId, after, occurredAt });
  if (provenance !== undefined) await factory('auditEvents', gymId, { action: 'billing.refund.provenance', targetType: 'refund',
    targetId: refundId, after: { releasedMissing: provenance }, occurredAt });
  if (notice) await factory('auditEvents', gymId, { action: effectCreated, targetType: 'invoice_effect', occurredAt,
    after: { kind: 'staff_notice', notice: 'refund_missing', invoiceId, paymentId, refundId } });
  return refundId;
}

beforeAll(async () => {
  gymId = uuidv7();
  await factory('gyms', gymId);
  const household = await factory('households', gymId);
  ({ id: invoiceId } = await factory('invoices', gymId, { householdId: household.id, currency: 'USD' }));
  ({ id: paymentId } = await factory('payments', gymId, { invoiceId, currency: 'USD', method: 'card' }));
  for (let batch = 0; batch < 20; batch++) {
    await db.forGym(gymId, tx => tx.insert(auditEvents).values(Array.from({ length: 1000 }, () => ({
      id: uuidv7(), gymId, action: effectCreated, targetType: 'invoice_effect', targetId: uuidv7(),
      actorKind: 'system', occurredAt, after: { kind: 'receipt', invoiceId },
    }))));
  }
  const admin = openConnection(databaseUrl(inject('testDatabase').adminUrl, db.name), 1);
  try { await admin.sql`analyze audit_events`; } finally { await admin.close(); }
});

describe('the restore check\'s missing processor refunds, over a long effect history', () => {
  it('reads a released refund from its failure audit without searching effects', async () => {
    await failedRefund('re_flag_released', { flag: true, notice: true });
    const result = await released(['re_flag_released']);
    expect(result.released).toEqual(['re_flag_released']);
    expect(result.tuples).toBeLessThanOrEqual(50);
  });

  it('keeps an ordinary failure, read from its failure audit or its provenance audit, for the owner', async () => {
    await failedRefund('re_flag_ordinary', { flag: false });
    await failedRefund('re_provenance_ordinary', { provenance: false });
    const result = await released(['re_flag_ordinary', 're_provenance_ordinary']);
    expect(result.released).toEqual([]);
    expect(result.tuples).toBeLessThanOrEqual(50);
  });

  it('reads a released older failure from its provenance audit', async () => {
    await failedRefund('re_provenance_released', { provenance: true });
    const result = await released(['re_provenance_released']);
    expect(result.released).toEqual(['re_provenance_released']);
    expect(result.tuples).toBeLessThanOrEqual(50);
  });

  it('falls back to the effect search for an older failure with neither record', async () => {
    await failedRefund('re_legacy_released', { notice: true });
    await failedRefund('re_legacy_ordinary', {});
    const result = await released(['re_legacy_released', 're_legacy_ordinary']);
    expect(result.released).toEqual(['re_legacy_released']);
    expect(result.tuples).toBeGreaterThan(10_000);
  });

  it('counts no other gym\'s effect audit with the same notice', async () => {
    const refundId = await failedRefund('re_other_gym', {});
    const otherGym = uuidv7();
    await factory('gyms', otherGym);
    await factory('auditEvents', otherGym, { action: effectCreated, targetType: 'invoice_effect', occurredAt,
      after: { kind: 'staff_notice', notice: 'refund_missing', invoiceId, paymentId, refundId } });
    expect((await released(['re_other_gym'])).released).toEqual([]);
  });

  it('keeps a refund that is still pending or unknown', async () => {
    await factory('refunds', gymId, { paymentId, processorId: 're_still_pending', amountCents: 1000, currency: 'USD', status: 'pending' });
    expect((await released(['re_still_pending', 're_unknown'])).released).toEqual([]);
  });
});
