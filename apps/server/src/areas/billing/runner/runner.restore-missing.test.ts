// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { effectCreated } from '../transitions/store.js';
import { useRunnerFixture, type Fixture } from './runner.fixture.test-helper.js';

const { fixture } = useRunnerFixture();

/**
 * A paid 10000 card payment with a pending 2000 refund whose processor ID the fake doesn't hold, so Stripe answers that
 * it doesn't exist. Billing is paused; the snapshot is taken before any external refund.
 */
async function paidWithMissingRefund() {
  const f = await fixture();
  await f.runner.daily(f.gymId);
  const rows = await f.read(), payment = rows.payments[0]!;
  expect(rows.invoices[0]!.status).toBe('paid');
  const refundId = uuidv7(), context = { gymId: f.gymId, actor: { kind: 'system' as const } };
  const base = { invoiceId: payment.invoiceId, paymentId: payment.id, currency: payment.currency, refundId, amountCents: 2000 };
  await f.transitions.refund(context, { ...base, status: 'pending', processorId: 're_gone' });
  await f.enable(false);
  const snapshotAt = f.clock.now();
  f.clock.advance(60_000);
  const intentId = rows.attempts[0]!.paymentIntentId!;
  const external = (amount: number) => f.provider.refund({ chargeId: intentId, amount, idempotencyKey: 'external' });
  return { f, payment, refundId, snapshotAt, external, context, base };
}
const missingNotices = async (f: Fixture) => (await f.read()).audits
  .filter(row => row.action === effectCreated && (row.after as { notice?: string }).notice === 'refund_missing');
const gone = { kind: 'refund', id: 're_gone', reason: 'manual_resolution_required' };

describe('a restore check that reads a stored refund Stripe reports missing', () => {
  it('needs no action once an external refund in the same pass releases it as missing', async () => {
    const { f, refundId, snapshotAt, external, payment } = await paidWithMissingRefund();
    const outside = await external(9000);
    const result = await f.runner.postRestore(f.gymId, snapshotAt);
    expect(result.issues).not.toContainEqual(expect.objectContaining({ id: 're_gone' }));
    expect(result).toMatchObject({ readyForOwnerReview: true, issues: [] });
    const rows = await f.read();
    expect(rows.refunds.find(row => row.id === refundId)).toMatchObject({ status: 'failed', processorId: 're_gone' });
    expect(rows.refunds.find(row => row.processorId === outside.id)).toMatchObject({ status: 'succeeded', amountCents: 9000 });
    const notices = await missingNotices(f);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.after).toEqual({ kind: 'staff_notice', notice: 'refund_missing', invoiceId: payment.invoiceId,
      paymentId: payment.id, refundId });
  });
  it('keeps the issue while the refund is still pending', async () => {
    const { f, refundId, snapshotAt, external } = await paidWithMissingRefund();
    await external(8000);
    const result = await f.runner.postRestore(f.gymId, snapshotAt);
    expect(result.readyForOwnerReview).toBe(false);
    expect(result.issues).toContainEqual(gone);
    expect(result.issues).toContainEqual({ kind: 'refund', id: refundId, reason: 'unresolved' });
    expect((await f.read()).refunds.find(row => row.id === refundId)).toMatchObject({ status: 'pending' });
    expect(await missingNotices(f)).toEqual([]);
  });
  it('keeps the issue when the refund read was uncertain and an external refund needs its room', async () => {
    const { f, refundId, snapshotAt, external } = await paidWithMissingRefund();
    const outside = await external(9000);
    const read = f.provider.readPaymentObject.bind(f.provider);
    vi.spyOn(f.provider, 'readPaymentObject').mockImplementation(async reference =>
      reference.id === 're_gone' ? { status: 'unknown', reference } : read(reference));
    const result = await f.runner.postRestore(f.gymId, snapshotAt);
    expect(result.readyForOwnerReview).toBe(false);
    expect(result.issues).toContainEqual(gone);
    const rows = await f.read();
    expect(rows.refunds.find(row => row.processorId === outside.id)).toBeUndefined();
    expect(rows.refunds.find(row => row.id === refundId)).toMatchObject({ status: 'pending' });
    expect(await missingNotices(f)).toEqual([]);
  });
  it('keeps the issue for a refund that failed another way during the check', async () => {
    const { f, refundId, snapshotAt, context, base } = await paidWithMissingRefund();
    const list = f.provider.listChangesSince.bind(f.provider);
    vi.spyOn(f.provider, 'listChangesSince').mockImplementation(async (since, options) => {
      await f.transitions.refund(context, { ...base, status: 'failed', processorId: 're_gone' });
      return list(since, options);
    });
    const result = await f.runner.postRestore(f.gymId, snapshotAt);
    expect(result.readyForOwnerReview).toBe(false);
    expect(result.issues).toContainEqual(gone);
    const rows = await f.read();
    expect(rows.refunds.find(row => row.id === refundId)).toMatchObject({ status: 'failed' });
    expect(rows.audits.filter(row => row.action === effectCreated && (row.after as { notice?: string }).notice === 'refund_failed'))
      .toHaveLength(1);
    expect(await missingNotices(f)).toEqual([]);
  });
});
