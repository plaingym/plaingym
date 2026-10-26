// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvoiceList } from './page.js';
import { InvoiceDetails } from './detail.js';
import { createInvoiceClient } from './api.js';
import { registration } from './registrations.js';
import type { Invoice, InvoiceDetail, MaskedPaymentMethod, GymSettings, Payment } from '@plaingym/shared/contracts';

const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0');
const createdAt = '2026-10-25T12:00:00Z', gymId = id(1), home = id(2);
const invoice: Invoice = { id: id(3), createdAt, householdId: home, kind: 'one_off', status: 'open', number: 42,
  dueOn: '2026-10-25', periodStartsOn: null, periodEndsOn: null, amountCents: 2500, currency: 'USD', paidAt: null, needsReview: false, disputeId: null, disputeStatus: null };
const payment: Payment = { id: id(4), createdAt, invoiceId: invoice.id, amountCents: 2500, currency: 'USD', method: 'cash', reference: null, paidAt: createdAt };
const card: MaskedPaymentMethod = { id: id(5), createdAt, householdId: home, brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2030, isDefault: true, revokedAt: null };
const settings: GymSettings = { id: gymId, name: 'Gym', slug: 'gym', currency: 'USD', timezone: 'America/Vancouver', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null,
  bookingWindowDays: 7, cancellationCutoffMinutes: 0, openMatCountsAsClass: false, billingEnabled: true, memberEmailsEnabled: true, revision: 1, createdAt, updatedAt: createdAt };
