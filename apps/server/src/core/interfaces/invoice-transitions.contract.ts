// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MutationContext } from './common.js';
import type { CardSuccess, InvoiceEffect, InvoiceTransitions, ManualPayment, RefundTransition } from './invoice-transitions.js';

export interface InvoiceTransitionsHarness {
  transitions: InvoiceTransitions;
  context: MutationContext;
  /** A card success for the seeded pending attempt of a cycle invoice, for the invoice's full amount. */
  success: CardSuccess & { attemptId: string };
  /** A cash payment of the same invoice, for the full amount. */
  manual: ManualPayment;
  read(): Promise<{ invoice: string; attempt: { status: string; declineCode: string | null }; effects: InvoiceEffect['kind'][] }>;
}

/** Both the fake and the real transitions run these cases, so the fake can't drift from cancellation or refund rules. */
export function invoiceTransitionsContract(name: string, create: () => Promise<InvoiceTransitionsHarness>) {
  describe(name + ': cancellations and refund reversals', () => {
    const count = (effects: readonly string[], kind: InvoiceEffect['kind']) => effects.filter((effect) => effect === kind).length;
    it('closes a cancelled, never-confirmed attempt as confirm_abandoned without touching the invoice or dunning', async () => {
      const h = await create(), before = await h.read();
      const { invoiceId, attemptId, paymentIntentId } = h.success;
      const result = await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'canceled' });
      expect(result).toMatchObject({ outcome: 'applied', invoice: { status: before.invoice } });
      expect(await h.read()).toEqual({ ...before, attempt: { status: 'failed', declineCode: 'confirm_abandoned' } });
      expect((await h.transitions.cardSucceeded(h.context, h.success)).outcome).toBe('ignored');
      expect((await h.read()).invoice).toBe(before.invoice);
    });
    it('keeps the cancellation of an action-needed attempt a decline with dunning', async () => {
      const h = await create();
      const { invoiceId, attemptId, paymentIntentId } = h.success;
      await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'requires_action' });
      const result = await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'canceled' });
      expect(result).toMatchObject({ outcome: 'applied', invoice: { status: 'past_due' } });
      const after = await h.read();
      expect(after.attempt).toEqual({ status: 'failed', declineCode: 'intent_canceled' });
      expect(count(after.effects, 'dunning')).toBe(2);
      expect((await h.transitions.cardSucceeded(h.context, h.success)).outcome).toBe('ignored');
    });
    it('reverses a processor refund that fails after success, recomputing the invoice and notifying staff', async () => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const part = Math.floor(amountCents * 0.4);
      const first: RefundTransition = { invoiceId, paymentId, refundId: randomUUID(), processorId: 're_contract_1',
        amountCents: part, currency, status: 'succeeded' };
      const second: RefundTransition = { ...first, refundId: randomUUID(), processorId: 're_contract_2', amountCents: amountCents - part };
      const status = async (request: RefundTransition) => (await h.transitions.refund(h.context, request)).invoice.status;
      expect(await status(first)).toBe('partially_refunded');
      expect(await status(second)).toBe('refunded');
      expect(count((await h.read()).effects, 'staff_notice')).toBe(0);
      expect(await status({ ...second, status: 'failed' })).toBe('partially_refunded');
      expect(count((await h.read()).effects, 'staff_notice')).toBe(1);
      // A failed refund never moves again.
      expect((await h.transitions.refund(h.context, second)).outcome).toBe('ignored');
      expect(await status({ ...first, status: 'failed' })).toBe('paid');
      const after = await h.read();
      expect(after.invoice).toBe('paid');
      expect(count(after.effects, 'staff_notice')).toBe(2);
    });
    it('notifies staff once for a processor refund first recorded failed, or failed after pending', async () => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const notices = async () => count((await h.read()).effects, 'staff_notice');
      const failed: RefundTransition = { invoiceId, paymentId, refundId: randomUUID(), processorId: 're_contract_3',
        amountCents, currency, status: 'failed' };
      expect((await h.transitions.refund(h.context, failed)).invoice.status).toBe('paid');
      expect(await notices()).toBe(1);
      expect((await h.transitions.refund(h.context, failed)).outcome).toBe('ignored');
      const pending: RefundTransition = { ...failed, refundId: randomUUID(), processorId: 're_contract_4', status: 'pending' };
      await h.transitions.refund(h.context, pending);
      expect(await notices()).toBe(1);
      expect((await h.transitions.refund(h.context, { ...pending, status: 'failed' })).invoice.status).toBe('paid');
      expect((await h.transitions.refund(h.context, { ...pending, status: 'failed' })).outcome).toBe('ignored');
      expect(await notices()).toBe(2);
      expect((await h.read()).invoice).toBe('paid');
    });
    it('never reverses a refund without a processor ID', async () => {
      const h = await create();
      await h.transitions.manualPayment(h.context, h.manual);
      const cash: RefundTransition = { invoiceId: h.manual.invoiceId, paymentId: h.manual.paymentId, refundId: randomUUID(),
        amountCents: Math.floor(h.manual.amountCents / 2), currency: h.manual.currency, status: 'succeeded' };
      expect((await h.transitions.refund(h.context, cash)).invoice.status).toBe('partially_refunded');
      expect((await h.transitions.refund(h.context, { ...cash, status: 'failed' })).outcome).toBe('ignored');
      const after = await h.read();
      expect(after.invoice).toBe('partially_refunded');
      expect(count(after.effects, 'staff_notice')).toBe(0);
    });
  });
}
