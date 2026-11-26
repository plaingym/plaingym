// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Invoice, InvoiceDetail, MaskedPaymentMethod, ShellBootstrap } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import { createShellServices } from '../../../app/services.js';
import { createInvoiceClient } from './api.js';
import { InvoiceDetails } from './detail.js';

afterEach(cleanup);
const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0');
const createdAt = '2026-10-25T12:00:00Z', gymId = id(1), home = id(2);
const invoice: Invoice = { id: id(3), createdAt, householdId: home, kind: 'one_off', status: 'open', number: 42,
  dueOn: '2026-10-25', periodStartsOn: null, periodEndsOn: null, amountCents: 2500, currency: 'USD', paidAt: null, needsReview: false, disputeId: null, disputeStatus: null };
const card: MaskedPaymentMethod = { id: id(5), createdAt, householdId: home, type: 'card', bankName: null, brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2030, isDefault: false, revokedAt: null };
const detail: InvoiceDetail = { invoice, payments: [], refunds: [], lineItems: [{ id: id(7), createdAt, householdId: home, invoiceId: invoice.id, kind: 'charge',
  description: 'Drop-in', membershipId: null, chargeTypeId: null, planId: null, billedUnitAmountCents: null, billedDiscount: null,
  amountCents: 2500, currency: 'USD', quantity: 1, taxRateId: null, taxRateMillionths: null, taxInclusive: null }] };
const page = (data: unknown[]) => ({ data, pagination: { limit: 25, offset: 0, total: data.length } });
const fetcher = vi.fn(async (path: string | URL | Request) => {
  const url = new URL(String(path), 'http://gym.test');
  if (url.pathname === '/api/billing/invoices/' + invoice.id) return Response.json({ data: detail });
  if (url.pathname.endsWith('/payment-methods')) return Response.json(page([card]));
  if (url.pathname === '/api/households/' + home) return Response.json({ data: { id: home, name: 'Rivera household', email: null, phone: null,
    sms: { phoneValid: false, phoneE164: null, notices: null }, address: {}, pinSet: false, revision: 1, createdAt } });
  if (url.pathname === '/api/members') return Response.json(page([]));
  return Response.json({}, { status: 503 });
});
const bootstrap: ShellBootstrap = { gym: { id: gymId, name: 'Gym', timezone: 'America/Vancouver', currency: 'USD', enabledModules: [] },
  session: { userId: id(10), displayName: 'Test User', roles: ['front_desk'], member: false }, login: { password: true, magicLink: false } };
function start() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(async () => bootstrap)}>
      <InvoiceDetails gymId={gymId} invoiceId={invoice.id} client={createInvoiceClient(fetcher)} access={{ record: true, refund: false, links: true }}/>
    </ShellServicesContext.Provider></QueryClientProvider>);
}

it('hides the invoice sections while a card confirmation is open, and brings them back', async () => {
  start();
  fireEvent.click(await screen.findByRole('button', { name: 'Remove payment method' }));
  await screen.findByRole('button', { name: 'Back to payment methods' });
  expect(screen.queryByRole('button', { name: 'Record cash or check' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Charge saved payment method' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Invoice items' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to payment methods' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Record cash or check' })).toBeDefined());
  expect(screen.getByRole('button', { name: 'Charge saved payment method' })).toBeDefined();
  expect(screen.getByRole('heading', { name: 'Invoice items' })).toBeDefined();
});

