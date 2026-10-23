// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { paymentsContract } from '../../core/registry-infra-contracts.js';
import type { Payments, CreateCharge, CheckoutRequest } from './index.js';
export type Card = '4242' | '0341' | '3155' | '3184';
export interface ContractHarness {
  payments: Payments; charge: CreateCharge; checkout: CheckoutRequest;
  since?: Date;
  completeCheckout?: (id: string) => void;
}
/** Both provider implementations and the opt-in test-API run use these exact scenarios. */
export function fullPaymentsContract(name: string, create: (card?: Card) => Promise<ContractHarness>) {
  paymentsContract(name, create);
  describe(name + ' extended', () => {
    it.each([['4242', 'succeeded'], ['0341', 'failed'], ['3155', 'succeeded'], ['3184', 'action_required']] as const)(
      'normalizes card %s after the setup fixture', async (card, status) => {
        const { payments, charge } = await create(card), intent = await payments.createCharge(charge);
        expect(await payments.confirmCharge(intent.id, { idempotencyKey: charge.idempotencyKey + ':confirm' })).toMatchObject({ status });
        expect(await payments.findCharge({ kind: 'charge', id: intent.id })).toMatchObject({ status });
      });
    it('rejects reuse with changed immutable parameters', async () => {
      const { payments, charge } = await create(); await payments.createCharge(charge);
      await expect(payments.createCharge({ ...charge, amount: charge.amount + 1 })).rejects.toThrow();
    });
    it('cancels an unconfirmed charge without charging', async () => {
      const { payments, charge } = await create(), intent = await payments.createCharge(charge);
      expect(await payments.cancelCharge(intent.id)).toMatchObject({ status: 'failed', code: 'canceled' });
      expect(await payments.findCharge({ kind: 'charge', id: intent.id })).toMatchObject({ status: 'failed', code: 'canceled' });
    });
    it('refunds idempotently and retrieves the refund through its payment', async () => {
      const { payments, charge } = await create(), intent = await payments.createCharge(charge);
      await payments.confirmCharge(intent.id, { idempotencyKey: charge.idempotencyKey + ':confirm' });
      const request = { chargeId: intent.id, amount: charge.amount, idempotencyKey: charge.idempotencyKey + ':refund' };
      const refund = await payments.refund(request);
      expect(refund).toMatchObject({ chargeId: intent.id, status: 'succeeded', amount: charge.amount });
      expect(await payments.refund(request)).toEqual(refund);
      expect(await payments.readPaymentObject({ kind: 'refund', id: refund.id })).toEqual({ status: 'found', value: { kind: 'refund', object: refund } });
    });
    it('creates and expires setup mode; an unresolved expiry is uncertain', async () => {
      const { payments, checkout } = await create();
      const session = await payments.createCheckout({ ...checkout, mode: 'setup' });
      expect(session.mode).toBe('setup');
      expect(await payments.expireCheckout(session.id)).toEqual({ status: 'expired' });
      expect(await payments.expireCheckout('cs_missing')).toEqual({ status: 'uncertain' });
    });
    it('pages through changes and re-fetches the current charge state', async () => {
      const { payments, charge, since = new Date() } = await create();
      // Overlap covers Stripe second precision. The production reconciler supplies its snapshot overlap.
      since.setUTCSeconds(since.getUTCSeconds() - 5);
      const intent = await payments.createCharge(charge);
      await payments.confirmCharge(intent.id, { idempotencyKey: charge.idempotencyKey + ':confirm' });
      let cursor: string | undefined, found = false, pages = 0;
      do {
        const page = await payments.listChangesSince(since, { limit: 1, ...(cursor ? { cursor } : {}) });
        found ||= page.changes.some((change) => change.kind === 'charge' && change.object.status === 'succeeded' && change.object.id === intent.id);
        cursor = page.nextCursor ?? undefined;
        if (++pages > 500) throw new Error('Pagination did not terminate');
      } while (cursor);
      expect(found).toBe(true);
    });
  });
}
