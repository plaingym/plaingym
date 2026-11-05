// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GoogleLogin } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';
import { registration } from '../../../features/settings/auth.registrations.js';
import { reply, settings } from '../../../features/settings/integrations/fixtures.test-helper.js';
import { SettingsPage } from './index.js';

const server = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../../lib/api.js', async (original) => ({ ...await original<typeof import('../../../lib/api.js')>(), api: server, createApiClient: () => server }));
const session = vi.hoisted(() => ({ roles: ['owner'] as StaffRole[] }));
vi.mock('../../../app/context.js', () => ({
  useBootstrap: () => ({ isPending: false, isError: false, data: { gym: { enabledModules: [] }, session: { roles: session.roles } } }),
  bootstrapKey: ['bootstrap'],
}));
// The page's other sections are not under test: the Google section beside one that always shows.
vi.mock('../../../lib/registries.js', async () => {
  const { registration: auth } = await import('../../../features/settings/auth.registrations.js');
  const general = { id: 'settingsSections.test.general', labelKey: 'settings/settings:general', enabled: true,
    permission: { kind: 'staff', capability: 'integrations.manage' }, component: () => <p>General</p> };
  return { createRegistries: () => ({ settingsSections: { forModules: () => [general, ...(auth.settingsSections ?? [])] } }) };
});

const off: GoogleLogin = { source: 'none', editable: true, clientId: null, clientSecretSet: false, removeBlocked: false, revision: 3 };
let google: GoogleLogin;
const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SettingsPage/></QueryClientProvider>);
beforeEach(() => {
  google = off; session.roles = ['owner'];
  server.GET.mockReset();
  server.GET.mockImplementation(async (path: string) => path === '/api/settings' ? reply(200, { data: settings }) : reply(200, { data: google }));
});
afterEach(cleanup);

describe('the settings page and the Google sign-in section', () => {
  it('is registered for owners', () => {
    expect(registration.settingsSections?.[0]).toMatchObject({ id: 'settingsSections.settings.auth', permission: { capability: 'integrations.manage' } });
  });
  it('lists the section where the gym has a client, or can enter one', async () => {
    page();
    expect(await screen.findByRole('region', { name: 'Google sign-in' })).toBeDefined();
    cleanup();
    google = { ...off, source: 'install', editable: false };
    page();
    expect(await screen.findByRole('region', { name: 'Google sign-in' })).toBeDefined();
  });
  it('leaves the section out where the gym can’t have Google sign-in, so the page counts only what it shows', async () => {
    google = { ...off, editable: false };
    const view = page();
    await waitFor(() => expect(server.GET).toHaveBeenCalledWith('/api/settings/integrations/google'));
    expect(await screen.findByText('General')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Google sign-in' })).toBeNull();
    expect(view.container.querySelectorAll('section')).toHaveLength(1);
  });
  it('shows the empty state when no section is listed', async () => {
    google = { ...off, editable: false };
    session.roles = ['coach'];
    page();
    expect(await screen.findByText(/No settings/i)).toBeDefined();
    expect(server.GET).not.toHaveBeenCalledWith('/api/settings/integrations/google');
  });
});
