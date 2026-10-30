// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { paymentsContract } from '../../core/registry-infra-contracts.js';
import type { Payments, CreateCharge, CheckoutRequest } from './index.js';
export type Card = '4242' | '0341' | '3155' | '3184';
export interface ContractHarness {
  payments: Payments; charge: CreateCharge; checkout: CheckoutRequest;
  detach: { owned: string; foreign: string };
  since?: Date;
  completeCheckout?: (id: string) => void;
}
/** Both provider implementations and the opt-in test-API run use these exact scenarios. */
export function fullPaymentsContract(name: string, create: (card?: Card) => Promise<ContractHarness>) {
  paymentsContract(name, create);
  describe(name + ' extended', () => {
    it('reads the card brand from an owned payment method', async () => {
      const { payments, detach } = await create();
      expect(await payments.readPaymentObject({ kind: 'payment_method', id: detach.owned }))
        .toMatchObject({ status: 'found', value: { kind: 'payment_method', object: { brand: 'visa' } } });
    });
    it('requires a customer ID for Checkout without creating a customer from email', async () => {
      const { payments, checkout } = await create();
      await expect(payments.createCheckout({ ...checkout, customerId: undefined } as unknown as CheckoutRequest)).rejects.toThrow();
    });
    it.each(['payment', 'setup'] as const)('preserves the signed link ID on %s Checkout and its intent', async mode => {
      const { payments, checkout, charge, completeCheckout } = await create();
      const linkId = charge.invoiceId;
      const request = { ...checkout, mode, linkId };
      const session = await payments.createCheckout(request);
      expect(session.metadata).toMatchObject({ linkId });
      expect(await payments.createCheckout(request)).toEqual(session);
      await expect(payments.createCheckout({ ...request, linkId: 'another-link' })).rejects.toThrow();
      completeCheckout?.(session.id);
      const found = await payments.readPaymentObject({ kind: 'checkout', id: session.id });
      expect(found).toMatchObject({ status: 'found', value: { kind: 'checkout', object: { metadata: { linkId } } } });
      if (found.status !== 'found' || found.value.kind !== 'checkout') throw new Error('Checkout missing');
      const completed = found.value.object;
      const intentId = mode === 'payment' ? completed.chargeId : completed.setupId;
      // A real Checkout may create its intent only after the customer submits the hosted page.
      if (!intentId) { expect(completed.status).toBe('open'); return; }
      const reference = { kind: mode === 'payment' ? 'charge' as const : 'setup' as const, id: intentId };
      expect(await payments.readPaymentObject(reference)).toMatchObject({ status: 'found', value: { object: { metadata: { linkId } } } });
    });
    it('creates one owned customer per key and rejects changed details', async () => {
      const { payments, charge, checkout } = await create();
      const request = { email: 'new-payer@example.invalid', name: 'New Household', householdId: charge.invoiceId,
        idempotencyKey: charge.idempotencyKey + ':customer' };
      const customer = await payments.createCustomer(request);
      expect(customer).toEqual({ id: expect.stringMatching(/^cus_/), email: request.email });
      expect(await payments.createCustomer(request)).toEqual(customer);
      await expect(payments.createCustomer({ ...request, name: 'Changed Household' })).rejects.toThrow();
      expect(await payments.findCustomerByEmail(request.email)).toContainEqual(customer);
      expect(await payments.adoptCustomer(customer.id)).toEqual(customer);
      expect(await payments.createCheckout({ mode: 'setup', customerId: customer.id,
        successUrl: checkout.successUrl, cancelUrl: checkout.cancelUrl, saveForOffSession: true,
        idempotencyKey: request.idempotencyKey + ':setup' })).toMatchObject({ customerId: customer.id, mode: 'setup' });
    });
    it('detaches a card idempotently, accepts unknown IDs, and refuses another gym', async () => {
      const { payments, detach } = await create();
      await expect(payments.detachPaymentMethod(detach.foreign)).rejects.toThrow();
      await expect(payments.detachPaymentMethod(detach.owned)).resolves.toBeUndefined();
      await expect(payments.detachPaymentMethod(detach.owned)).resolves.toBeUndefined();
      await expect(payments.detachPaymentMethod('pm_missing')).resolves.toBeUndefined();
      expect(await payments.readPaymentObject({ kind: 'payment_method', id: detach.owned })).toEqual({ status: 'unknown', reference: { kind: 'payment_method', id: detach.owned } });
    });
    it('redacts an erased customer idempotently, keeps it, and accepts unknown IDs', async () => {
      const { payments, charge } = await create();
      const request = { email: 'erased-payer@example.invalid', name: 'Erased Household', householdId: charge.invoiceId,
        idempotencyKey: charge.idempotencyKey + ':erased-customer' };
      const customer = await payments.createCustomer(request);
      await expect(payments.redactCustomer(customer.id)).resolves.toBeUndefined();
      await expect(payments.redactCustomer(customer.id)).resolves.toBeUndefined();
      expect(await payments.findCustomerByEmail(request.email)).not.toContainEqual(customer);
      expect(await payments.adoptCustomer(customer.id)).toEqual({ id: customer.id, email: null });
      await expect(payments.redactCustomer('cus_missing')).resolves.toBeUndefined();
    });
    it.each([['4242', 'succeeded'], ['0341', 'failed'], ['3155', 'succeeded'], ['3184', 'action_required']] as const)(
      'normalizes card %s after the setup fixture', async (card, status) => {
        const { payments, charge } = await create(card), intent = await payments.createCharge(charge);
        // A success names the processor's charge as well as the intent; invoice transitions need both.
        const charged = status === 'succeeded' ? { latestChargeId: expect.stringMatching(/^ch_/) } : {};
        expect(await payments.confirmCharge(intent.id, { idempotencyKey: charge.idempotencyKey + ':confirm' })).toMatchObject({ status, ...charged });
        expect(await payments.findCharge({ kind: 'charge', id: intent.id })).toMatchObject({ status, ...charged });
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
      expect(session.savesCard).toBe(true);
      expect(await payments.expireCheckout(session.id)).toEqual({ status: 'expired' });
      expect(await payments.expireCheckout('cs_missing')).toEqual({ status: 'uncertain' });
    });
    it('lists only the refunds of the requested payment intent', async () => {
      const { payments, charge } = await create(), first = await payments.createCharge(charge);
      await payments.confirmCharge(first.id, { idempotencyKey: charge.idempotencyKey + ':confirm' });
      const other = await payments.createCharge({ ...charge, idempotencyKey: charge.idempotencyKey + ':other' });
      await payments.confirmCharge(other.id, { idempotencyKey: charge.idempotencyKey + ':other:confirm' });
      expect(await payments.listRefunds(first.id)).toEqual([]);
      const refund = await payments.refund({ chargeId: first.id, amount: charge.amount, idempotencyKey: charge.idempotencyKey + ':refund' });
      await payments.refund({ chargeId: other.id, amount: charge.amount, idempotencyKey: charge.idempotencyKey + ':other:refund' });
      expect(await payments.listRefunds(first.id)).toEqual([refund]);
      expect(await payments.listRefunds(first.id)).toEqual([refund]);
      await expect(payments.listRefunds('pi_missing')).rejects.toThrow();
    });
    it('reads the provider success time on demand and retains it across repeated lookups', async () => {
      const { payments, charge } = await create(), intent = await payments.createCharge(charge);
      await payments.confirmCharge(intent.id, { idempotencyKey: charge.idempotencyKey + ':confirm' });
      const outcome = await payments.findCharge({ kind: 'charge', id: intent.id }, { includeSuccessTime: true });
      expect(outcome).toMatchObject({ status: 'succeeded', succeededAt: expect.any(Date) });
      expect(await payments.findCharge({ kind: 'charge', id: intent.id }, { includeSuccessTime: true })).toEqual(outcome);
    });
    it.each([true, false])('reports whether payment Checkout saves the card: %s', async saveForOffSession => {
      const { payments, checkout } = await create();
      expect(await payments.createCheckout({ ...checkout, saveForOffSession })).toMatchObject({ savesCard: saveForOffSession });
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
