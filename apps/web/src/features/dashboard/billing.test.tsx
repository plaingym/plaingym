// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import { api } from '../../lib/api.js';
import { BillingDashboardPanel, billingWidgetViews } from './billing.widgets.js';
import { DashboardWidgets } from './widgets.js';

vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn() } }));
const widgets = [
  { id: 'mrr', titleKey: 'dashboard/billing:mrr', status: 'ready', money: { currency: 'CAD', amountCents: 12345 } },
  { id: 'past_due', titleKey: 'dashboard/billing:past_due', status: 'ready', money: { currency: 'CAD', amountCents: 500 }, invoiceCount: 2 },
  { id: 'upcoming_charges', titleKey: 'dashboard/billing:upcoming_charges', status: 'ready', money: { currency: 'CAD', amountCents: 10000 }, invoiceCount: 1, from: '2026-10-26', through: '2026-11-01' },
  { id: 'disputes', titleKey: 'dashboard/billing:disputes', status: 'ready', money: { currency: 'CAD', amountCents: 0 }, count: 0 },
] as const;
function start(roles: readonly StaffRole[] = ['owner']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderPanel = (gymId: string, nextRoles = roles) => <QueryClientProvider client={client}><BillingDashboardPanel gymId={gymId} roles={nextRoles}/></QueryClientProvider>;
  return { ...render(renderPanel('gym-a')), client, renderPanel };
}
beforeEach(() => {
  vi.mocked(api.GET).mockResolvedValue({ response: new Response(), data: { data: { generatedAt: '2026-10-26T12:00:00Z', currency: 'CAD', widgets } } } as Awaited<ReturnType<typeof api.GET>>);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('billing dashboard panel', () => {
  it('renders all metrics with currency, counts, date range and estimate explanations, and refreshes', async () => {
    start();
    await screen.findByRole('heading', { name: 'Monthly recurring revenue' });
    expect(screen.getByText(/123.45/)).toBeDefined();
    expect(screen.getByText('Invoices: 2')).toBeDefined();
    expect(screen.getByText('Disputes: 0')).toBeDefined();
    expect(screen.getByText('Charges: 1')).toBeDefined();
    expect(screen.getByText('Oct 26, 2026 through Nov 1, 2026')).toBeDefined();
    expect(document.body.textContent).not.toContain('dashboard/billing:');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh billing' }));
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
    expect(api.GET).toHaveBeenCalledWith('/api/dashboard/billing', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  });
  it('does not fetch for a coach or portal identity and hides stale billing payloads', () => {
    start(['coach']); expect(api.GET).not.toHaveBeenCalled();
    render(<DashboardWidgets widgets={[...widgets]} views={billingWidgetViews} roles={['coach']}/>);
    expect(screen.queryByRole('heading', { name: 'Monthly recurring revenue' })).toBeNull();
  });
  it('renders a safe error and retries', async () => {
    vi.mocked(api.GET).mockRejectedValueOnce(new Error('private processor key'));
    start();
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load billing');
    expect(document.body.textContent).not.toContain('private processor');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Monthly recurring revenue' });
  });
  it('isolates its query cache by gym and role', async () => {
    const view = start(); await screen.findByRole('heading', { name: 'Monthly recurring revenue' });
    view.rerender(view.renderPanel('gym-b', ['admin']));
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
    expect(view.client.getQueryData(['dashboard-billing', 'gym-a', ['owner']])).toBeDefined();
    await waitFor(() => expect(view.client.getQueryData(['dashboard-billing', 'gym-b', ['admin']])).toBeDefined());
  });
  it('shows an empty response and refuses malformed totals', async () => {
    vi.mocked(api.GET).mockResolvedValueOnce({ response: new Response(), data: { data: { generatedAt: '2026-10-26T12:00:00Z', currency: 'CAD', widgets: [] } } } as Awaited<ReturnType<typeof api.GET>>);
    const view = start(); await screen.findByText('No billing widgets are available.');
    vi.mocked(api.GET).mockResolvedValueOnce({ response: new Response(), data: { data: { generatedAt: '2026-10-26T12:00:00Z', currency: 'USD', widgets } } } as Awaited<ReturnType<typeof api.GET>>);
    view.rerender(view.renderPanel('gym-b'));
    await screen.findByRole('alert');
    expect(screen.queryByText(/123.45/)).toBeNull();
  });
});