const desk = { record: true, refund: false, links: true }, admin = { ...desk, refund: true };
function transport(initial: Partial<InvoiceDetail> = {}) {
  const detail: InvoiceDetail = { invoice, lineItems: [{ id: id(7), createdAt, householdId: home, invoiceId: invoice.id, kind: 'charge', description: 'Drop-in',
    membershipId: null, chargeTypeId: null, amountCents: 2500, currency: 'USD', quantity: 1, taxRateId: null, taxRateMillionths: null, taxInclusive: null }], payments: [], refunds: [], ...initial };
  const page = (data: unknown[], total = data.length) => ({ data, pagination: { limit: 25, offset: 0, total } });
  const fetcher = vi.fn(async (path: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(path), 'http://gym.test'), method = options?.method ?? 'GET';
    if (url.pathname === '/api/billing/invoices' && method === 'GET') return Response.json(page([detail.invoice], 26));
    if (url.pathname === '/api/billing/invoices/one-off') return Response.json({ data: detail.invoice }, { status: 201 });
    if (url.pathname === '/api/billing/invoices/' + invoice.id && method === 'GET') return Response.json({ data: detail });
    if (url.pathname.endsWith('/release-hold')) { detail.invoice = { ...detail.invoice, needsReview: false }; return Response.json({ data: detail.invoice }); }
    if (url.pathname.endsWith('/payment-methods')) return Response.json(page([card]));
    if (url.pathname === '/api/households/' + home) return Response.json({ data: { id: home, name: 'Rivera household', email: null, phone: null, address: {}, revision: 1, createdAt } });
    if (url.pathname.endsWith('/payments') && method === 'POST') {
      detail.invoice = { ...invoice, status: 'paid', paidAt: createdAt }; detail.payments = [payment]; return Response.json({ data: payment }, { status: 201 });
    }
    if (url.pathname === '/api/billing/charge-types') return Response.json(page([]));
    if (url.pathname === '/api/billing/tax-rates') return Response.json(page([]));
    if (url.pathname === '/api/settings') return Response.json({ data: settings });
    if (url.pathname === '/api/links/send') return Response.json({ data: {
      id: id(9), createdAt, householdId: home, campaignId: null, purpose: 'pay_invoice', invoiceId: invoice.id, memberId: null,
      expiresAt: '2026-11-01T12:00:00Z', usedAt: null, revokedAt: null, createdBy: id(10),
    } });
    return Response.json({}, { status: 503 });
  });
  return { fetcher, client: createInvoiceClient(fetcher), detail };
}
function start(view: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{view}</QueryClientProvider>);
}
afterEach(cleanup);
describe('invoice and household payment UI', () => {
  it('registers the invoice navigation and member profile tab', () => {
    expect(registration.adminNav?.[0]).toMatchObject({ enabled: true, href: '/admin/billing/invoices' });
    expect(registration.memberTabs?.[0]).toMatchObject({ enabled: true });
  });
  it('scopes the member invoice list to its household, filters and paginates', async () => {
    const f = transport(); start(<InvoiceList gymId={gymId} householdId={home} access={desk} client={f.client}/>);
    await screen.findByRole('button', { name: 'View invoice 42' });
    expect(f.fetcher.mock.calls[0]?.[0]).toContain('householdId=' + home);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(f.fetcher.mock.calls.some(([path]) => String(path).includes('offset=25'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paid' } });
    await waitFor(() => expect(f.fetcher.mock.calls.some(([path]) => String(path).includes('status=paid') && String(path).includes('offset=0'))).toBe(true));
  });
  it('lets front desk record a check and does not offer a refund', async () => {
    const f = transport(); start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={desk} client={f.client}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Record cash or check' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Record cash or check' })).toBeDefined();
    fireEvent.change(within(dialog).getByLabelText('Payment method'), { target: { value: 'check' } });
    fireEvent.change(within(dialog).getByLabelText('Reference (optional)'), { target: { value: 'Check 204' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const sent = f.fetcher.mock.calls.find(([path]) => String(path).endsWith('/payments'));
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ method: 'check', reference: 'Check 204', amountCents: 2500, currency: 'USD' });
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'View receipt' })).toBeDefined();
  });
  it('offers refund to an admin, keeps errors and draft amounts inside the shared dialog', async () => {
    const f = transport({ invoice: { ...invoice, status: 'paid', paidAt: createdAt }, payments: [payment] });
    start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={admin} client={f.client}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '10.29' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toBeDefined();
    expect((within(dialog).getByLabelText('Amount') as HTMLInputElement).value).toBe('10.29');
    const sent = f.fetcher.mock.calls.find(([path]) => String(path).endsWith('/refunds'));
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ amountCents: 1029, currency: 'USD' });
  });
  it('uses the signed-link service to email a link bound to this invoice and household', async () => {
    const f = transport(); start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={desk} client={f.client}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Send or share pay link' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Pay link sent to the household.');
    const sent = f.fetcher.mock.calls.find(([path]) => String(path) === '/api/links/send');
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ purpose: 'pay_invoice', invoiceId: invoice.id, householdId: home });
  });
  it('opens a one-off custom charge dialog with exact cents and the current household', async () => {
    const f = transport(); start(<InvoiceList gymId={gymId} householdId={home} access={desk} client={f.client}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Add one-off charge' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Charge source'), { target: { value: 'custom' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Equipment' } });
    fireEvent.change(within(dialog).getByLabelText('Amount (USD)'), { target: { value: '10.29' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add one-off charge' }));
    await waitFor(() => expect(f.fetcher.mock.calls.some(([path]) => String(path).endsWith('/one-off'))).toBe(true));
    const sent = f.fetcher.mock.calls.find(([path]) => String(path).endsWith('/one-off'));
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({ source: 'custom', householdId: home, amountCents: 1029 });
  });
  it('shows a real error state and retries a failed invoice read', async () => {
    const f = transport(); f.fetcher.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={desk} client={f.client}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Record cash or check' })).toBeDefined();
  });
  it.each([
    ['billing_disabled', 'Billing is disabled. Enable billing before charging a card.'],
    ['not_payable', 'This invoice is no longer available for collection. Reload it to see its status.'],
    ['needs_review', 'An owner or admin must release the review hold before charging a card.'],
    ['pending_attempt', 'The card payment is still being resolved. Check back shortly.'],
    ['no_saved_card', 'Add an active default card for this household before charging.'],
    ['already_attempted', 'Automatic collection has already been attempted for this invoice.'],
    ['outside_retry_window', 'This invoice is outside the scheduled retry window.'],
    ['not_auto_collectable', 'This invoice requires a staff payment action.'],
    ['not_due', 'This invoice is not due yet.'],
    ['checkout_changed', 'The pay link changed during collection. Reload the invoice before trying again.'],
    ['reservation_lost', 'The card charge reservation changed. Check back shortly.'],
    ['action_required', 'The existing card payment needs the payer’s authentication.'],
    ['collection_changed', 'The invoice, customer or saved card changed before confirmation. Reload the invoice.'],
    ['already_paid', 'This invoice is already paid. Do not take another payment.'],
  ])('shows the translated server reason for %s', async (reason, message) => {
    const f = transport(), original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (path, options) => String(path).endsWith('/charge')
      ? Response.json({ error: { code: 'conflict', message: 'Server-only message', details: { reason: [reason] } }, requestId: 'request' }, { status: 409 })
      : original(path, options));
    start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={desk} client={f.client}/>);
    const charge = await screen.findByRole('button', { name: 'Charge saved card' });
    await waitFor(() => expect((charge as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(charge);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.queryByText('Server-only message')).toBeNull();
  });
  it.each([desk, admin])('restricts release confirmation to refund-level access: %j', async access => {
    const f = transport({ invoice: { ...invoice, needsReview: true } });
    start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={access} client={f.client}/>);
    const charge = await screen.findByRole('button', { name: 'Charge saved card' }); expect((charge as HTMLButtonElement).disabled).toBe(true);
    const release = screen.queryByRole('button', { name: 'Release review hold' });
    if (!access.refund) { expect(release).toBeNull(); return; }
    fireEvent.click(release!);
    expect(screen.getByText('Confirm that this overdue invoice may be collected. This clears the hold without charging a card.')).toBeDefined();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Review hold released. Choose how to collect this invoice.');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Release review hold' })).toBeNull());
    expect(f.fetcher.mock.calls.some(([path]) => String(path).endsWith('/charge'))).toBe(false);
  });
  it.each(['missing', 'revoked', 'not_default'])('disables card charging for a %s default card', async state => {
    const f = transport(), original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (path, options) => String(path).includes('/payment-methods') ? Response.json({
      data: state === 'missing' ? [] : [{ ...card, revokedAt: state === 'revoked' ? createdAt : null, isDefault: state !== 'not_default' }],
      pagination: { offset: 0, limit: 25, total: state === 'missing' ? 0 : 1 },
    }) : original(path, options));
    start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={desk} client={f.client}/>);
    const button = await screen.findByRole('button', { name: 'Charge saved card' });
    await waitFor(() => expect(f.fetcher.mock.calls.filter(([path]) => String(path).includes('/payment-methods')).length).toBe(2));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows the remaining refundable amount after pending and successful refunds', async () => {
    const f = transport({ invoice: { ...invoice, status: 'paid', paidAt: createdAt }, payments: [payment], refunds: [
      { id: id(20), createdAt, paymentId: payment.id, amountCents: 500, currency: 'USD', reason: null, resolvedAt: createdAt, status: 'succeeded' },
      { id: id(21), createdAt, paymentId: payment.id, amountCents: 300, currency: 'USD', reason: null, resolvedAt: null, status: 'pending' },
    ] });
    start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={admin} client={f.client}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Refund' }));
    expect(screen.getByText('Remaining refundable amount: $17.00')).toBeDefined();
    expect((within(screen.getByRole('dialog')).getByLabelText('Amount') as HTMLInputElement).value).toBe('17.00');
  });
  it('shows a pending provider result as still being resolved', async () => {
    const f = transport(), original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (path, options) => String(path).endsWith('/charge') ? Response.json({ data: {
      id: id(30), createdAt, invoiceId: invoice.id, attemptNumber: 1, amountCents: 2500, currency: 'USD', status: 'pending', declineCode: null, resolvedAt: null,
    } }) : original(path, options));
    start(<InvoiceDetails gymId={gymId} invoiceId={invoice.id} access={desk} client={f.client}/>);
    const charge = await screen.findByRole('button', { name: 'Charge saved card' });
    await waitFor(() => expect((charge as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(charge);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await screen.findByText('The card payment is still being resolved. Check back shortly.');
  });
});
