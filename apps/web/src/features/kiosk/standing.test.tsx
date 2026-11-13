// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
