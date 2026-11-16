// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MutationContext } from './common.js';
import type { CardSuccess, InvoiceEffect, InvoiceFixture, InvoiceTransitions, ManualPayment, RefundTransition } from './invoice-transitions.js';

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
export function invoiceTransitionsContract(name: string, create: (options?: { packSale?: boolean;
  checkout?: Pick<InvoiceFixture, 'checkoutSessionId' | 'checkoutExpiresAt'> }) => Promise<InvoiceTransitionsHarness>) {
  describe(name + ': cancellations and refund reversals', () => {
    const count = (effects: readonly string[], kind: InvoiceEffect['kind']) => effects.filter((effect) => effect === kind).length;
    it('refuses an unresolved attempt, then voids a failed invoice and refunds a late success once', async () => {
      const h = await create(), { invoiceId, attemptId, paymentIntentId } = h.success;
      const request = { invoiceId, reason: 'Invoice issued in error' };
      await expect(h.transitions.voidInvoice(h.context, request)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['pending_attempt'] } });
      await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'requires_action' });
      await expect(h.transitions.voidInvoice(h.context, request)).rejects.toMatchObject({ code: 'conflict', details: { reason: ['action_required'] } });
      await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'canceled' });
      expect((await h.transitions.voidInvoice(h.context, request)).invoice.status).toBe('void');
      expect((await h.transitions.voidInvoice(h.context, request)).outcome).toBe('ignored');
      await expect(h.transitions.manualPayment(h.context, h.manual)).rejects.toMatchObject({ code: 'conflict' });
      expect((await h.transitions.cardSucceeded(h.context, h.success)).outcome).toBe('duplicate_payment');
      expect((await h.transitions.cardSucceeded(h.context, h.success)).outcome).toBe('ignored');
      const after = await h.read();
      expect(after.invoice).toBe('void');
      expect(count(after.effects, 'refund_duplicate')).toBe(1);
      expect(count(after.effects, 'staff_notice')).toBe(1);
      expect(count(after.effects, 'activate_memberships')).toBe(0);
    });
    it.each([
      { checkoutSessionId: 'cs_reserved' },
      { checkoutExpiresAt: '2100-01-01T00:00:00Z' },
      { checkoutSessionId: 'cs_old', checkoutExpiresAt: '2000-01-01T00:00:00Z' },
    ])('refuses a reserved Checkout: %j', async checkout => {
      const h = await create({ checkout });
      await h.transitions.cardFailed(h.context, { invoiceId: h.success.invoiceId, attemptId: h.success.attemptId,
        paymentIntentId: h.success.paymentIntentId, outcome: 'failed' });
      const before = await h.read();
      await expect(h.transitions.voidInvoice(h.context, { invoiceId: h.success.invoiceId, reason: 'Wrong invoice' }))
        .rejects.toMatchObject({ code: 'conflict', details: { reason: ['checkout_reserved'] } });
      expect(await h.read()).toEqual(before);
    });
    it.each(['failed', 'requires_action', 'canceled'] as const)('ignores %s on a void invoice before changing the attempt', async outcome => {
      const h = await create(), { invoiceId, attemptId, paymentIntentId } = h.success;
      await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome: 'failed' });
      await h.transitions.voidInvoice(h.context, { invoiceId, reason: 'Wrong invoice' });
      const before = await h.read();
      expect((await h.transitions.cardFailed(h.context, { invoiceId, attemptId, paymentIntentId, outcome })).outcome).toBe('ignored');
      expect(await h.read()).toEqual(before);
    });
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
    it.each([false, true])('reverses a processor refund that fails after success, with pack sale: %s', async packSale => {
      const h = await create({ packSale });
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const part = Math.floor(amountCents * 0.4);
      const first: RefundTransition = { invoiceId, paymentId, refundId: randomUUID(), processorId: 're_contract_1',
        amountCents: part, currency, status: 'succeeded' };
      const second: RefundTransition = { ...first, refundId: randomUUID(), processorId: 're_contract_2', amountCents: amountCents - part };
      const status = async (request: RefundTransition) => (await h.transitions.refund(h.context, request)).invoice.status;
      expect(await status(first)).toBe('partially_refunded');
      expect(count((await h.read()).effects, 'reverse_credits')).toBe(0);
      expect(await status(second)).toBe('refunded');
      expect(count((await h.read()).effects, 'reverse_credits')).toBe(packSale ? 1 : 0);
      await status(second);
      expect(count((await h.read()).effects, 'reverse_credits')).toBe(packSale ? 1 : 0);
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
    it('records an external canceled refund as final and released, without notifying staff', async () => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const notices = async () => count((await h.read()).effects, 'staff_notice');
      // Cancelled before the app saw it, and cancelled while pending: each releases the whole amount.
      const first: RefundTransition = { invoiceId, paymentId, refundId: randomUUID(), processorId: 're_contract_5',
        amountCents, currency, status: 'canceled' };
      expect(await h.transitions.refund(h.context, first)).toMatchObject({ outcome: 'applied', invoice: { status: 'paid' } });
      const pending: RefundTransition = { ...first, refundId: randomUUID(), processorId: 're_contract_6', status: 'pending' };
      await h.transitions.refund(h.context, pending);
      expect(await h.transitions.refund(h.context, { ...pending, status: 'canceled' }))
        .toMatchObject({ outcome: 'applied', invoice: { status: 'paid' } });
      // Canceled never moves again.
      for (const status of ['canceled', 'failed', 'succeeded', 'pending'] as const)
        expect((await h.transitions.refund(h.context, { ...pending, status })).outcome).toBe('ignored');
      expect(await notices()).toBe(0);
      // Only the processor cancels a refund, so a cash or check refund can't be recorded canceled.
      await expect(h.transitions.refund(h.context, { invoiceId, paymentId, refundId: randomUUID(), amountCents, currency, status: 'canceled' }))
        .rejects.toMatchObject({ code: 'conflict' });
      // A processor never cancels a refund that succeeded, so such a report leaves the invoice refunded.
      const refunded: RefundTransition = { ...first, refundId: randomUUID(), processorId: 're_contract_7', status: 'succeeded' };
      expect((await h.transitions.refund(h.context, refunded)).invoice.status).toBe('refunded');
      expect((await h.transitions.refund(h.context, { ...refunded, status: 'canceled' })).outcome).toBe('ignored');
      const after = await h.read();
      expect(after.invoice).toBe('refunded');
      expect(count(after.effects, 'staff_notice')).toBe(0);
    });
    it.each(['pending', 'succeeded', 'failed', 'canceled'] as const)('adds the processor ID to a reserved refund reported %s', async status => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const reserved: RefundTransition = { invoiceId, paymentId, amountCents, currency, refundId: randomUUID(), status: 'pending' };
      expect((await h.transitions.refund(h.context, reserved)).outcome).toBe('applied');
      const report = { ...reserved, processorId: 're_contract_reserved', status };
      expect(await h.transitions.refund(h.context, report)).toMatchObject({ outcome: 'applied',
        invoice: { status: status === 'succeeded' ? 'refunded' : 'paid' } });
      expect((await h.transitions.refund(h.context, report)).outcome).toBe('ignored');
      await expect(h.transitions.refund(h.context, { ...report, processorId: 're_different' })).rejects.toMatchObject({ code: 'conflict' });
      await expect(h.transitions.refund(h.context, { ...report, amountCents: amountCents - 1 })).rejects.toMatchObject({ code: 'conflict' });
      expect(count((await h.read()).effects, 'staff_notice')).toBe(status === 'failed' || status === 'canceled' ? 1 : 0);
    });
    it('remembers an app reservation after linking a pending processor refund, and notifies once on cancellation', async () => {
      const h = await create();
      await h.transitions.cardSucceeded(h.context, h.success);
      const { invoiceId, paymentId, amountCents, currency } = h.success;
      const reservation: RefundTransition = { invoiceId, paymentId, amountCents, currency, refundId: randomUUID(), status: 'pending' };
      await h.transitions.refund(h.context, reservation);
      const linked = { ...reservation, processorId: 're_contract_app_pending' };
      await h.transitions.refund(h.context, linked);
      const canceled = { ...linked, status: 'canceled' as const };
      await h.transitions.refund(h.context, canceled);
      await h.transitions.refund(h.context, canceled);
      expect(count((await h.read()).effects, 'staff_notice')).toBe(1);
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
