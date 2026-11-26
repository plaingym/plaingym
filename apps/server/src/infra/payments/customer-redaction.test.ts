// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { CustomerDeleted, FakePayments, PaymentMethodCustomerDeleted } from './index.js';
import { StripePayments } from './stripe.js';
import { StripeFixtures } from './stripe-fixtures.js';
import { customerCardRedactionContract } from './payments.contract.js';
import type { ObjectData, PaymentTransport, ProviderRequest } from './transport.js';
import { recordingTransport, replayTransport } from './transport.js';
import { FixtureRecorder } from './recording.js';
import { setLogSink } from '../../core/log.js';

const gymId = 'gym_cards', customerId = 'cus_cards';
const details = { name: 'Card holder', email: 'payer@example.invalid', phone: '+15555550100', address: { line1: '1 Mat Road' } };
const ids = Array.from({ length: 105 }, (_, i) => 'pm_redact_' + i);
function stripe() {
  const transport = new StripeFixtures(gymId);
  transport.objects.set(customerId, { id: customerId, object: 'customer', name: 'Household', metadata: { gym_id: gymId } });
  for (const [i, methodId] of ids.entries()) transport.objects.set(methodId, { id: methodId, object: 'payment_method', created: transport.now,
    customer: i === 103 ? null : i === 102 ? 'cus_foreign' : customerId, billing_details: structuredClone(details),
    type: i === 101 ? 'us_bank_account' : 'card', metadata: i === 104 ? { gym_id: 'other-gym' } : {},
    ...(i === 101 ? { us_bank_account: { last4: '6789' } }
      : { card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }) });
  const payments = new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' });
  return { payments, transport, customerId, cards: () => ids.map(methodId => {
    const card = transport.objects.get(methodId)!;
    return { id: methodId, type: String(card.type), attached: !!card.customer, details: card.billing_details as typeof details };
  }) };
}
customerCardRedactionContract('StripePayments', stripe);
customerCardRedactionContract('FakePayments', async () => {
  const payments = new FakePayments(gymId);
  payments.seedCustomer({ id: customerId, email: 'payer@example.invalid' });
  for (const [i, methodId] of ids.entries()) {
    payments.recordPaymentMethod({ id: methodId, customerId: i === 102 ? 'cus_foreign' : customerId,
      type: i === 101 ? 'us_bank_account' : 'card', ...(i === 104 ? { gymId: 'other-gym' } : {}),
      brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
    payments.setBillingDetails(methodId, structuredClone(details));
  }
  await payments.detachPaymentMethod(ids[103]!);
  // The detached fixture holds its details, as a prior staff removal would leave them.
  return { payments, customerId, cards: () => ids.map((methodId, i) => ({ id: methodId, type: i === 101 ? 'us_bank_account' : 'card', attached: i !== 103,
    details: payments.billingDetails(methodId) ?? {} })) };
});

it('pages past 100 attached cards and avoids repeating cleared writes', async () => {
  const { payments, transport } = stripe();
  await payments.redactCustomer(customerId);
  const pages = transport.requests.filter(request => request.path === '/v1/payment_methods');
  expect(pages.map(page => page.params)).toEqual([
    { customer: customerId, limit: 100 },
    { customer: customerId, limit: 100, starting_after: ids[99] },
  ]);
  const writes = () => transport.requests.filter(request => request.method === 'POST');
  const before = writes().length;
  await payments.redactCustomer(customerId);
  expect(writes()).toHaveLength(before);
  expect(writes().filter(request => request.path.startsWith('/v1/payment_methods/'))).toHaveLength(102);
});

it.each([401, 403])('stops at the first refused method write after deleting tax IDs (%s)', async statusCode => {
  const fixture = stripe();
  fixture.transport.objects.set('txi_erased', { id: 'txi_erased', object: 'tax_id', customer: customerId });
  const error = Object.assign(new Error('Write refused'), { statusCode });
  const request = vi.fn<PaymentTransport['request']>(async input => {
    if (input.method === 'POST' && input.path.startsWith('/v1/payment_methods/')) throw error;
    return fixture.transport.request(input);
  });
  const payments = new StripePayments(gymId, { transport: { request }, webhookSecret: 'fixture-secret' });
  const redaction = payments.redactCustomer(customerId);
  if (statusCode === 403) await expect(redaction).rejects.toMatchObject({ message: 'Check the Stripe permission for Payment Methods', cause: error });
  else await expect(redaction).rejects.toBe(error);
  expect(request.mock.calls.map(([input]) => [input.method, input.path])).toEqual([
    ['GET', '/v1/customers/' + customerId],
    ['POST', '/v1/customers/' + customerId],
    ['GET', '/v1/customers/' + customerId + '/tax_ids'],
    ['DELETE', '/v1/customers/' + customerId + '/tax_ids/txi_erased'],
    ['GET', '/v1/payment_methods'],
    ['POST', '/v1/payment_methods/' + ids[0]],
  ]);
  expect(fixture.transport.objects.has('txi_erased')).toBe(false);
});

it('continues clearing methods after a transient failure and retries the failed method', async () => {
  const fixture = stripe();
  fixture.transport.objects.set('txi_erased', { id: 'txi_erased', object: 'tax_id', customer: customerId, value: 'DE123456789' });
  let fail = true;
  const transport: PaymentTransport = { async request(input) {
    if (fail && input.method === 'POST' && input.path.endsWith('/' + ids[1]))
      throw Object.assign(new Error('Stripe outage'), { statusCode: 500 });
    return fixture.transport.request(input);
  } };
  const payments = new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' });
  await expect(payments.redactCustomer(customerId)).rejects.toThrow('Stripe outage');
  expect(fixture.transport.objects.has('txi_erased')).toBe(false);
  expect(fixture.cards()[101]!.details).toEqual({ name: null, email: null, phone: null, address: null });
  fail = false;
  await payments.redactCustomer(customerId);
  expect(fixture.cards().slice(0, 102).every(card => Object.values(card.details).every(value => value == null))).toBe(true);
});

it('replays every method type, tax deletion despite a card error, and a foreign gym warning', async () => {
  const fixture = stripe(), recorder = new FixtureRecorder(gymId);
  fixture.transport.objects.set('txi_replay', { id: 'txi_replay', object: 'tax_id', customer: customerId });
  let fail = true;
  const failing: PaymentTransport = { async request(input) {
    if (fail && input.method === 'POST' && input.path.endsWith('/' + ids[1]))
      throw Object.assign(new Error('Stripe outage'), { statusCode: 403 });
    return fixture.transport.request(input);
  } };
  const live = new StripePayments(gymId, { transport: recordingTransport(failing, recorder), webhookSecret: 'fixture-secret' });
  await expect(live.redactCustomer(customerId)).rejects.toThrow('Payment Methods');
  expect(fixture.transport.objects.has('txi_replay')).toBe(false);
  fail = false;
  await live.redactCustomer(customerId);
  expect(fixture.cards()[101]!.details).toEqual({ name: null, email: null, phone: null, address: null });
  expect(fixture.cards()[104]!.details).toEqual(details);
  const tape = JSON.parse(JSON.stringify(recorder.tape)) as typeof recorder.tape;
  const transport = replayTransport(tape, gymId), lines: string[] = [], previous = setLogSink(line => lines.push(line));
  try {
    const replay = new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' });
    await expect(replay.redactCustomer(customerId)).rejects.toThrow('Payment Methods');
    await expect(replay.redactCustomer(customerId)).resolves.toBeUndefined();
    transport.assertConsumed();
  } finally { setLogSink(previous); }
  expect(lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ level: 'warn',
    event: 'payments.redaction.method_skipped_foreign', paymentMethodId: ids[104] }));
  expect(lines.join('')).not.toContain(details.email);
  const bankWrite = tape.exchanges.find(exchange => (exchange.input as { method: string; path: string }).method === 'POST'
    && (exchange.input as { path: string }).path.endsWith('/' + ids[101]));
  expect(bankWrite?.output).toMatchObject({ type: 'us_bank_account', billing_details: { name: null, email: null, phone: null, address: null } });
});

