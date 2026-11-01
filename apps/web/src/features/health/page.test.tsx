// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import type { ShellBootstrap } from '../../app/services.js';
import { healthTileIds, healthTileSchema, type HealthTile } from '@plaingym/shared/contracts';
import { HealthPage, HealthTiles } from './page.js';
import { useBootstrap } from '../../app/context.js';
import { api } from '../../lib/api.js';
vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn(), POST: vi.fn() } }));
const checkedAt = '2026-10-22T12:00:00Z';
const tiles = (): HealthTile[] => healthTileIds.map((id) => ({ id, status: 'not_configured', details: null, checkedAt: null, message: 'Not set up' }));
function bootstrap(roles: StaffRole[] = ['owner'], gymId = 'gym-a') {
  const data: ShellBootstrap = { gym: { id: gymId, name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: 'owner', displayName: 'Test User', roles, member: false }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], queryFn: async () => data, initialData: data }).getCurrentResult());
}
function start() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><HealthPage/></QueryClientProvider>);
  return { ...view, client };
}
const ok = (data: unknown) => ({ response: new Response(), data }) as never;
const GET = vi.mocked(api.GET) as unknown as ReturnType<typeof vi.fn>, POST = vi.mocked(api.POST) as unknown as ReturnType<typeof vi.fn>;
/** Serve the tiles, and the open charge failure reports from `reports` (read again after every dismissal). */
function serve(reports: () => unknown[] = () => []) {
  GET.mockImplementation(async (path: string) => ok(path === '/api/health/charge-failures' ? { data: reports() } : { data: { generatedAt: checkedAt, tiles: tiles() } }));
}
const healthCalls = () => GET.mock.calls.filter(([path]) => path === '/api/health').length;
beforeEach(() => { bootstrap(); serve(); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('health page', () => {
  it('renders every contracted tile in order, including not set up tiles', async () => {
    start();
    expect(await screen.findByRole('heading', { name: 'System health' })).toBeDefined();
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(healthTileIds.length));
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.id)).toEqual(healthTileIds.map((id) => 'health-' + id));
    expect(api.GET).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(healthCalls()).toBe(2));
  });
  it.each(['healthy', 'warning', 'error', 'not_configured', 'unavailable'] as const)('renders %s with text, safe details, source link and key reminder', (status) => {
    const backup = healthTileSchema.parse({ id: 'last_backup', status, checkedAt, message: 'Backup check',
      details: { latestRestorableAt: checkedAt, ageSeconds: 60, overdue: false, retainedBytes: 100, retentionBudgetBytes: 1000, pruningStopped: false, keyReminder: true } });
    const version = healthTileSchema.parse({ id: 'version', status, checkedAt, message: 'Version check', details: { version: '0.1.0', sourceUrl: 'https://example.test/source/v0.1.0' } });
    render(<HealthTiles tiles={[backup, version]}/>);
    expect(screen.getByText(/Keep your backup private key safe/)).toBeDefined();
    expect(screen.getByText('Snapshot age (seconds)')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Source code' }).getAttribute('href')).toBe('https://example.test/source/v0.1.0');
    expect(document.body.textContent).not.toContain('health/status:');
  });
  it('displays safe load errors and permits retry', async () => {
    GET.mockRejectedValueOnce(new Error('private SQL password'));
    start();
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load system health');
    expect(document.body.textContent).not.toContain('private SQL');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('heading', { name: 'Email' });
  });
  it.each(['coach', 'front_desk', 'member'] as const)('does not request health for %s', (role) => {
    bootstrap(role === 'member' ? [] : [role]); start();
    expect(screen.getByRole('alert').textContent).toContain('do not have permission');
    expect(api.GET).not.toHaveBeenCalled();
  });
  it('uses separate query caches when the resolved gym changes', async () => {
    const view = start();
    await screen.findByRole('heading', { name: 'Email' });
    bootstrap(['owner'], 'gym-b');
    view.rerender(<QueryClientProvider client={view.client}><HealthPage/></QueryClientProvider>);
    await waitFor(() => expect(healthCalls()).toBe(2));
    expect(view.client.getQueryData(['health', 'gym-a'])).toBeDefined();
    await waitFor(() => expect(view.client.getQueryData(['health', 'gym-b'])).toBeDefined());
  });
});

