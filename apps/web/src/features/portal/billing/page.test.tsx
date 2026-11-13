// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ShellServicesContext } from '../../../app/context.js';
import type { ShellServices } from '../../../app/services.js';
import { portalHouseholdsKey, portalLoginKey } from '../household/api.js';
import { portalTestCache } from '../household/test-cache.test-helper.js';
import { PortalBillingPage } from './page.js';
import { registration } from './registrations.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const gymId = id(1), userId = id(2), householdId = id(3);
const row = { memberId: id(4), firstName: 'Alex', lastName: 'Rivera', balance: 7, soonestExpiry: '2026-11-12T08:00:00Z' };
function mount({ data = [row], role = 'payer', answeredFor = householdId, fail = false }: {
  data?: (typeof row | Omit<typeof row, 'soonestExpiry'> & { soonestExpiry: null })[];
  role?: 'payer' | 'member'; answeredFor?: string; fail?: boolean;
} = {}) {
  const cache = portalTestCache(gymId, userId, householdId, { defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(portalHouseholdsKey(portalLoginKey(gymId, userId)), { current: householdId, households: [{ householdId, name: 'Rivera', role }] });
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    if (path === '/api/portal/context') return Response.json({ data: { role, memberId: role === 'member' ? row.memberId : null }, householdId });
    if (path === '/api/portal/credits') return fail ? new Response(null, { status: 503 }) : Response.json({ data, householdId: answeredFor });
    if (path.startsWith('/api/portal/invoices?')) return Response.json({ data: [], pagination: { limit: 20, offset: 0, total: 0 }, householdId });
    if (path === '/api/portal/payment-methods') return Response.json({ data: [], householdId });
    return new Response(null, { status: 503 });
  });
  vi.stubGlobal('fetch', fetcher);
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: gymId, name: 'Test Gym', timezone: 'America/Los_Angeles', currency: 'USD', enabledModules: [] },
    session: { userId, displayName: 'Alex', roles: [], member: true }, login: { password: true, magicLink: false } }),
    signOut: vi.fn(), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  render(<ShellServicesContext.Provider value={services}><QueryClientProvider client={cache}><PortalBillingPage /></QueryClientProvider></ShellServicesContext.Provider>);
  return { cache, fetcher };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows each balance and the soonest expiry in the gym timezone beside payer billing', async () => {
  mount({ data: [row, { ...row, memberId: id(5), firstName: 'Kim', balance: 1, soonestExpiry: null }] });
  expect(await screen.findByText('7 classes left')).toBeTruthy();
  expect(screen.getByText('Alex Rivera')).toBeTruthy();
  expect(screen.getByText('Kim Rivera')).toBeTruthy();
  expect(screen.getByText('1 class left')).toBeTruthy();
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'America/Los_Angeles' }).format(new Date(Date.parse(row.soonestExpiry) - 1));
  expect(screen.getByText('Next credits expire: use by ' + date)).toBeTruthy();
  expect(screen.getAllByText(/^Next credits expire:/)).toHaveLength(1);
  expect(screen.getByRole('heading', { name: 'Invoices' })).toBeTruthy();
});

it('lets adult members read credits without fetching or showing invoices, cards or payment actions', async () => {
  const f = mount({ role: 'member' });
  expect(await screen.findByText('7 classes left')).toBeTruthy();
  expect(f.fetcher.mock.calls.map(([path]) => String(path))).toEqual(expect.arrayContaining(['/api/portal/credits', '/api/portal/context']));
  expect(screen.queryByRole('heading', { name: 'Invoices' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Saved cards' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Pay|card/ })).toBeNull();
  expect(registration.portalNav?.[0]?.permission).toEqual({ kind: 'member', capability: 'profile.read' });
  expect(registration.portalPages?.[0]?.permission).toEqual({ kind: 'member', capability: 'profile.read' });
});

it('hides the credits card when no visible member has usable credits', async () => {
  const f = mount({ data: [] });
  await waitFor(() => expect(f.cache.getQueryData(['portal', gymId, userId, 'household', householdId, 'billing', 'credits'])).toEqual([]));
  expect(screen.queryByRole('heading', { name: 'Class credits' })).toBeNull();
  expect(screen.queryByText(/classes? left/)).toBeNull();
});

it('tells an adult member without credits so, instead of leaving the page blank', async () => {
  mount({ role: 'member', data: [] });
  expect(await screen.findByText('No class credits')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Class credits' })).toBeTruthy();
});

it('offers retry for a failed balance read', async () => {
  const f = mount({ role: 'member', fail: true });
  const retry = await screen.findByRole('button', { name: 'Try again' });
  fireEvent.click(retry);
  await waitFor(() => expect(f.fetcher.mock.calls.filter(([path]) => path === '/api/portal/credits')).toHaveLength(2));
});

it('never displays or caches a balance answered for another household', async () => {
  const f = mount({ role: 'member', answeredFor: id(99) });
  await waitFor(() => expect(f.fetcher.mock.calls.some(([path]) => path === '/api/portal/households')).toBe(true));
  expect(screen.queryByText('7 classes left')).toBeNull();
  expect(f.cache.getQueryData(['portal', gymId, userId, 'household', householdId, 'billing', 'credits'])).toBeUndefined();
});

it.each(['2026-03-09T07:00:00Z', '2026-11-02T08:00:00Z'])('names the last usable gym-local day across DST for %s', async soonestExpiry => {
  mount({ data: [{ ...row, soonestExpiry }] });
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'America/Los_Angeles' }).format(new Date(Date.parse(soonestExpiry) - 1));
  expect(await screen.findByText('Next credits expire: use by ' + date)).toBeDefined();
});
it('uses the current context role while the household list still caches a payer role', async () => {
  const f = mount({ role: 'member' });
  f.cache.setQueryData(portalHouseholdsKey(portalLoginKey(gymId, userId)), { current: householdId, households: [{ householdId, name: 'Rivera', role: 'payer' }] });
  await screen.findByText('7 classes left');
  await waitFor(() => expect(f.cache.getQueryData(['portal', gymId, userId, 'household', householdId, 'context'])).toMatchObject({ role: 'member' }));
  expect(screen.queryByRole('heading', { name: 'Invoices' })).toBeNull();
  expect(f.fetcher.mock.calls.some(([path]) => String(path).startsWith('/api/portal/invoices'))).toBe(false);
});
