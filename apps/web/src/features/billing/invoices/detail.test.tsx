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
    sms: { phoneValid: false, phoneE164: null, notices: null }, address: {}, revision: 1, createdAt } });
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
