// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { canStaff, staffRoles } from '@plaingym/shared';
import { healthTileSchema } from '@plaingym/shared/contracts';
import { HealthTiles } from '../health/page.js';
import { AutoUpdateSettings } from './updates.js';
import { registration } from './updates.registrations.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api: client }));
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
let stored = { enabled: true, available: true, revision: 1 };
/** The server's rule: the revision sent must be the current one, and each save moves it on. */
beforeEach(() => {
  stored = { enabled: true, available: true, revision: 1 };
  client.GET.mockReset(); client.PUT.mockReset();
  client.GET.mockImplementation(async () => reply(200, { data: stored }));
  client.PUT.mockImplementation(async (_path: string, { body }: { body: { enabled: boolean; revision: number } }) => {
    if (body.revision !== stored.revision) return reply(409);
    stored = { ...stored, enabled: body.enabled, revision: stored.revision + 1 };
    return reply(200, { data: stored });
  });
});
afterEach(cleanup);
const section = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AutoUpdateSettings/></QueryClientProvider>);
const toggle = async () => await screen.findByRole('checkbox', { name: 'Install patch releases automatically each night' }) as HTMLInputElement;

describe('Settings → Updates', () => {
  it('is registered for owners only', () => {
    const entry = registration.settingsSections?.[0];
    expect(entry).toMatchObject({ enabled: true, labelKey: 'health/auto-update:title', component: AutoUpdateSettings });
    for (const role of staffRoles) expect(canStaff([role], entry!.permission.kind === 'staff' ? entry!.permission.capability : 'settings.manage')).toBe(role === 'owner');
  });
  it('shows the switch on by default and explains what runs each night', async () => {
    section();
    expect((await toggle()).checked).toBe(true);
    expect(screen.getByText(/takes a backup, installs it, checks that the app is healthy/)).toBeDefined();
    expect(client.GET).toHaveBeenCalledWith('/api/health/auto-update', expect.objectContaining({ cache: 'no-store' }));
  });
  it('turns automatic updates off and on with the current revision', async () => {
    const user = userEvent.setup();
    section();
    await user.click(await toggle());
    await waitFor(async () => expect((await toggle()).checked).toBe(false));
    expect(await screen.findByText('Saved.')).toBeDefined();
    await user.click(await toggle());
    await waitFor(async () => expect((await toggle()).checked).toBe(true));
    expect(client.PUT.mock.calls.map(([path, { body }]) => [path, body])).toEqual([
      ['/api/health/auto-update', { enabled: false, revision: 1 }], ['/api/health/auto-update', { enabled: true, revision: 2 }]]);
  });
  it('shows another owner\'s change instead of overwriting it', async () => {
    const user = userEvent.setup();
    section();
    const box = await toggle();
    // Someone else turned it off meanwhile; this page still shows on.
    stored = { ...stored, enabled: false, revision: 2 };
    await user.click(box);
    expect(await screen.findByText('Someone else changed this setting. It now shows their choice.')).toBeDefined();
    await waitFor(async () => expect((await toggle()).checked).toBe(false));
    expect(client.PUT).toHaveBeenCalledTimes(1);
  });
  it('says so when a save fails and keeps the saved value', async () => {
    client.PUT.mockResolvedValue(reply(500));
    const user = userEvent.setup();
    section();
    await user.click(await toggle());
    expect((await screen.findByRole('alert')).textContent).toBe('Unable to save. Try again.');
    expect((await toggle()).checked).toBe(true);
  });
  it('shows a skipped night and its reason on the health page tile', () => {
    const tile = healthTileSchema.parse({ id: 'automatic_updates', status: 'warning', checkedAt: '2026-11-03T16:30:00Z',
      message: 'Version v1.2.4 was not installed. The backup before the update failed. The next nightly check tries again.',
      details: { enabled: true, lastAttemptAt: '2026-11-03T16:05:00Z', result: 'skipped', fromVersion: 'v1.2.3', toVersion: 'v1.2.4' } });
    render(<HealthTiles tiles={[tile]}/>);
    expect(screen.getByRole('heading', { name: 'Automatic updates' })).toBeDefined();
    expect(screen.getByText('Needs attention')).toBeDefined();
    expect(screen.getByText(/The backup before the update failed/)).toBeDefined();
    expect(screen.getByText('Skipped')).toBeDefined();
    expect(screen.getByText('v1.2.4')).toBeDefined();
    expect(screen.getByText('Version not installed')).toBeDefined();
    expect(screen.getByText('Running version')).toBeDefined();
  });
  it('labels the versions for what the attempt did and leaves out a version it has none of', () => {
    const tile = (result: 'up_to_date' | 'updated' | 'rolled_back', toVersion: string | null) => healthTileSchema.parse({ id: 'automatic_updates',
      status: 'healthy', checkedAt: '2026-11-04T16:30:00Z', message: 'Version v1.2.4 is the newest patch release.',
      details: { enabled: true, lastAttemptAt: '2026-11-04T16:05:00Z', result, fromVersion: 'v1.2.4', toVersion } });
    render(<HealthTiles tiles={[tile('up_to_date', null)]}/>);
    expect(screen.getByText('Running version')).toBeDefined();
    expect(screen.getByText('Last check')).toBeDefined();
    expect(screen.queryByText('Updated version')).toBeNull();
    expect(screen.queryByText('Unknown')).toBeNull();
    cleanup();
    render(<HealthTiles tiles={[tile('updated', 'v1.2.5')]}/>);
    expect(screen.getByText('Previous version')).toBeDefined();
    expect(screen.getByText('Updated version')).toBeDefined();
    cleanup();
    render(<HealthTiles tiles={[{ ...tile('rolled_back', 'v1.2.5'), status: 'warning' }]}/>);
    expect(screen.getByText('Tried version')).toBeDefined();
    expect(screen.queryByText('Updated version')).toBeNull();
  });
  it('disables the switch where no timer reads it, and offers a retry when loading fails', async () => {
    stored = { ...stored, available: false };
    section();
    expect((await toggle()).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('install that serves several gyms');
    cleanup();
    client.GET.mockResolvedValueOnce(reply(500));
    section();
    expect(await screen.findByText('Unable to load the update setting. Refresh to try again.')).toBeDefined();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect((await toggle()).checked).toBe(true);
  });
});
