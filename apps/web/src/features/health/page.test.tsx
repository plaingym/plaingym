// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import type { ShellBootstrap } from '../../app/services.js';
import { healthTileIds, healthTileSchema, type HealthTile } from '@plaingym/shared/contracts';
import { HealthPage, HealthTiles } from './page.js';
import { useBootstrap } from '../../app/context.js';
import { api } from '../../lib/api.js';
vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn() } }));
const checkedAt = '2026-10-22T12:00:00Z';
const tiles = (): HealthTile[] => healthTileIds.map((id) => ({ id, status: 'not_configured', details: null, checkedAt: null, message: 'Not set up' }));
function bootstrap(roles: StaffRole[] = ['owner'], gymId = 'gym-a') {
  const data: ShellBootstrap = { gym: { id: gymId, name: 'Academy', enabledModules: [] }, session: { userId: 'owner', roles, member: false }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], queryFn: async () => data, initialData: data }).getCurrentResult());
}
function start() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><HealthPage/></QueryClientProvider>);
  return { ...view, client };
}
beforeEach(() => { bootstrap(); vi.mocked(api.GET).mockResolvedValue({ response: new Response(), data: { data: { generatedAt: checkedAt, tiles: tiles() } } } as Awaited<ReturnType<typeof api.GET>>); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('health page', () => {
  it('renders every contracted tile in order, including not set up tiles', async () => {
    start();
    expect(await screen.findByRole('heading', { name: 'System health' })).toBeDefined();
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(healthTileIds.length));
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.id)).toEqual(healthTileIds.map((id) => 'health-' + id));
    expect(api.GET).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
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
    vi.mocked(api.GET).mockRejectedValueOnce(new Error('private SQL password'));
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
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
    expect(view.client.getQueryData(['health', 'gym-a'])).toBeDefined();
    await waitFor(() => expect(view.client.getQueryData(['health', 'gym-b'])).toBeDefined());
  });
});
