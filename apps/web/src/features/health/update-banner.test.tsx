// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { UpdateBanner } from './update-banner.js';

vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn() } }));
const GET = vi.mocked(api.GET) as unknown as ReturnType<typeof vi.fn>;
const checkedAt = '2026-11-03T12:00:00Z';
const tile = (over: object) => ({ id: 'update_available', status: 'warning', checkedAt, message: 'm',
  details: { currentVersion: '1.2.0', latestVersion: '1.3.0', available: true, releaseUrl: 'https://github.com/plaingym/plaingym/releases/tag/v1.3.0' }, ...over });
const serve = (data: unknown, ok = true) => GET.mockResolvedValue({ response: new Response(null, { status: ok ? 200 : 502 }), data: { data } } as never);
function start() {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}><UpdateBanner gymId="gym-a" /></QueryClientProvider>);
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('update banner', () => {
  it('names both versions and links the changelog for a newer minor or major', async () => {
    serve(tile({}));
    start();
    const banner = await screen.findByTestId('update-banner');
    expect(banner.textContent).toContain('Update available');
    expect(banner.textContent).toContain('Version 1.3.0 is available. This install runs 1.2.0.');
    const link = screen.getByRole('link', { name: 'Changelog' });
    expect(link.getAttribute('href')).toBe('https://github.com/plaingym/plaingym/releases/tag/v1.3.0');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(GET).toHaveBeenCalledWith('/api/health/update', expect.objectContaining({ cache: 'no-store' }));
  });
  it('shows nothing when current, for a patch release, when unavailable or when the request fails', async () => {
    const quiet = [
      tile({ status: 'healthy', details: { currentVersion: '1.2.0', latestVersion: '1.2.4', available: false, releaseUrl: null } }),
      tile({ status: 'unavailable', details: null }),
      tile({ status: 'not_configured', checkedAt: null, details: null }),
    ];
    for (const data of quiet) {
      serve(data);
      const view = start();
      await waitFor(() => expect(GET).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(screen.queryByTestId('update-banner')).toBeNull();
      view.unmount(); GET.mockReset();
    }
    serve(null, false);
    start();
    await waitFor(() => expect(GET).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });
});
