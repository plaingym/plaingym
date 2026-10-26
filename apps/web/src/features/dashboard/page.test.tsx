// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import type { MatDashboardWidget } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { useBootstrap } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { DashboardPage } from './page.js';
import { DashboardWidgets } from './widgets.js';
import { registration } from './registrations.js';

vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn() } }));
// Billing has its own request, permission, cache and rendering coverage in billing.test.tsx.
vi.mock('./billing.widgets.js', () => ({ BillingDashboardPanel: () => null, billingWidgetViews: [] }));
const generatedAt = '2026-10-22T12:00:00Z';
const memberId = '01900000-0000-7000-8000-000000000010';
const widgets: MatDashboardWidget[] = [
  { id: 'active_members', titleKey: 'dashboard/dashboard:widget.active_members', status: 'ready', count: 12 },
  { id: 'not_seen', titleKey: 'dashboard/dashboard:widget.not_seen', status: 'ready', days: 14, count: 2,
    members: [{ memberId, firstName: 'Alex', lastName: 'River', lastSeenAt: null }] },
  { id: 'promotion_ready', titleKey: 'dashboard/dashboard:widget.promotion_ready', status: 'ready', count: 0, members: [] },
];
function bootstrap(roles: StaffRole[] = ['owner'], gymId = 'gym-a') {
  const data: ShellBootstrap = { gym: { id: gymId, name: 'Academy', enabledModules: [] }, session: { userId: 'user', roles, member: false }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], queryFn: async () => data, initialData: data }).getCurrentResult());
}
function start() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><DashboardPage/></QueryClientProvider>);
  return { ...view, client };
}
beforeEach(() => {
  bootstrap();
  vi.mocked(api.GET).mockResolvedValue({ response: new Response(), data: { data: { generatedAt, widgets } } } as Awaited<ReturnType<typeof api.GET>>);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('dashboard page', () => {
  it('renders live mat metrics, member links, empty states and truncation, and refreshes', async () => {
    start();
    await screen.findByRole('heading', { name: 'Active members' });
    expect(screen.getByText('12')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Alex River' }).getAttribute('href')).toBe('/admin/members/' + memberId);
    expect(screen.getByText('Showing 1 of 2 members.')).toBeDefined();
    expect(screen.getByText('No members are ready for promotion yet.')).toBeDefined();
    expect(document.body.textContent).not.toContain('dashboard/dashboard:');
    expect(api.GET).toHaveBeenCalledWith('/api/dashboard', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
    expect(registration.adminNav?.[0]?.enabled).toBe(true);
  });
  it('hides promotion data from front desk even if a stale response contains it', async () => {
    bootstrap(['front_desk']); start();
    await screen.findByRole('heading', { name: 'Active members' });
    expect(screen.queryByRole('heading', { name: 'Promotion ready' })).toBeNull();
  });
  it('denies portal-only identities before fetching', () => {
    bootstrap([]); start();
    expect(screen.getByRole('alert').textContent).toContain('do not have permission');
    expect(api.GET).not.toHaveBeenCalled();
  });
  it('shows safe load errors and retries', async () => {
    vi.mocked(api.GET).mockRejectedValueOnce(new Error('private database detail'));
    start();
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load');
    expect(document.body.textContent).not.toContain('private database');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('heading', { name: 'Active members' });
  });
  it('isolates cached queries by gym and role when bootstrap changes', async () => {
    const view = start(); await screen.findByRole('heading', { name: 'Active members' });
    bootstrap(['front_desk'], 'gym-a');
    view.rerender(<QueryClientProvider client={view.client}><DashboardPage/></QueryClientProvider>);
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'Promotion ready' })).toBeNull();
    bootstrap(['owner'], 'gym-b');
    view.rerender(<QueryClientProvider client={view.client}><DashboardPage/></QueryClientProvider>);
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(3));
    expect(view.client.getQueryData(['dashboard', 'gym-a', ['owner']])).toBeDefined();
    await waitFor(() => expect(view.client.getQueryData(['dashboard', 'gym-b', ['owner']])).toBeDefined());
  });
  it('renders unavailable status without false zeroes and accepts extension renderers', () => {
    render(<DashboardWidgets roles={['owner']} widgets={[
      { id: 'active_members', titleKey: widgets[0]!.titleKey, status: 'unavailable', count: 0 },
      { id: 'sample.count', kind: 'count', titleKey: 'dashboard/dashboard:title', status: 'ready', count: 5 },
      { id: 'mrr', titleKey: 'dashboard/dashboard:title', status: 'ready', money: { currency: 'USD', amountCents: 12345 } },
    ]} views={[{ id: 'mrr', permission: 'billing.read', render: () => <p>USD 123.45</p> }]}/>);
    expect(screen.getByText('Temporarily unavailable')).toBeDefined();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('USD 123.45')).toBeDefined();
  });
});