it('clears payment methods even when tax ID deletion fails', async () => {
  const fixture = stripe();
  const transport: PaymentTransport = { async request(input) {
    if (input.path.endsWith('/tax_ids')) throw Object.assign(new Error('Tax IDs forbidden'), { statusCode: 403 });
    return fixture.transport.request(input);
  } };
  await expect(new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' }).redactCustomer(customerId)).rejects.toThrow('Customers (tax IDs)');
  expect(fixture.cards().slice(0, 102).every(card => Object.values(card.details).every(value => value == null))).toBe(true);
});

it('refuses a foreign card returned by an inconsistent provider list', async () => {
  const fixture = stripe();
  const transport: PaymentTransport = { async request(input) {
    if (input.path === '/v1/payment_methods') return { data: [fixture.transport.objects.get(ids[102]!) as ObjectData], has_more: false };
    return fixture.transport.request(input);
  } };
  await expect(new StripePayments(gymId, { transport, webhookSecret: 'fixture-secret' }).redactCustomer(customerId)).rejects.toThrow('another customer');
  expect(fixture.cards()[102]!.details).toEqual(details);
});

// A pre-authorized debit account, which Stripe won't leave without a billing name and email, beside a card.
const padPath = '/v1/payment_methods/pm_pad';
const blank = { name: '', email: '', phone: '', address: '' };
const placeholders = { name: 'Erased member', email: 'erased-member@example.com', phone: '', address: '' };
const redacted = { name: 'Erased member', email: 'erased-member@example.com', phone: null, address: null };
function padStripe(wrap?: (input: ProviderRequest, next: PaymentTransport['request']) => Promise<ObjectData>) {
  const transport = new StripeFixtures(gymId);
  transport.objects.set('cus_pad', { id: 'cus_pad', object: 'customer', name: 'Household', metadata: { gym_id: gymId } });
  transport.objects.set('pm_pad', { id: 'pm_pad', object: 'payment_method', type: 'acss_debit', created: transport.now, customer: 'cus_pad',
    acss_debit: { last4: '6789', bank_name: 'STRIPE TEST BANK' }, billing_details: structuredClone(details) });
  transport.objects.set('pm_pad_card', { id: 'pm_pad_card', object: 'payment_method', type: 'card', created: transport.now, customer: 'cus_pad',
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, billing_details: structuredClone(details) });
  const seen: ProviderRequest[] = [];
  const request: PaymentTransport['request'] = async input => {
    seen.push(structuredClone(input));
    return wrap ? wrap(input, next => transport.request(next)) : transport.request(input);
  };
  const payments = new StripePayments(gymId, { transport: { request }, webhookSecret: 'fixture-secret' });
  const method = (methodId: string) => transport.objects.get(methodId)!;
  return { payments, transport, method, posts: () => seen.filter(item => item.method === 'POST').map(item => ({ path: item.path, params: item.params })) };
}
function withLogs<T>(lines: string[], run: () => Promise<T>): Promise<T> {
  const previous = setLogSink(line => lines.push(line));
  return run().finally(() => setLogSink(previous));
}

it('refuses a blank name, then a blank email, on a pre-authorized debit account but not on a card', async () => {
  const { transport, method } = padStripe();
  const write = (path: string, billing: Record<string, string>) =>
    transport.request({ method: 'POST', path, params: { billing_details: billing } });
  await expect(write(padPath, blank)).rejects.toMatchObject({ statusCode: 400, code: 'parameter_missing', param: 'billing_details[name]' });
  expect(method('pm_pad').billing_details).toEqual(details);
  await expect(write(padPath, { name: 'Erased member', email: '' }))
    .rejects.toMatchObject({ statusCode: 400, code: 'parameter_missing', param: 'billing_details[email]' });
  expect(method('pm_pad').billing_details).toEqual(details);
  await write(padPath, placeholders);
  expect(method('pm_pad').billing_details).toEqual(redacted);
  await write('/v1/payment_methods/pm_pad_card', blank);
  expect(method('pm_pad_card').billing_details).toEqual({ name: null, email: null, phone: null, address: null });
});

it('redacts a customer whose debit account needs placeholders and sends nothing on a second run', async () => {
  const { payments, method, posts } = padStripe(), lines: string[] = [];
  await withLogs(lines, () => payments.redactCustomer('cus_pad'));
  expect(method('pm_pad')).toMatchObject({ customer: 'cus_pad', billing_details: redacted });
  expect(method('pm_pad_card')).toMatchObject({ customer: 'cus_pad', billing_details: { name: null, email: null, phone: null, address: null } });
  expect(posts().filter(item => item.path === padPath))
    .toEqual([{ path: padPath, params: { billing_details: blank } }, { path: padPath, params: { billing_details: placeholders } }]);
  const before = posts().length;
  await withLogs(lines, () => payments.redactCustomer('cus_pad'));
  expect(posts()).toHaveLength(before);
  expect(lines.join('')).not.toContain(details.email);
  expect(lines.join('')).not.toContain(details.name);
});

it('writes the placeholders before detaching a debit account on erasure, once', async () => {
  const { payments, method, posts } = padStripe(), lines: string[] = [];
  await withLogs(lines, () => payments.detachPaymentMethod('pm_pad', { redactBillingDetails: true }));
  expect(method('pm_pad')).toMatchObject({ customer: null, billing_details: redacted });
  expect(posts()).toEqual([{ path: padPath, params: { billing_details: blank } }, { path: padPath, params: { billing_details: placeholders } },
    { path: padPath + '/detach', params: {} }]);
  await withLogs(lines, () => payments.detachPaymentMethod('pm_pad', { redactBillingDetails: true }));
  expect(posts()).toHaveLength(3);
  expect(lines.join('')).not.toContain(details.email);
  expect(lines.join('')).not.toContain(details.name);
});

it('retries only the detach of a debit account that already holds the placeholders', async () => {
  let fail = true;
  const { payments, method, posts } = padStripe((input, next) => {
    if (input.method === 'POST' && input.path === padPath + '/detach' && fail) {
      fail = false; return Promise.reject(Object.assign(new Error('Stripe outage'), { statusCode: 500 }));
    }
    return next(input);
  });
  await expect(payments.detachPaymentMethod('pm_pad', { redactBillingDetails: true })).rejects.toThrow('Stripe outage');
  expect(method('pm_pad')).toMatchObject({ customer: 'cus_pad', billing_details: redacted });
  const before = posts().length;
  await payments.detachPaymentMethod('pm_pad', { redactBillingDetails: true });
  expect(posts().slice(before)).toEqual([{ path: padPath + '/detach', params: {} }]);
  expect(method('pm_pad').customer).toBeNull();
});

it('stops when the placeholder write is refused', async () => {
  const { payments, method, posts } = padStripe((input, next) => {
    const billing = (input.params?.billing_details ?? {}) as { name?: string };
    if (input.method === 'POST' && input.path === padPath && billing.name === 'Erased member')
      return Promise.reject(Object.assign(new Error('Permission denied'), { statusCode: 403 }));
    return next(input);
  });
  await expect(payments.detachPaymentMethod('pm_pad', { redactBillingDetails: true })).rejects.toThrow('Check the Stripe permission for Payment Methods');
  expect(posts().some(item => item.path.endsWith('/detach'))).toBe(false);
  expect(method('pm_pad')).toMatchObject({ customer: 'cus_pad', billing_details: details });
  await expect(payments.redactCustomer('cus_pad')).rejects.toThrow('Check the Stripe permission for Payment Methods');
  expect(method('pm_pad').billing_details).toEqual(details);
});

it('rethrows any other refusal of the blank write without a placeholder write or detach', async () => {
  const refusal = Object.assign(new Error('Invalid empty phone'), { statusCode: 400, code: 'parameter_invalid_empty', param: 'billing_details[phone]' });
  const { payments, method, posts } = padStripe((input, next) => {
    if (input.method === 'POST' && input.path === padPath) return Promise.reject(refusal);
    return next(input);
  });
  await expect(payments.detachPaymentMethod('pm_pad', { redactBillingDetails: true })).rejects.toBe(refusal);
  expect(posts()).toEqual([{ path: padPath, params: { billing_details: blank } }]);
  expect(method('pm_pad').customer).toBe('cus_pad');
});

it('refuses in the fake, as the adapter does, to detach a card whose own customer was deleted', async () => {
  const payments = new FakePayments(gymId);
  payments.seedCustomer({ id: 'cus_gone', email: 'payer@example.invalid', deleted: true });
  payments.recordPaymentMethod({ id: 'pm_gone', customerId: 'cus_gone', brand: 'visa', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
  payments.setBillingDetails('pm_gone', structuredClone(details));
  const rejection = await payments.detachPaymentMethod('pm_gone', { redactBillingDetails: true }).catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(PaymentMethodCustomerDeleted);
  expect(rejection).not.toBeInstanceOf(CustomerDeleted);
  expect(payments.billingDetails('pm_gone')).toEqual(details);
});
