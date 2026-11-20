// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { paymentsContract } from '../../core/registry-infra-contracts.js';
import type { Payments, CreateCharge, CheckoutRequest, CustomerCardPage, PaymentMethodType } from './index.js';
import type { ClearCustomerEmail } from './email-erasure.js';
import { runInTransaction } from '@plaingym/shared/transaction';

interface CustomerCardsFixture {
  payments: Payments; customerId: string; householdId: string;
}
/** The provider and fake list only the linked, gym-tagged customer's attached cards, in bounded replayable pages. */
export function customerCardsContract(name: string, create: (options?: { gymId?: string; householdId?: string; deleted?: boolean }) => CustomerCardsFixture) {
  describe(name + ' customer card listing', () => {
    it('pages through more than 100 cards without mixing customers or detached cards, and safely repeats a page', async () => {
      const { payments, customerId, householdId } = create();
      const first = await payments.listCustomerCards(customerId, { householdId, limit: 100 });
      expect(first.cards).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
      expect(await payments.listCustomerCards(customerId, { householdId, limit: 100 })).toEqual(first);
      const last = await payments.listCustomerCards(customerId, { householdId, cursor: first.nextCursor!, limit: 100 });
      expect(last.cards).toHaveLength(2); expect(last.nextCursor).toBeNull();
      const cards = [...first.cards, ...last.cards];
      expect(new Set(cards.map(card => card.id)).size).toBe(102);
      expect(cards.every(card => card.customerId === customerId && card.createdAt instanceof Date)).toBe(true);
      expect(cards.some(card => card.id === 'pm_foreign' || card.id === 'pm_detached')).toBe(false);
    });
    it.each([{ gymId: 'other-gym' }, { gymId: '' }, { householdId: 'other-household' }, { deleted: true }])('refuses customer ownership %j', async fixture => {
      const { payments, customerId, householdId } = create(fixture);
      await expect(payments.listCustomerCards(customerId, { householdId })).rejects.toThrow('not owned');
    });
    it('refuses transaction I/O, unsafe IDs and unbounded pages', async () => {
      const { payments, customerId, householdId } = create();
      await runInTransaction(async () => { await expect(payments.listCustomerCards(customerId, { householdId })).rejects.toThrow('transaction'); });
      await expect(payments.listCustomerCards('../customer', { householdId })).rejects.toThrow('Invalid processor ID');
      await expect(payments.listCustomerCards(customerId, { householdId, cursor: '../card' })).rejects.toThrow('Invalid processor ID');
      for (const limit of [0, 101, 1.5]) await expect(payments.listCustomerCards(customerId, { householdId, limit })).rejects.toThrow('page size');
    });
  });
}

