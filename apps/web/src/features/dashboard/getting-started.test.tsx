// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import { api } from '../../lib/api.js';
import { GettingStarted } from './getting-started.js';

vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn() } }));
const checklist = (status = 'needs_attention') => ({ data: { revision: 3, billingEnabled: false, memberEmailsEnabled: false,
  items: [{ id: 'members_imported', status, message: 'Members' }] } });
function start(roles: StaffRole[] = ['owner'], gymId = 'gym-a') {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { cache, ...render(<QueryClientProvider client={cache}><GettingStarted gymId={gymId} roles={roles}/></QueryClientProvider>) };
}
beforeEach(() => { vi.mocked(api.GET).mockReset().mockResolvedValue({ response: new Response(), data: checklist() } as Awaited<ReturnType<typeof api.GET>>); });
afterEach(cleanup);
describe('getting started on an empty gym dashboard', () => {
  it('offers classes, plans, adding or importing members and the go-live checklist', async () => {
    start();
    await screen.findByRole('heading', { name: 'Get your gym ready' });
    for (const [name, href] of [['Add classes', '/admin/schedule'], ['Add membership plans', '/admin/billing/plans'],
      ['Add members', '/admin/members'], ['Import members', '/admin/imports'], ['Review go-live checklist', '/admin/settings#settingsSections.settings.go-live']] as const) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(href);
    }
    expect(api.GET).toHaveBeenCalledWith('/api/settings/go-live', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  });
  it('hides once the gym has members, including a roster with no active members', async () => {
    vi.mocked(api.GET).mockResolvedValue({ response: new Response(), data: checklist('ready') } as Awaited<ReturnType<typeof api.GET>>);
    const { cache } = start();
    await waitFor(() => expect(cache.getQueryState(['dashboard-getting-started', 'gym-a', ['owner']])?.status).toBe('success'));
    expect(screen.queryByRole('heading')).toBeNull();
    // A roster with members stops polling the checklist.
    const query = cache.getQueryCache().find({ queryKey: ['dashboard-getting-started', 'gym-a', ['owner']] })!;
    const interval = query.observers[0]!.options.refetchInterval;
    expect(typeof interval === 'function' ? interval(query) : interval).toBe(false);
  });
  it.each<StaffRole[]>([['coach'], ['front_desk']])('does not read owner readiness for %s', (role) => {
    start([role]);
    expect(api.GET).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading')).toBeNull();
  });
  it('hides instead of inventing readiness after a failed read', async () => {
    vi.mocked(api.GET).mockRejectedValue(new Error('private detail'));
    const { cache } = start();
    await waitFor(() => expect(cache.getQueryState(['dashboard-getting-started', 'gym-a', ['owner']])?.status).toBe('error'));
    expect(screen.queryByRole('heading')).toBeNull();
    expect(document.body.textContent).not.toContain('private detail');
  });
  it('uses a new cache entry when the gym changes', async () => {
    const view = start(); await screen.findByRole('heading');
    view.rerender(<QueryClientProvider client={view.cache}><GettingStarted gymId="gym-b" roles={['owner']}/></QueryClientProvider>);
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
    expect(view.cache.getQueryData(['dashboard-getting-started', 'gym-a', ['owner']])).toBeDefined();
  });
});