const uuid = (n: number) => `0198a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const report = (n: number, day: string, failures: { number: number | null; cause: string }[]) =>
  ({ runId: uuid(n), day, reportedAt: day + 'T12:00:00.000Z', failures: failures.map((failure, index) => ({ invoiceId: uuid(n * 10 + index), ...failure })) });
const failuresRegion = () => screen.findByRole('region', { name: 'Failed charges' });
const dismissed = (...ids: string[]) => ok({ data: { dismissed: ids } });
describe('charge failure reports on the charge-run tile', () => {
  const reports = () => [report(1, '2026-10-24', [{ number: 41, cause: 'needs_reconciliation' }, { number: null, cause: 'unexpected' }]),
    report(2, '2026-10-26', [{ number: 52, cause: 'unexpected' }])];
  it('lists each report with its invoices and causes under the tile, and nothing without reports', async () => {
    serve(reports); start();
    const region = within(await failuresRegion());
    expect(region.getByText('Charge run of 2026-10-24')).toBeDefined();
    expect(region.getByText('Charge run of 2026-10-26')).toBeDefined();
    expect(region.getByText('Invoice #41')).toBeDefined();
    expect(region.getByText('Invoice #52')).toBeDefined();
    expect(region.getByText('Invoice not numbered yet')).toBeDefined();
    expect(region.getByText("Waiting for the payment provider's answer")).toBeDefined();
    expect(region.getAllByText('Unexpected error')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('health/status:');
    // The list sits inside the charge-run tile and nowhere else.
    expect(document.getElementById('health-last_charge_run')!.closest('section, article, div')!.contains(await failuresRegion())).toBe(true);
    expect(document.querySelectorAll('[aria-label="Failed charges"]')).toHaveLength(1);
    expect(GET).toHaveBeenCalledWith('/api/health/charge-failures', expect.objectContaining({ cache: 'no-store' }));
  });
  it('shows no list when no report is open', async () => {
    serve(); start();
    await screen.findByRole('heading', { name: 'Last charge run' });
    await waitFor(() => expect(GET).toHaveBeenCalledWith('/api/health/charge-failures', expect.anything()));
    expect(screen.queryByRole('region', { name: 'Failed charges' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull();
  });
  it('dismisses one report without confirmation and reads the tiles and the list again', async () => {
    let open = reports(); serve(() => open);
    POST.mockImplementation(async () => { open = open.slice(1); return dismissed(uuid(10), uuid(11)); });
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss the failed charges of the run of 2026-10-24' }));
    await waitFor(() => expect(screen.queryByText('Charge run of 2026-10-24')).toBeNull());
    expect(POST).toHaveBeenCalledOnce();
    expect(POST).toHaveBeenCalledWith('/api/health/charge-failures/dismiss', { body: { runId: uuid(1) } });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Charge run of 2026-10-26')).toBeDefined();
    expect(healthCalls()).toBe(2);
  });
  it('dismisses every report only after a confirmation, and cancel dismisses nothing', async () => {
    let open = reports(); serve(() => open);
    POST.mockImplementation(async () => { open = []; return dismissed(uuid(10), uuid(11), uuid(20)); });
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss all' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Dismiss all failed charges?' })).toBeDefined();
    expect(POST).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(POST).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Dismiss all' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Failed charges' })).toBeNull());
    expect(POST).toHaveBeenCalledOnce();
    expect(POST).toHaveBeenCalledWith('/api/health/charge-failures/dismiss', { body: {} });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(healthCalls()).toBe(2);
  });
  it('keeps the reports and says so when a dismissal fails, in the dialog and beside a single report', async () => {
    serve(reports);
    POST.mockResolvedValue({ response: new Response(null, { status: 500 }), data: undefined } as never);
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss the failed charges of the run of 2026-10-26' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to dismiss');
    expect(screen.getByText('Charge run of 2026-10-26')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss all' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Unable to dismiss');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByText('Charge run of 2026-10-24')).toBeDefined();
  });
  it('reads the list again when the page is refreshed', async () => {
    let open = [reports()[0]!]; serve(() => open); start();
    await screen.findByText('Charge run of 2026-10-24');
    open = [reports()[1]!];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Charge run of 2026-10-26');
    expect(screen.queryByText('Charge run of 2026-10-24')).toBeNull();
  });
  it('says when the reports cannot be loaded and still shows every tile', async () => {
    GET.mockImplementation(async (path: string) => {
      if (path === '/api/health/charge-failures') throw new Error('private SQL password');
      return ok({ data: { generatedAt: checkedAt, tiles: tiles() } });
    });
    start();
    expect((await screen.findByText(/Unable to load the failed charges/)).textContent).not.toContain('private SQL');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(healthTileIds.length);
  });
  it('keeps each gym\'s reports under its own query key', async () => {
    serve(reports); const view = start();
    await failuresRegion();
    expect(view.client.getQueryData(['health', 'gym-a', 'charge-failures'])).toHaveLength(2);
    expect(view.client.getQueryData(['health', 'gym-b', 'charge-failures'])).toBeUndefined();
  });
});
