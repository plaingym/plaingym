// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createWebRegistries } from '@plaingym/shared';
import { MemberTabs } from '../members/profile.js';
import type { ExtensionView } from '../../lib/registries.js';
import { KioskStandingTab } from './standing.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('explains both billing and credit refusals to staff', async () => {
  const memberId = '00000000-0000-7000-8000-000000000001';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { memberId, status: 'front_desk', reasons: ['past_due', 'no_credits'] } })));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><KioskStandingTab memberId={memberId}/></QueryClientProvider>);
  expect(await screen.findByText('The household has a past-due invoice.')).toBeDefined();
  expect(screen.getByText('The member needs an unexpired class credit or an active or trial membership.')).toBeDefined();
  expect(screen.queryByText(/Another check needs attention/)).toBeNull();
});
it('shows staff without billing access the generic front-desk reason in place of billing reasons', async () => {
  const memberId = '00000000-0000-7000-8000-000000000001';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { memberId, status: 'front_desk', reasons: ['see_front_desk', 'missing_waiver'] } })));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><KioskStandingTab memberId={memberId}/></QueryClientProvider>);
  expect(await screen.findByText('Another check sends this member to the front desk. Front desk staff can see why.')).toBeDefined();
  expect(screen.getByText('A current waiver isn\'t signed.')).toBeDefined();
  expect(screen.queryByText(/Another check needs attention|past-due/)).toBeNull();
});
it('loads only when opened and refreshes after a credit mutation while another tab was open', async () => {
  const memberId = '00000000-0000-7000-8000-000000000001';
  const request = vi.fn()
    .mockResolvedValueOnce(Response.json({ data: { memberId, status: 'front_desk', reasons: ['no_credits'] } }))
    .mockResolvedValueOnce(Response.json({ data: { memberId, status: 'ok', reasons: [] } }));
  vi.stubGlobal('fetch', request);
  const registries = createWebRegistries<ExtensionView>([{ memberTabs: [
    { id: 'standing', labelKey: 'kiosk/standing:title', enabled: true, permission: { kind: 'staff', capability: 'members.read' }, component: KioskStandingTab },
  ] }]);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={cache}><MemberTabs memberId={memberId} roles={['owner']} enabledModules={new Set()}
    overview={<p>Profile content</p>} registries={registries}/></QueryClientProvider>);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'Kiosk check-in' }));
  expect(await screen.findByText('The member needs an unexpired class credit or an active or trial membership.')).toBeDefined();
  fireEvent.click(screen.getByRole('tab', { name: 'Profile' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Kiosk check-in' }));
  expect(await screen.findByText('This member can check in at the kiosk.')).toBeDefined();
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
});
