// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { portalTestCache } from '../household/test-cache.test-helper.js';
import type { PortalClient } from '../schedule/client.js';
import { PortalHome } from './home.js';

vi.mock('../../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { id: 'gym', timezone: 'UTC' }, session: { userId: 'user' } } }) }));
vi.mock('@tanstack/react-router', async importOriginal => ({ ...await importOriginal<object>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const memberId = '00000000-0000-7000-8000-000000000001';
const householdId = '00000000-0000-7000-8000-000000000002';
const answer = <T,>(data: T) => ({ data, householdId });
function fixture(role: 'payer' | 'member' = 'payer', empty = false) {
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  const client = {
    context: vi.fn(async () => answer({ role, memberId })),
    members: vi.fn(async () => answer([{ id: memberId, name: 'Casey Example' }])),
    schedule: vi.fn(async () => answer(empty ? [] : [
      { id: 'waitlist', name: 'Waitlisted class', startsAt: new Date().toISOString(), status: 'scheduled', bookings: [{ id: 'w', memberId, status: 'waitlisted' }] },
      { id: 'cancelled', name: 'Cancelled class', startsAt, status: 'cancelled', bookings: [{ id: 'c', memberId, status: 'booked' }] },
      { id: 'class', name: 'Evening fundamentals', startsAt, status: 'scheduled', bookings: [{ id: 'b', memberId, status: 'booked' }] },
    ])),
    progress: vi.fn(async () => answer({ history: [], criteria: [], programs: empty ? [] : [{ id: 'program', name: 'Grappling', current: { rankId: 'first', subRank: 0 }, next: { rankId: 'next', subRank: 0 } }],
      ranks: [{ id: 'first', name: 'First', subRanks: [] }, { id: 'next', name: 'Second', subRanks: [] }] })),
  };
  const fetcher = vi.fn(async (path: string, _init?: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    return Response.json({ householdId, data: [], pagination: { limit: 1, offset: 0,
      total: empty ? 0 : url.pathname === '/api/portal/invoices' ? 1 : 2 } });
  });
  vi.stubGlobal('fetch', fetcher);
  const cache = portalTestCache('gym', 'user', householdId, { defaultOptions: { queries: { retry: false } } });
  const view = () => render(<QueryClientProvider client={cache}><PortalHome client={client as unknown as PortalClient} /></QueryClientProvider>);
  return { client, fetcher, view };
}
it('shows the next booked class, check-in shortcut, pending work and selected member rank', async () => {
  const f = fixture(); f.view();
  await screen.findByText('Evening fundamentals');
  expect(screen.queryByText('Waitlisted class')).toBeNull(); expect(screen.queryByText('Cancelled class')).toBeNull();
  expect(await screen.findByText('Unsigned waivers: 2')).toBeDefined();
  expect(await screen.findByText('Unpaid invoices: 2')).toBeDefined();
  expect(await screen.findByText('Current: First')).toBeDefined(); expect(screen.getByText('Next: Second')).toBeDefined();
  expect(screen.getByRole('link', { name: 'Show check-in code' }).getAttribute('href')).toBe('/portal/checkin');
  expect(f.fetcher.mock.calls.every(([, init]) => new Headers((init as RequestInit | undefined)?.headers).get('X-Portal-Household') === householdId)).toBe(true);
});
it('never requests or renders invoice summaries for a non-payer', async () => {
  const f = fixture('member'); f.view(); await screen.findByText('Unsigned waivers: 2');
  expect(f.fetcher.mock.calls.some(([path]) => path.includes('/invoices'))).toBe(false);
  expect(screen.queryByRole('link', { name: 'View invoices' })).toBeNull();
  expect(f.fetcher.mock.calls.some(([path]) => path.startsWith('/api/portal/waivers/pending'))).toBe(true);
});
it('shows explicit empty summaries without a misleading pending task', async () => {
  const f = fixture('payer', true); f.view();
  await screen.findByText('No booked classes in the next 30 days.');
  await screen.findByText('Your waivers are up to date.'); await screen.findByText('No unpaid invoices.'); await screen.findByText('No rank progress yet.');
});
it('keeps other summaries and the shortcut usable when the schedule fails', async () => {
  const f = fixture(); f.client.schedule.mockRejectedValue(new Error('unavailable')); f.view();
  await screen.findByRole('button', { name: 'Try again' }); await screen.findByText('Current: First');
  expect(screen.queryByText('No booked classes in the next 30 days.')).toBeNull();
});
it('never renders a schedule answer for another household', async () => {
  const f = fixture(); f.client.schedule.mockResolvedValue({ householdId: 'other', data: [{ id: 'other', name: 'Private class', startsAt: new Date().toISOString(), status: 'scheduled', bookings: [{ id: 'b', memberId, status: 'booked' }] }] });
  f.view(); await waitFor(() => expect(f.client.schedule).toHaveBeenCalled());
  await screen.findByRole('button', { name: 'Try again' });
  expect(screen.queryByText('Private class')).toBeNull();
});