it('leaves no card confirmation open after an invoice action closes', async () => {
  start();
  fireEvent.click(await screen.findByRole('button', { name: 'Record cash or check' }));
  await screen.findByRole('button', { name: 'Back to invoice' });
  expect(screen.queryByRole('button', { name: 'Remove payment method' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to invoice' }));
  await screen.findByRole('button', { name: 'Remove payment method' });
  expect(screen.queryByRole('button', { name: 'Back to payment methods' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Record cash or check' })).toBeDefined();
});

it('shows the specific send refusal reason instead of Stripe is unavailable when a pay link send fails', async () => {
  const sendClient = createInvoiceClient(async (path, init) => {
    const url = new URL(String(path), 'http://gym.test');
    if (url.pathname === '/api/links/send' && init?.method === 'POST') {
      return Response.json({ error: { code: 'unavailable', message: 'Signed link email was not delivered', details: { reason: ['email_disabled'] } } }, { status: 503 });
    }
    return fetcher(path);
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(async () => bootstrap)}>
      <InvoiceDetails gymId={gymId} invoiceId={invoice.id} client={sendClient} access={{ record: true, refund: false, links: true }}/>
    </ShellServicesContext.Provider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Send or share pay link' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain("Member email is turned off for this gym, so the link wasn't emailed.");
  expect(alert.textContent).not.toContain('Stripe is unavailable');
});

it('shows the save error instead of delivery failed when /api/links/send answers 409 conflict', async () => {
  const sendClient = createInvoiceClient(async (path, init) => {
    const url = new URL(String(path), 'http://gym.test');
    if (url.pathname === '/api/links/send' && init?.method === 'POST') {
      return Response.json({ error: { code: 'conflict', message: 'Invoice cannot be paid' } }, { status: 409 });
    }
    return fetcher(path);
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(async () => bootstrap)}>
      <InvoiceDetails gymId={gymId} invoiceId={invoice.id} client={sendClient} access={{ record: true, refund: false, links: true }}/>
    </ShellServicesContext.Provider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Send or share pay link' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Could not save. Reload the invoice and check for a pending payment before trying again.');
  expect(alert.textContent).not.toContain("The link couldn't be delivered");
});

it.each([
  ['not_payable', 'Invoice cannot be paid', 'This invoice is no longer available for collection. Reload it to see its status.'],
  ['zero_invoice', 'No payment is needed', 'No payment is needed for this invoice.'],
] as const)('shows the specific error when /api/links/send answers 409 %s', async (reason, message, expected) => {
  const sendClient = createInvoiceClient(async (path, init) => {
    const url = new URL(String(path), 'http://gym.test');
    if (url.pathname === '/api/links/send' && init?.method === 'POST') {
      return Response.json({ error: { code: 'conflict', message, details: { reason: [reason] } } }, { status: 409 });
    }
    return fetcher(path);
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(async () => bootstrap)}>
      <InvoiceDetails gymId={gymId} invoiceId={invoice.id} client={sendClient} access={{ record: true, refund: false, links: true }}/>
    </ShellServicesContext.Provider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Send or share pay link' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(expected);
  expect(alert.textContent).not.toContain('Could not save. Reload the invoice and check for a pending payment before trying again.');
});

const processing: InvoiceDetail = { ...detail, invoice: { ...invoice, status: 'processing' } };
function startProcessing(refund: boolean, release?: () => Response) {
  const calls: string[] = [];
  const processingClient = createInvoiceClient(async (path, init) => {
    const url = new URL(String(path), 'http://gym.test');
    if (url.pathname === '/api/billing/invoices/' + invoice.id) return Response.json({ data: processing });
    if (url.pathname === `/api/billing/invoices/${invoice.id}/release-processing` && init?.method === 'POST') {
      calls.push(url.pathname);
      return release?.() ?? Response.json({ data: { ...invoice, status: 'open' } });
    }
    return fetcher(path);
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(async () => bootstrap)}>
      <InvoiceDetails gymId={gymId} invoiceId={invoice.id} client={processingClient} access={{ record: true, refund, links: true }}/>
    </ShellServicesContext.Provider></QueryClientProvider>);
  return calls;
}

it('offers to stop waiting for a bank debit on a processing invoice only to staff who can refund', async () => {
  startProcessing(false);
  await screen.findByRole('heading', { name: 'Invoice items' });
  expect(screen.queryByRole('button', { name: 'Stop waiting for this bank debit' })).toBeNull();
  cleanup();
  const calls = startProcessing(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Stop waiting for this bank debit' }));
  await screen.findByText(/Stripe is checked first: the invoice can be collected again only if Stripe reports the debit failed or cancelled/);
  expect(screen.queryByText('$25.00', { selector: 'form p' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await screen.findByText('The invoice no longer waits for the bank debit. Collect it, send a pay link or void it.');
  expect(calls).toEqual([`/api/billing/invoices/${invoice.id}/release-processing`]);
});

it('shows why a bank debit release was refused in the form', async () => {
  startProcessing(true, () => Response.json({ error: { code: 'conflict', message: 'Stripe still shows this debit as open',
    details: { reason: ['debit_open'] } } }, { status: 409 }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stop waiting for this bank debit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Stripe still shows this debit as open. Cancel the payment in the Stripe Dashboard, then try again.');
});

it("gives a bank debit release its own text when Stripe can't be reached or has no record of the debit", async () => {
  startProcessing(true, () => Response.json({ error: { code: 'unavailable', message: 'Stripe is unavailable',
    details: { reason: ['payments_unavailable'] } } }, { status: 503 }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stop waiting for this bank debit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  const unavailable = await screen.findByRole('alert');
  expect(unavailable.textContent).toContain("Stripe couldn't be reached, so the invoice still waits for the bank debit. Try again shortly.");
  expect(unavailable.textContent).not.toContain('Any existing card or pay-link payment');
  cleanup();
  startProcessing(true, () => Response.json({ error: { code: 'conflict', message: 'Stripe has no record of this debit under the current key',
    details: { reason: ['debit_unknown'] } } }, { status: 409 }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stop waiting for this bank debit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  expect((await screen.findByRole('alert')).textContent).toContain("Stripe has no record of this debit under the gym's current Stripe key, "
    + 'for example after the key was changed or the payment was deleted, so the invoice keeps waiting for it and can\'t be released here. '
    + 'Check the debit in the Stripe Dashboard of the account that made it.');
});

it.each([
  ['debit_unconfigured', "No Stripe key is saved for this gym, so the bank debit can't be checked and the invoice keeps waiting for it. "
    + "Save the gym's Stripe key in Settings, then try again."],
  ['debit_unreadable', "Stripe wouldn't show this debit to the gym's current Stripe key, so the invoice keeps waiting for it. "
    + 'Check that the key can read payments, then try again.'],
])('shows the %s refusal of a bank debit release in the form', async (reason, text) => {
  startProcessing(true, () => Response.json({ error: { code: 'conflict', message: 'Refused', details: { reason: [reason] } } }, { status: 409 }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stop waiting for this bank debit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(text);
  expect(alert.textContent).not.toContain("Stripe couldn't be reached");
});