export interface EmailErasureFixture {
  customerEmail?: string;
  cardEmail?: string;
  gymId?: string;
  householdId?: string;
  cardCustomerId?: string;
  deleted?: boolean;
}
/** Shared checks for the narrow erasure operation, including provider state rather than just successful calls. */
export function customerEmailErasureContract(name: string, create: (fixture?: EmailErasureFixture) => {
  payments: Payments; customerId: string; options: ClearCustomerEmail;
  state(): { email: string | null; name: string | null; cardEmail: string | null; cardName: string | null; attached: boolean };
}) {
  describe(name + ' billing email erasure', () => {
    it('clears matching emails once, preserving names and the attached card', async () => {
      const { payments, customerId, options, state } = create({ customerEmail: ' PAYER@Example.invalid ' });
      expect(await payments.clearCustomerEmail(customerId, options)).toBe(true);
      expect(await payments.clearCustomerEmail(customerId, options)).toBe(false);
      expect(state()).toEqual({ email: null, name: 'Household', cardEmail: null, cardName: 'Card holder', attached: true });
    });
    it.each([
      { customerEmail: 'replacement@example.invalid', cardEmail: 'replacement@example.invalid' },
      { customerEmail: 'payer@example.invalid', cardEmail: 'replacement@example.invalid' },
      { customerEmail: 'replacement@example.invalid', cardEmail: 'payer@example.invalid' },
    ])('clears each field only if its address still matches: %j', async fixture => {
      const { payments, customerId, options, state } = create(fixture);
      expect(await payments.clearCustomerEmail(customerId, options)).toBe(fixture.customerEmail === 'payer@example.invalid' || fixture.cardEmail === 'payer@example.invalid');
      expect(state()).toMatchObject({ email: fixture.customerEmail === 'payer@example.invalid' ? null : fixture.customerEmail,
        cardEmail: fixture.cardEmail === 'payer@example.invalid' ? null : fixture.cardEmail });
    });
    it.each([{ gymId: 'other-gym' }, { householdId: 'other-household' }, { cardCustomerId: 'cus_other' }])('refuses foreign ownership before writing: %j', async fixture => {
      const { payments, customerId, options, state } = create(fixture), before = state();
      await expect(payments.clearCustomerEmail(customerId, options)).rejects.toThrow(/another/);
      expect(state()).toEqual(before);
    });
    it('accepts missing or deleted customers and missing cards, and clears a customer without a card', async () => {
      const { payments, customerId, options, state } = create();
      await payments.clearCustomerEmail('cus_missing', options);
      await payments.clearCustomerEmail(customerId, { ...options, paymentMethodId: 'pm_missing' });
      expect(state()).toMatchObject({ email: null, cardEmail: 'payer@example.invalid', attached: true });
      const deleted = create({ deleted: true });
      await deleted.payments.clearCustomerEmail(deleted.customerId, deleted.options);
      expect(deleted.state()).toMatchObject({ email: 'payer@example.invalid' });
      const noCard = create();
      await noCard.payments.clearCustomerEmail(noCard.customerId, { ...noCard.options, paymentMethodId: undefined, paymentMethodIds: [] });
      expect(noCard.state()).toMatchObject({ email: null, cardEmail: 'payer@example.invalid' });
    });
    it('rejects network work inside a transaction and invalid processor IDs', async () => {
      const { payments, customerId, options } = create();
      await runInTransaction(async () => { await expect(payments.clearCustomerEmail(customerId, options)).rejects.toThrow('transaction'); });
      await expect(payments.clearCustomerEmail('../cus_bad', options)).rejects.toThrow('Invalid processor ID');
      await expect(payments.clearCustomerEmail(customerId, { ...options, paymentMethodId: '../pm_bad' })).rejects.toThrow('Invalid processor ID');
    });
  });
}
/** Provider and fake must erase cards the application has never stored, while keeping them attached. */
interface CustomerCardRedactionFixture {
  payments: Payments; customerId: string;
  cards(): { id: string; type: string; attached: boolean; details: { name?: string | null; email?: string | null; phone?: string | null; address?: unknown } }[];
}
export function customerCardRedactionContract(name: string, create: () => CustomerCardRedactionFixture | Promise<CustomerCardRedactionFixture>) {
  describe(name + ' attached card redaction', () => {
    it('clears every method type, skips foreign gym methods and preserves attachments, including on retry', async () => {
      const { payments, customerId, cards } = await create(), before = cards();
      await payments.redactCustomer(customerId);
      await payments.redactCustomer(customerId);
      const after = cards();
      expect(after.map(card => ({ id: card.id, attached: card.attached }))).toEqual(before.map(card => ({ id: card.id, attached: card.attached })));
      expect(after).toHaveLength(105);
      expect(after.slice(0, 102).some(card => card.type === 'us_bank_account')).toBe(true);
      for (const card of after.slice(0, 102)) {
        expect(Object.values(card.details).every(value => value == null)).toBe(true);
        expect(card.attached).toBe(true);
        if (card.type === 'card') expect(await payments.readPaymentObject({ kind: 'payment_method', id: card.id })).toMatchObject({ status: 'found' });
      }
      expect(after.slice(102)).toEqual(before.slice(102));
    });
  });
}
export type Card = '4242' | '0341' | '3155' | '3184';
export function bankDebitContract(name: string, create: () => {
  payments: Payments; charge: CreateCharge; checkout: CheckoutRequest;
  completeCheckout(id: string, options: { method: PaymentMethodType }): void;
}) {
  describe(name + ' bank debit', () => {
    it.each([['us_bank_account', 'pm_usbank_6789'], ['acss_debit', 'pm_acss_6789']] as const)(
      'reads and confirms an attached %s', async (type, id) => {
        const { payments, charge } = create();
        expect(await payments.readPaymentObject({ kind: 'payment_method', id })).toMatchObject({
          status: 'found', value: { kind: 'payment_method', object: { id, type, customerId: charge.customerId, last4: '6789', bankName: 'STRIPE TEST BANK' } } });
        const intent = await payments.createCharge({ ...charge, currency: type === 'acss_debit' ? 'cad' : 'usd', paymentMethodId: id,
          ...(type === 'acss_debit' ? { mandateId: 'mandate_setup' } : {}) });
        expect(await payments.confirmCharge(intent.id, { idempotencyKey: 'confirm' })).toMatchObject({ id: intent.id, status: 'pending' });
      });
    it('lists cards by default and includes only requested kinds across bounded mixed pages', async () => {
      const { payments, charge: { customerId } } = create();
      expect((await payments.listCustomerCards(customerId)).cards.map(method => method.type)).toEqual(['card']);
      const types = ['card', 'us_bank_account'] as const, found: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page++) {
        const result: CustomerCardPage = await payments.listCustomerCards(customerId, { types, limit: 1, ...(cursor ? { cursor } : {}) });
        found.push(...result.cards.map(method => method.id));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(found.sort()).toEqual(['pm_3155', 'pm_usbank_6789']);
      expect(await payments.listCustomerCards(customerId, { types: [] })).toEqual({ cards: [], nextCursor: null });
    });
    it.each(['card', 'us_bank_account', 'acss_debit'] as const)('reports payment status and bank mandates after %s Checkout', async method => {
      const { payments, checkout, completeCheckout } = create();
      const bankDebit = method === 'acss_debit' ? { type: method, intervalDescription: 'Monthly dues and occasional fees' } : { type: 'us_bank_account' as const };
      for (const mode of ['payment', 'setup'] as const) {
        const session = await payments.createCheckout({ ...checkout, mode, bankDebit, currency: method === 'acss_debit' ? 'cad' : 'usd', idempotencyKey: mode });
        completeCheckout(session.id, { method });
        const read = await payments.readPaymentObject({ kind: 'checkout', id: session.id });
        if (read.status !== 'found' || read.value.kind !== 'checkout') throw new Error('Checkout missing');
        const completed = read.value.object;
        expect(completed).toMatchObject({ status: 'complete', savesCard: true,
          paymentStatus: mode === 'setup' ? 'no_payment_required' : method === 'card' ? 'paid' : 'unpaid' });
        if (mode === 'payment') {
          expect(await payments.findCharge({ kind: 'charge', id: completed.chargeId! })).toMatchObject({ status: method === 'card' ? 'succeeded' : 'pending' });
          if (method !== 'card') expect(completed.mandateId).toMatch(/^mandate_/);
        } else if (method !== 'card') {
          expect(await payments.readPaymentObject({ kind: 'setup', id: completed.setupId! })).toMatchObject({
            status: 'found', value: { kind: 'setup', object: { mandateId: expect.stringMatching(/^mandate_/) } } });
        }
      }
    });
  });
}
export interface ContractHarness {
  payments: Payments; charge: CreateCharge; checkout: CheckoutRequest;
  detach: { owned: string; foreign: string };
  since?: Date;
  completeCheckout?: (id: string) => void;
  /** Holds the next refund pending, then cancels it at the processor, as staff can in its dashboard; absent where the
   * provider can't (card refunds in a live test account complete at once). A replayed recording passes no-ops. */
  refundCancel?: { holdNext(): void; cancel(id: string): void };
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
      expect(await payments.findCustomerByEmail(request.email)).toContainEqual({ ...customer, householdId: request.householdId });
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
    it('detaches a card for an erasure with its billing details cleared first, idempotently', async () => {
      const { payments, detach } = await create();
      await expect(payments.detachPaymentMethod(detach.foreign, { redactBillingDetails: true })).rejects.toThrow();
      await expect(payments.detachPaymentMethod(detach.owned, { redactBillingDetails: true })).resolves.toBeUndefined();
      await expect(payments.detachPaymentMethod(detach.owned, { redactBillingDetails: true })).resolves.toBeUndefined();
      expect(await payments.readPaymentObject({ kind: 'payment_method', id: detach.owned })).toEqual({ status: 'unknown', reference: { kind: 'payment_method', id: detach.owned } });
    });
    it('redacts an erased customer idempotently, keeps it, and accepts unknown IDs', async () => {
      const { payments, charge } = await create();
      const request = { email: 'erased-payer@example.invalid', name: 'Erased Household', householdId: charge.invoiceId,
        idempotencyKey: charge.idempotencyKey + ':erased-customer' };
      const customer = await payments.createCustomer(request);
      await expect(payments.redactCustomer(customer.id)).resolves.toBeUndefined();
      await expect(payments.redactCustomer(customer.id)).resolves.toBeUndefined();
      expect(await payments.findCustomerByEmail(request.email)).not.toContainEqual(expect.objectContaining({ id: customer.id }));
      expect(await payments.adoptCustomer(customer.id)).toEqual({ id: customer.id, email: null });
      await expect(payments.redactCustomer('cus_missing')).resolves.toBeUndefined();
    });
    it.each([['4242', 'succeeded'], ['0341', 'failed'], ['3155', 'succeeded'], ['3184', 'action_required']] as const)(
      'normalizes card %s after the setup fixture', async (card, status) => {
        const { payments, charge } = await create(card), intent = await payments.createCharge(charge);
        // A success names the processor's charge as well as the intent; invoice transitions need both.
        const charged = status === 'succeeded' ? { latestChargeId: expect.stringMatching(/^ch_/) } : {};
        // A confirmed success also carries its success time, so recording the payment needs no further reads.
        expect(await payments.confirmCharge(intent.id, { idempotencyKey: charge.idempotencyKey + ':confirm' }))
          .toMatchObject({ status, ...charged, ...status === 'succeeded' ? { succeededAt: expect.any(Date) } : {} });
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
    it('reads a refund cancelled at the processor as canceled, not failed, and refunds its amount again', async ({ skip }) => {
      const { payments, charge, refundCancel } = await create();
      if (!refundCancel) return skip('This provider cannot cancel a refund');
      const intent = await payments.createCharge(charge);
      await payments.confirmCharge(intent.id, { idempotencyKey: charge.idempotencyKey + ':confirm' });
      refundCancel.holdNext();
      const refund = await payments.refund({ chargeId: intent.id, amount: charge.amount, idempotencyKey: charge.idempotencyKey + ':refund' });
      expect(refund).toMatchObject({ status: 'pending', amount: charge.amount });
      refundCancel.cancel(refund.id);
      const canceled = { ...refund, status: 'canceled' };
      expect(await payments.readPaymentObject({ kind: 'refund', id: refund.id })).toEqual({ status: 'found', value: { kind: 'refund', object: canceled } });
      expect(await payments.listRefunds(intent.id)).toEqual([canceled]);
      expect(await payments.refund({ chargeId: intent.id, amount: charge.amount, idempotencyKey: charge.idempotencyKey + ':refund:again' }))
        .toMatchObject({ status: 'succeeded', amount: charge.amount });
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
