// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import type { CreateCharge, PaymentEvent, Payments } from '../../../infra/payments/index.js';
import { normalizeChargeOutcome } from '../../../infra/payments/index.js';
import { calculateFirstPeriod, calculateOneOffInvoice } from '../invoicing/index.js';
import { billingFixture, invoiceDetail } from './fixture.js';

const db = useTestDatabase();
async function chargeFixture() {
  const f = await billingFixture(db);
  await f.assign(await f.plan());
  const detail = invoiceDetail((await f.cycle()).invoice, f.clock);
  const request: CreateCharge = { amount: detail.invoice.amountCents, currency: detail.invoice.currency.toLowerCase(),
    invoiceId: detail.invoice.id, attemptId: uuidv7(), customerId: f.customerId,
    paymentMethodId: 'pm_saved', idempotencyKey: detail.invoice.id + ':1:create' };
  const provider: Payments = f.payments;
  const created = await provider.createCharge(request);
  return { ...f, detail, request, provider, created, confirm: { idempotencyKey: detail.invoice.id + ':1:confirm' } };
}

describe('billing scenarios: calculated invoices → payment provider contract', () => {
  it('creates an unconfirmed charge and replays create/confirm without charging a family twice', async () => {
    const f = await chargeFixture();
    expect(await f.provider.findCharge({ kind: 'charge', id: f.created.id })).toMatchObject({ status: 'pending' });
    expect(await f.provider.createCharge(f.request)).toEqual(f.created);
    const paid = await f.provider.confirmCharge(f.created.id, f.confirm);
    expect(paid).toMatchObject({ status: 'succeeded', amount: 10_000, currency: 'cad', paymentMethodId: 'pm_saved',
      metadata: { gymId: f.gymId, invoiceId: f.detail.invoice.id, attemptId: f.request.attemptId } });
    expect(await f.provider.confirmCharge(f.created.id, f.confirm)).toEqual(paid);
    await expect(f.provider.createCharge({ ...f.request, amount: 20_000 })).rejects.toThrow('different parameters');
  });

  it.each([
    ['declined', 'failed'], ['authentication_required', 'action_required'],
  ] as const)('exposes %s for a calculated cycle without mutating the membership', async (response, status) => {
    const f = await chargeFixture();
    f.payments.respondNextConfirmation(response);
    expect(await f.provider.confirmCharge(f.created.id, f.confirm)).toMatchObject({ status });
    expect(invoiceDetail((await f.cycle()).invoice, f.clock).invoice.amountCents).toBe(10_000);
    // Invoice state and retry jobs are checked by the pending C1.6/C2.1 scenarios.
  });

  it.each([
    { name: 'requires_action', status: 'requires_action', error: undefined, last_payment_error: null },
    { name: 'last_payment_error on requires_payment_method', status: 'requires_payment_method', error: undefined,
      last_payment_error: { code: 'authentication_required' } },
    { name: 'thrown card error', status: 'requires_payment_method', error: { code: 'authentication_required' }, last_payment_error: null },
    { name: 'nested thrown card error', status: 'requires_payment_method', error: { raw: { payment_intent: {
      last_payment_error: { code: 'authentication_required' } } } }, last_payment_error: null },
  ])('normalizes SCA: $name, preserving invoice/attempt metadata', async ({ status, error, last_payment_error }) => {
    const f = await chargeFixture();
    const charge = await f.provider.findCharge({ kind: 'charge', id: f.created.id });
    if (charge.status === 'unknown') throw new Error('Scenario charge missing');
    expect(normalizeChargeOutcome({ ...charge, status, last_payment_error }, error)).toMatchObject({
      status: 'action_required', code: 'authentication_required', id: f.created.id,
      metadata: { invoiceId: f.detail.invoice.id, attemptId: f.request.attemptId },
    });
  });

  it('reconciles a lost confirmation by ID even after the provider idempotency window expires', async () => {
    const f = await chargeFixture();
    f.payments.loseNextResponse('confirmCharge');
    await expect(f.provider.confirmCharge(f.created.id, f.confirm)).rejects.toThrow('response lost');
    f.clock.set('2028-02-02T20:00:00Z');
    expect(await f.provider.findCharge({ kind: 'charge', id: f.created.id })).toMatchObject({ status: 'succeeded', amount: 10_000 });
    f.payments.setUncertain(f.created.id);
    expect(await f.provider.findCharge({ kind: 'charge', id: f.created.id })).toEqual({ status: 'unknown', reference: { kind: 'charge', id: f.created.id } });
    // A runner must leave this unresolved instead of creating another attempt (C2.1).
  });

  it('collects a pending sibling first period through Checkout and returns the explicit saved method', async () => {
    const f = await billingFixture(db, { billingDay: 1, now: '2028-03-16T19:00:00Z' });
    const membership = await f.assign(await f.plan({ amountCents: 3100 }), {
      startsOn: '2028-03-16', nextDueOn: '2028-04-01', initialStatus: 'pending', firstPeriod: 'prorate_now',
    });
    const calculation = calculateFirstPeriod({ ...await f.pricing(), ...await f.priced(membership.id), firstPeriod: 'prorate_now' });
    const detail = invoiceDetail(calculation.invoice, f.clock);
    const session = await f.payments.createCheckout({ mode: 'payment', customerId: f.customerId,
      invoiceId: detail.invoice.id, amount: detail.invoice.amountCents, currency: 'cad', saveForOffSession: true,
      successUrl: 'https://gym.example.invalid/paid', cancelUrl: 'https://gym.example.invalid/cancel', idempotencyKey: detail.invoice.id + ':checkout' });
    expect((await f.lifecycle.get(f.gymId, membership.id)).status).toBe('pending');
    expect(await f.payments.findCharge({ kind: 'checkout', id: session.id })).toMatchObject({ status: 'unknown' });
    const completed = f.payments.completeCheckout(session.id);
    expect(completed).toMatchObject({ status: 'complete', paymentMethodId: expect.stringMatching(/^pm_/) });
    expect(await f.payments.findCharge({ kind: 'checkout', id: session.id })).toMatchObject({ status: 'succeeded',
      amount: 1600, paymentMethodId: completed.paymentMethodId, metadata: { invoiceId: detail.invoice.id } });
    expect(await f.payments.expireCheckout(session.id)).toMatchObject({ status: 'already_completed' });
    // No pretend activation here: the webhook → transition → lifecycle path needs C1.6/C2.2.
    expect((await f.lifecycle.get(f.gymId, membership.id)).status).toBe('pending');
  });

  it('keeps setup-only Checkout separate from a first payment', async () => {
    const f = await billingFixture(db);
    const pending = await f.assign(await f.plan(), { initialStatus: 'pending' });
    const session = await f.payments.createCheckout({ mode: 'setup', customerId: f.customerId, saveForOffSession: true,
      successUrl: 'https://gym.example.invalid/saved', cancelUrl: 'https://gym.example.invalid/cancel', idempotencyKey: pending.id + ':setup' });
    const completed = f.payments.completeCheckout(session.id);
    expect(completed.chargeId).toBeUndefined();
    expect(completed.setupId).toMatch(/^seti_/);
    expect(await f.payments.findCharge({ kind: 'checkout', id: session.id })).toMatchObject({ status: 'unknown' });
    expect((await f.lifecycle.get(f.gymId, pending.id)).status).toBe('pending');
  });

  it('refunds a taxed catalog one-off partially and then fully, deduplicating a replay', async () => {
    const f = await billingFixture(db, { discount: 1000 });
    const tax = await f.catalog.createTaxRate(f.context, { name: 'Sales tax', rateMillionths: 50_000, inclusive: false });
    const type = await f.catalog.createChargeType(f.context, { name: 'Mat fee', amountCents: 2000, currency: 'CAD', taxRateIds: [tax.id] });
    const detail = invoiceDetail(calculateOneOffInvoice({ householdId: f.home.id, currency: type.currency, dueOn: '2028-01-31',
      charges: [{ kind: 'charge', chargeTypeId: type.id, description: type.name, amountCents: type.amountCents,
        currency: type.currency, taxRates: [await f.catalog.getTaxRate(f.gymId, tax.id)] }] }), f.clock);
    expect(detail.invoice).toMatchObject({ kind: 'one_off', amountCents: 2100 });
    const charge = await f.payments.createCharge({ amount: 2100, currency: 'cad', invoiceId: detail.invoice.id,
      attemptId: uuidv7(), customerId: f.customerId, paymentMethodId: 'pm_saved', idempotencyKey: detail.invoice.id + ':1:create' });
    await f.payments.confirmCharge(charge.id, { idempotencyKey: detail.invoice.id + ':1:confirm' });
    const request = { chargeId: charge.id, amount: 600, idempotencyKey: detail.invoice.id + ':refund:1' };
    const partial = await f.payments.refund(request);
    expect(partial).toMatchObject({ status: 'succeeded', amount: 600, currency: 'cad' });
    expect(await f.payments.refund(request)).toEqual(partial);
    expect(await f.payments.refund({ chargeId: charge.id, amount: 1500, idempotencyKey: detail.invoice.id + ':refund:2' })).toMatchObject({ status: 'succeeded', amount: 1500 });
    await expect(f.payments.refund({ chargeId: charge.id, amount: 1, idempotencyKey: detail.invoice.id + ':refund:3' })).rejects.toThrow('exceeds');
  });

  it('verifies provider event bytes and re-fetches terminal success for a stale failure event', async () => {
    const f = await chargeFixture();
    await f.provider.confirmCharge(f.created.id, f.confirm);
    const event: PaymentEvent = { id: 'evt_scenario_failure', type: 'payment_intent.payment_failed', gymId: f.gymId,
      objectId: f.created.id, objectKind: 'charge' };
    const body = new TextEncoder().encode(JSON.stringify(event));
    const parsed = await f.provider.parseWebhook(body, f.payments.signWebhook(body));
    expect(parsed).toEqual(event);
    expect(await f.provider.readPaymentObject({ kind: parsed.objectKind, id: parsed.objectId })).toMatchObject({
      status: 'found', value: { kind: 'charge', object: { status: 'succeeded' } },
    });
    await expect(f.provider.parseWebhook(body, 'invalid')).rejects.toThrow('signature');
  });
});
