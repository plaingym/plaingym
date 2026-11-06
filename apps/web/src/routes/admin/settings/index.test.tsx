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
const session = vi.hoisted(() => ({ roles: ['owner'] as StaffRole[], general: true }));
vi.mock('../../../app/context.js', () => ({
  useBootstrap: () => ({ isPending: false, isError: false, data: { gym: { enabledModules: [] }, session: { roles: session.roles } } }),
  bootstrapKey: ['bootstrap'],
}));
// The page's other sections are not under test: the Google section beside one that always shows.
vi.mock('../../../lib/registries.js', async () => {
  const { registration: auth } = await import('../../../features/settings/auth.registrations.js');
  const general = { id: 'settingsSections.test.general', labelKey: 'settings/settings:general', enabled: true,
    permission: { kind: 'staff', capability: 'integrations.manage' }, component: () => <p>General</p> };
  // A renamed registration must still ask its hook; the page must not depend on a feature id.
  return { createRegistries: () => ({ settingsSections: { forModules: () => [...(session.general ? [general] : []),
    ...(auth.settingsSections ?? []).map((entry) => ({ ...entry, id: 'renamed.auth' }))] } }) };
});

const off: GoogleLogin = { source: 'none', editable: true, unreadable: false, clientId: null, clientSecretSet: false, removeBlocked: false, revision: 3 };
let google: GoogleLogin;
const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SettingsPage/></QueryClientProvider>);
// The empty state is always in the DOM and CSS shows it, which jsdom doesn't apply: check what the rule depends on.
const emptyStateShown = () => {
  const wrapper = screen.getByText(/No settings/i).closest('.hidden');
  return Boolean(wrapper?.classList.contains('only:block') && wrapper.matches(':only-child'));
};
beforeEach(() => {
  google = off; session.roles = ['owner']; session.general = true;
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
    expect(emptyStateShown()).toBe(false);
  });
  it('shows the empty state when no section is listed', async () => {
    google = { ...off, editable: false };
    session.roles = ['coach'];
    page();
    expect(await screen.findByText(/No settings/i)).toBeDefined();
    expect(emptyStateShown()).toBe(true);
    expect(server.GET).not.toHaveBeenCalledWith('/api/settings/integrations/google');
  });
  it('counts a section its hook leaves out as no section, and one it lists as a section', async () => {
    session.general = false;
    google = { ...off, editable: false };
    page();
    await waitFor(() => expect(server.GET).toHaveBeenCalledWith('/api/settings/integrations/google'));
    await waitFor(() => expect(emptyStateShown()).toBe(true));
    expect(screen.queryByRole('region', { name: 'Google sign-in' })).toBeNull();
    cleanup();
    google = off;
    page();
    expect(await screen.findByRole('region', { name: 'Google sign-in' })).toBeDefined();
    expect(emptyStateShown()).toBe(false);
  });
});
