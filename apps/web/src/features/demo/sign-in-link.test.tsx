// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { ShellServicesContext } from '../../app/context.js';
import { createShellServices } from '../../app/services.js';
import { t } from '../../lib/i18n.js';

vi.mock('@tanstack/react-router', () => ({ useRouterState: () => '/login' }));
const fetcher = vi.fn(async path => {
  if (path === '/api/demo') return Response.json({ data: { mode: 'showcase', expiresAt: '2099-01-01T00:00:00.000Z', join: false } });
  if (path === '/api/demo/menu') return Response.json({ data: { members: [], website: false } });
  return new Response(null, { status: 500 });
});
vi.stubGlobal('fetch', fetcher);
const { DemoShell, useDemoLogin } = await import('./notice.js');
const { DemoShowcaseSignIn } = await import('./sign-in-link.js');

afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const services = createShellServices(async () => ({
    gym: { id: '019a0000-0000-7000-8000-0000000000ab', name: 'Demo gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
    session: null, login: { password: false, magicLink: true },
  }));
  return function Wrapper({ children }: { children: ReactNode }) {
    return <StrictMode><QueryClientProvider client={client}>
      <ShellServicesContext.Provider value={services}><DemoShell>{children}</DemoShell></ShellServicesContext.Provider>
    </QueryClientProvider></StrictMode>;
  };
}

it('moves a single role sign-in error between the showcase card, menu and fallback bar', async () => {
  const view = render(<section aria-label="Showcase sign-in"><DemoShowcaseSignIn /></section>, { wrapper: createWrapper() });
  const bar = await screen.findByRole('complementary', { name: t('demo/demo:controls') });
  const card = screen.getByRole('region', { name: 'Showcase sign-in' });
  const menuButton = within(bar).getByRole('button', { name: t('demo/demo:menu') });
  fireEvent.click(within(card).getByRole('button', { name: t('demo/demo:owner') }));
  const alert = await within(card).findByRole('alert');
  expect(alert.textContent).toBe(t('demo/demo:error'));
  expect(document.activeElement).toBe(alert);
  expect(screen.getAllByRole('alert')).toEqual([alert]);
  expect(within(bar).queryByRole('alert')).toBeNull();

  menuButton.focus();
  fireEvent.click(menuButton);
  const menu = screen.getByRole('dialog', { name: t('demo/demo:menu') });
  expect(screen.getAllByRole('alert')).toEqual([within(menu).getByRole('alert')]);
  expect(card.querySelector('[role="alert"]')).toBeNull();

  fireEvent.click(within(menu).getByRole('button', { name: t('demo/demo:closeMenu') }));
  expect(screen.getAllByRole('alert')).toEqual([within(card).getByRole('alert')]);
  expect(document.activeElement).toBe(menuButton);
  expect(within(bar).queryByRole('alert')).toBeNull();

  view.rerender(<p>Other page</p>);
  expect(screen.getAllByRole('alert')).toEqual([within(bar).getByRole('alert')]);
});

function TriggerSignIn() {
  const { login } = useDemoLogin();
  return <button type="button" onClick={() => { void login('owner'); }}>Trigger sign-in</button>;
}

it('focuses the showcase card alert when mounted while a sign-in error already exists', async () => {
  const view = render(<TriggerSignIn />, { wrapper: createWrapper() });
  const bar = await screen.findByRole('complementary', { name: t('demo/demo:controls') });
  fireEvent.click(screen.getByRole('button', { name: 'Trigger sign-in' }));
  await within(bar).findByRole('alert');

  view.rerender(<section aria-label="Showcase sign-in"><DemoShowcaseSignIn /></section>);
  const card = screen.getByRole('region', { name: 'Showcase sign-in' });
  const alert = within(card).getByRole('alert');
  expect(document.activeElement).toBe(alert);
});

it('closes the menu after a failed sign-in without taking focus from the Demo menu button', async () => {
  render(<section aria-label="Showcase sign-in"><DemoShowcaseSignIn /></section>, { wrapper: createWrapper() });
  const bar = await screen.findByRole('complementary', { name: t('demo/demo:controls') });
  const card = screen.getByRole('region', { name: 'Showcase sign-in' });
  const menuButton = within(bar).getByRole('button', { name: t('demo/demo:menu') });
  menuButton.focus();
  fireEvent.click(menuButton);
  const menu = screen.getByRole('dialog', { name: t('demo/demo:menu') });
  fireEvent.click(within(menu).getByRole('button', { name: t('demo/demo:owner') }));
  await within(menu).findByRole('alert');
  fireEvent.click(within(menu).getByRole('button', { name: t('demo/demo:closeMenu') }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(within(card).getByRole('alert')).toBeDefined();
  expect(document.activeElement).toBe(menuButton);
});
