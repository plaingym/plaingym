// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../../core/clock.js';
import type { ProcessorRefundTransition, RefundTransition } from '../../../core/interfaces/invoice-transitions.js';
import { setLogSink } from '../../../core/log.js';
import { createInvoiceTransitions } from './index.js';
import { missingFound, missingFoundFailed, systemContext } from './store.js';

const db = useTestDatabase(), factory = createFactories(db);
const foundEvent = 'billing.refunds.missing_found', failedEvent = 'billing.refunds.missing_found_failed';
const unverifiedEvent = 'billing.refunds.unverified';

async function fixture() {
  const gymId = uuidv7(), paymentId = uuidv7();
  await factory('gyms', gymId);
  const household = await factory('households', gymId);
  const { id: invoiceId } = await factory('invoices', gymId,
    { householdId: household.id, status: 'open', number: 1, amountCents: 10000, currency: 'USD' });
  const clock = new TestClock('2028-03-10T17:00:00Z'), context = systemContext(gymId);
  const transitions = createInvoiceTransitions({ scope: db.forGym, clock });
  await transitions.cardSucceeded(context, { invoiceId, paymentId, paymentIntentId: 'pi_warnings', chargeId: 'ch_warnings',
    amountCents: 10000, currency: 'USD', paidAt: clock.now().toISOString(), method: 'card' });
  const report = (id: string, amount: number, status: ProcessorRefundTransition['processorRefund']['status'] = 'succeeded'):
  ProcessorRefundTransition => ({
    invoiceId, paymentId, refundId: uuidv7(), pendingRefunds: [],
    processorRefund: { id, amount, status, chargeId: 'ch_warnings', currency: 'usd', metadata: { gymId } },
  });
  const missing = report('re_a', 2000, 'pending');
  await transitions.processorRefund(context, missing);
  await transitions.processorRefund(context, { ...report('re_external', 9000), missingRefunds: ['re_a'] });
  const found = report('re_a', 2000);
  const audits = (action: string) => db.forGym(gymId, tx => tx.select().from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, missing.refundId))));
  return { gymId, invoiceId, paymentId, clock, context, transitions, report, found, missing, audits };
}

type Warning = { event: string; level: string; gymId: string; invoiceId: string; refundId: string };

it.each(['processorRefund', 'refund'] as const)('emits the found warning after commit through %s', async method => {
  const f = await fixture();
  const plain: RefundTransition = { invoiceId: f.invoiceId, paymentId: f.paymentId, refundId: f.missing.refundId,
    processorId: 're_a', amountCents: 2000, currency: 'USD', status: 'succeeded' };
  const send = (service: typeof f.transitions) => method === 'refund'
    ? service.refund(f.context, plain) : service.processorRefund(f.context, f.found);
  const interrupted: typeof db.forGym = (gymId, work) => db.forGym(gymId, async tx => {
    await work(tx);
    throw new Error('Commit interrupted');
  });
  const lines: Warning[] = [], previous = setLogSink(line => lines.push(JSON.parse(line) as Warning));
  try {
    await expect(send(createInvoiceTransitions({ scope: interrupted, clock: f.clock }))).rejects.toThrow('Commit interrupted');
    expect(lines.filter(line => line.event === foundEvent)).toHaveLength(0);
    expect(await f.audits(missingFound)).toHaveLength(0);

    const committing: typeof db.forGym = (gymId, work) => db.forGym(gymId, async tx => {
      const value = await work(tx);
      expect(lines.filter(line => line.event === foundEvent)).toHaveLength(0);
      return value;
    });
    expect((await send(createInvoiceTransitions({ scope: committing, clock: f.clock }))).outcome).toBe('ignored');
    expect(lines.filter(line => line.event === foundEvent)).toEqual([
      expect.objectContaining({ event: foundEvent, level: 'warn', gymId: f.gymId, invoiceId: f.invoiceId, refundId: f.missing.refundId }),
    ]);
    expect(await f.audits(missingFound)).toHaveLength(1);
    expect((await send(f.transitions)).outcome).toBe('ignored');
    expect(lines.filter(line => line.event === foundEvent)).toHaveLength(1);
    expect(await f.audits(missingFound)).toHaveLength(1);
  } finally { setLogSink(previous); }
});

it('emits the failed follow-up warning only when the separate refund commits', async () => {
  const f = await fixture();
  await f.transitions.processorRefund(f.context, f.found);
  const pending = f.report('re_c', 1000, 'pending');
  await f.transitions.processorRefund(f.context, pending);
  const failedA = f.report('re_a', 2000, 'failed').processorRefund;
  const failedC = f.report('re_c', 1000, 'failed').processorRefund;
  const separate = { ...f.report('re_b', 1000), pendingRefunds: [failedA] };
  const lines: Warning[] = [], previous = setLogSink(line => lines.push(JSON.parse(line) as Warning));
  try {
    await expect(f.transitions.processorRefund(f.context, separate)).rejects
      .toThrow('Pending refund must be reconciled before recording an external refund');
    expect(lines.filter(line => line.event === failedEvent)).toHaveLength(0);
    expect(await f.audits(missingFoundFailed)).toHaveLength(0);
    expect(lines.filter(line => line.event === unverifiedEvent)).toEqual([
      expect.objectContaining({ level: 'warn', gymId: f.gymId, invoiceId: f.invoiceId, refundId: pending.refundId }),
    ]);

    const retry = { ...separate, pendingRefunds: [failedA, failedC] };
    expect((await f.transitions.processorRefund(f.context, retry)).outcome).toBe('applied');
    expect(lines.filter(line => line.event === failedEvent)).toEqual([
      expect.objectContaining({ level: 'warn', gymId: f.gymId, invoiceId: f.invoiceId, refundId: f.missing.refundId }),
    ]);
    expect(await f.audits(missingFoundFailed)).toHaveLength(1);
    expect((await f.transitions.processorRefund(f.context, retry)).outcome).toBe('ignored');
    expect(lines.filter(line => line.event === failedEvent)).toHaveLength(1);
    expect(await f.audits(missingFoundFailed)).toHaveLength(1);
  } finally { setLogSink(previous); }
});
