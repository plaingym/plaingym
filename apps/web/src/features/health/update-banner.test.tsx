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
const tile = (over: object) => ({ id: 'update_available', status: 'warning', checkedAt,
  message: 'Version 1.3.0 is available. This install runs 1.2.0. Run the updater on the server to install it.',
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
  it("shows the server's message for a patch that won't install itself, without the updater advice", async () => {
    const message = 'Version 1.2.5, a patch release, has not installed by itself. The release manifest\'s signature didn\'t verify. Do not install this release by hand: wait for a fixed release. This install runs 1.2.0.';
    serve(tile({ message, details: { currentVersion: '1.2.0', latestVersion: '1.2.5', available: true, releaseUrl: 'https://github.com/plaingym/plaingym/releases/tag/v1.2.5' } }));
    start();
    const banner = await screen.findByTestId('update-banner');
    expect(banner.textContent).toContain('Patch release not installed');
    expect(banner.textContent).not.toContain('Update available');
    expect(banner.textContent).toContain('Do not install this release by hand');
    expect(banner.textContent).not.toContain('Run the updater');
  });
  it("heads an invalid release repository for what it says, not as an available update", async () => {
    const message = 'Patch releases cannot install because RELEASE_REPOSITORY is invalid. Set it to a GitHub owner/name, with neither segment made only of dots, and restart the app.';
    serve(tile({ message, details: { currentVersion: '1.2.0', latestVersion: 'unknown', available: true, releaseUrl: null } }));
    start();
    const banner = await screen.findByTestId('update-banner');
    expect(banner.textContent).toContain("Updates can't install");
    expect(banner.textContent).not.toContain('Update available');
    expect(screen.queryByRole('link', { name: 'Changelog' })).toBeNull();
  });
  it('does not keep asking once the server says its read of the release list failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve(tile({ status: 'unavailable', details: null }));
      start();
      await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(GET).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('asks again within a minute while the server has not read the release list yet', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve(tile({ status: 'unavailable', checkedAt: null, details: null }));
      start();
      await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('update-banner')).toBeNull();
      serve(tile({}));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await screen.findByTestId('update-banner')).toBeTruthy();
      expect(GET).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
