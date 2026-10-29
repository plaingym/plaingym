// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory } from '@tanstack/react-router';
import type { NavigationEntry } from '@plaingym/shared';
import { App } from '../../../app.js';
import { createAppRouter } from '../../../app/router.js';
import type { ShellServices } from '../../../app/services.js';
import { portalNavigation } from './shell.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('filters disabled, staff, payer-only and inactive-module navigation for adult members', () => {
  const self: NavigationEntry = { id: 'self', href: '/portal', labelKey: 'Self', enabled: true, permission: { kind: 'member', capability: 'profile.read' } };
  const payer: NavigationEntry = { ...self, id: 'payer', permission: { kind: 'member', capability: 'billing.manage' } };
  const entries = [self, payer, { ...self, id: 'disabled', enabled: false }, { ...self, id: 'module', moduleId: 'disabled' }, { ...self, id: 'staff', permission: { kind: 'staff' as const, capability: 'members.read' as const } }];
  expect(portalNavigation(entries, 'member', []).map(row => row.id)).toEqual(['self']);
  expect(portalNavigation(entries, 'payer', []).map(row => row.id)).toEqual(['self', 'payer']);
});
it('loads member context, renders the portal, and clears access when signing out', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  const userId = '00000000-0000-7000-8000-000000000001', householdId = '00000000-0000-7000-8000-000000000002';
  const fetcher = vi.fn(async (path: string) => Response.json(path === '/api/demo' ? { data: { mode: 'disabled' } } : { data: { role: 'payer', householdId, memberId: null } }));
  vi.stubGlobal('fetch', fetcher);
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: userId, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId, roles: [], member: true }, login: { password: true, magicLink: false } }), signOut: vi.fn(async () => undefined), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/portal'] })); render(<App services={services} router={router} />);
  expect(await screen.findByRole('heading', { name: 'Welcome to your member portal' })).toBeDefined();
  expect(fetcher).toHaveBeenCalledWith('/api/portal/context', expect.objectContaining({ credentials: 'same-origin' }));
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Menu' }));
  expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('true');
  await user.keyboard('{Escape}'); expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false');
  await user.click(screen.getByRole('button', { name: 'Sign out' })); await waitFor(() => expect(services.signOut).toHaveBeenCalledOnce());
});
