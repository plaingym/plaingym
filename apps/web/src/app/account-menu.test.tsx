// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { AccountMenu } from './account-menu.js';
import { themeStorageKey } from '../lib/theme.js';

function renderMenu() {
  const root = createRootRoute({ component: () => <AccountMenu accountPath={undefined} onSignOut={vi.fn()} signingOut={false} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/admin'] }) });
  render(<RouterProvider router={router} />);
  return router;
}

async function openThemeMenu(user: ReturnType<typeof userEvent.setup>) {
  const account = await screen.findByRole('button', { name: 'Account' });
  await user.click(account);
  return { account, theme: within(screen.getByRole('group', { name: 'Theme' })) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove('theme-system', 'light', 'dark');
});

it('keeps a failed-save pick across menu close and reopen when the stale key can be cleared', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  const user = userEvent.setup();
  renderMenu();
  const { account, theme } = await openThemeMenu(user);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });

  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem(themeStorageKey)).toBeNull();

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
  await user.click(account);

  const reopened = within(screen.getByRole('group', { name: 'Theme' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(reopened.getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();
});

it('keeps a failed-save pick across menu close and reopen when the stale key cannot be cleared', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  const user = userEvent.setup();
  renderMenu();
  const { account, theme } = await openThemeMenu(user);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('read-only'); });

  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem(themeStorageKey)).toBe('light');

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
  await user.click(account);

  const reopened = within(screen.getByRole('group', { name: 'Theme' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(reopened.getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();
});

it('applies another tab theme change while the menu is closed', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  renderMenu();
  await screen.findByRole('button', { name: 'Account' });
  expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();

  localStorage.setItem(themeStorageKey, 'dark');
  fireEvent(window, new StorageEvent('storage', {
    key: themeStorageKey, oldValue: 'light', newValue: 'dark', storageArea: localStorage, url: window.location.href,
  }));

  await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
  expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Account' }));
  expect(within(screen.getByRole('group', { name: 'Theme' })).getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();
});

it('applies the stored theme when the shell mounts, before the menu opens', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  renderMenu();
  await screen.findByRole('button', { name: 'Account' });

  await waitFor(() => expect(document.documentElement.classList.contains('light')).toBe(true));
  expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
});
