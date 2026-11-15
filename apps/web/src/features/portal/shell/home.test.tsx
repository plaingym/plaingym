// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { portalTestCache } from '../household/test-cache.test-helper.js';
import type { PortalClient } from '../schedule/client.js';
import { PortalHome } from './home.js';

vi.mock('../../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { id: 'gym', timezone: 'UTC' }, session: { userId: 'user' } } }) }));
vi.mock('@tanstack/react-router', async importOriginal => ({ ...await importOriginal<object>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a> }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
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
      total: empty ? 0 : url.pathname === '/api/portal/invoices' ? 1200 : 2400 } });
  });
  vi.stubGlobal('fetch', fetcher);
  const cache = portalTestCache('gym', 'user', householdId, { defaultOptions: { queries: { retry: false } } });
  const view = () => render(<QueryClientProvider client={cache}><PortalHome client={client as unknown as PortalClient} /></QueryClientProvider>);
  return { client, fetcher, view, cache };
}
it('shows the next booked class, check-in shortcut, pending work and selected member rank', async () => {
  const f = fixture(); f.view();
  await screen.findByText('Evening fundamentals');
  expect(screen.queryByText('Waitlisted class')).toBeNull(); expect(screen.queryByText('Cancelled class')).toBeNull();
  expect(await screen.findByText('Unsigned waivers: 2,400')).toBeDefined();
  expect(await screen.findByText('Unpaid invoices: 2,400')).toBeDefined();
  expect(await screen.findByText('Current: First')).toBeDefined(); expect(screen.getByText('Next: Second')).toBeDefined();
  expect(screen.getByRole('link', { name: 'Show check-in code' }).getAttribute('href')).toBe('/portal/checkin');
  expect(f.client.schedule).toHaveBeenCalledTimes(1);
  const [from, to] = f.client.schedule.mock.calls[0] as unknown as [string, string];
  expect(Date.parse(to) - Date.parse(from)).toBe(7 * 86_400_000);
  expect(f.fetcher.mock.calls.every(([, init]) => new Headers((init as RequestInit | undefined)?.headers).get('X-Portal-Household') === householdId)).toBe(true);
});
it.each([1_000, 29 * 86_400_000])('moves to the next booked class after %s ms without a focus or cache event', async untilStart => {
  vi.useFakeTimers();
  const f = fixture(), now = Date.now();
  f.client.schedule.mockResolvedValue(answer([
    { id: 'first', name: 'Starting class', startsAt: new Date(now + untilStart).toISOString(), status: 'scheduled', bookings: [{ id: 'a', memberId, status: 'booked' }] },
    { id: 'next', name: 'Next booking', startsAt: new Date(now + untilStart + 60_000).toISOString(), status: 'scheduled', bookings: [{ id: 'b', memberId, status: 'booked' }] },
  ]));
  f.view();
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(screen.getByText('Starting class')).toBeDefined();
  await act(() => vi.advanceTimersByTimeAsync(untilStart - 51));
  expect(screen.getByText('Starting class')).toBeDefined();
  expect(f.client.schedule).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(101));
  expect(screen.queryByText('Starting class')).toBeNull();
  expect(screen.getByText('Next booking')).toBeDefined();
  expect(f.client.schedule).toHaveBeenCalledTimes(2);
});
it('never requests or renders invoice summaries for a non-payer', async () => {
  const f = fixture('member'); f.view(); await screen.findByText('Unsigned waivers: 2,400');
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
it('reads the remaining month only when the first week has no booked class', async () => {
  const f = fixture('payer', true);
  const startsAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  f.client.schedule.mockResolvedValueOnce(answer([])).mockResolvedValueOnce(answer([
    { id: 'later', name: 'Later booking', startsAt, status: 'scheduled', bookings: [{ id: 'b', memberId, status: 'booked' }] },
  ]));
  f.view(); await screen.findByText('Later booking');
  expect(f.client.schedule).toHaveBeenCalledTimes(2);
  const calls = f.client.schedule.mock.calls as unknown as [string, string][];
  expect(calls[1]![0]).toBe(calls[0]![1]);
  expect(Date.parse(calls[1]![1]) - Date.parse(calls[0]![0])).toBe(30 * 86_400_000);
});
it('recomputes the window when a home left open for over a month refetches', async () => {
  const f = fixture('payer', true), mountedAt = Date.now();
  const now = vi.spyOn(Date, 'now').mockReturnValue(mountedAt);
  f.view(); await screen.findByText('No booked classes in the next 30 days.');
  now.mockReturnValue(mountedAt + 40 * 86_400_000);
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  f.client.schedule.mockClear().mockResolvedValue(answer([
    { id: 'later', name: 'Booking after a long stay', startsAt, status: 'scheduled', bookings: [{ id: 'b', memberId, status: 'booked' }] },
  ]));
  await act(() => f.cache.invalidateQueries({ predicate: query => query.queryKey.includes('schedule') }));
  await screen.findByText('Booking after a long stay');
  expect((f.client.schedule.mock.calls[0] as unknown as [string])[0]).toBe(new Date(Date.now()).toISOString());
  expect(f.client.schedule).toHaveBeenCalledTimes(1);
});
