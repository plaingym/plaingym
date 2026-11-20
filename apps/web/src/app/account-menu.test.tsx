// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { AccountMenu } from './account-menu.js';
import { resetThemeChoice, themeStorageKey } from '../lib/theme.js';

function renderMenu(shell: 'admin' | 'portal' = 'admin') {
  const root = createRootRoute({ component: () => <AccountMenu
    accountPath={shell === 'admin' ? '/admin/account' : '/portal/account'} onSignOut={vi.fn()} signingOut={false} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/${shell}`] }) });
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
  resetThemeChoice();
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

it('keeps a failed-save pick when the account menu mounts for the other shell', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  const user = userEvent.setup();
  renderMenu('admin');
  const { theme } = await openThemeMenu(user);
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });

  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem(themeStorageKey)).toBeNull();

  setItem.mockClear();
  cleanup();
  renderMenu('portal');
  const otherUser = userEvent.setup();
  const account = await screen.findByRole('button', { name: 'Account' });
  await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
  expect(setItem).not.toHaveBeenCalled();

  await otherUser.click(account);
  const reopened = within(screen.getByRole('group', { name: 'Theme' }));
  expect(reopened.getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();
});

it('lets a valid storage event supersede a failed local pick for later mounts', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  const user = userEvent.setup();
  renderMenu('admin');
  const { theme } = await openThemeMenu(user);
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);

  // The failed pick survives the switch to the portal shell...
  cleanup();
  renderMenu('portal');
  await screen.findByRole('button', { name: 'Account' });
  await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));

  // ...until another tab stores Light and this tab receives its storage event.
  setItem.mockRestore();
  localStorage.setItem(themeStorageKey, 'light');
  fireEvent(window, new StorageEvent('storage', {
    key: themeStorageKey, oldValue: null, newValue: 'light', storageArea: localStorage, url: window.location.href,
  }));
  await waitFor(() => expect(document.documentElement.classList.contains('light')).toBe(true));

  const otherUser = userEvent.setup();
  await otherUser.click(screen.getByRole('button', { name: 'Account' }));
  let menu = within(screen.getByRole('group', { name: 'Theme' }));
  expect(menu.getByRole('radio', { name: 'Light', checked: true })).toBeDefined();
  await otherUser.keyboard('{Escape}');

  cleanup();
  renderMenu('admin');
  await screen.findByRole('button', { name: 'Account' });
  await waitFor(() => expect(document.documentElement.classList.contains('light')).toBe(true));
  await otherUser.click(screen.getByRole('button', { name: 'Account' }));
  menu = within(screen.getByRole('group', { name: 'Theme' }));
  expect(menu.getByRole('radio', { name: 'Light', checked: true })).toBeDefined();
});

it('starts fresh page loads from stored Dark, or System with nothing stored', async () => {
  localStorage.setItem(themeStorageKey, 'dark');
  const user = userEvent.setup();
  renderMenu('admin');
  const account = await screen.findByRole('button', { name: 'Account' });
  await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
  await user.click(account);
  let theme = within(screen.getByRole('group', { name: 'Theme' }));
  expect(theme.getByRole('radio', { name: 'Dark', checked: true })).toBeDefined();
  cleanup();

  localStorage.removeItem(themeStorageKey);
  renderMenu('portal');
  const portalAccount = await screen.findByRole('button', { name: 'Account' });
  await waitFor(() => expect(document.documentElement.classList.contains('theme-system')).toBe(true));
  await user.click(portalAccount);
  theme = within(screen.getByRole('group', { name: 'Theme' }));
  expect(theme.getByRole('radio', { name: 'System', checked: true })).toBeDefined();
});

it('applies the stored theme when the shell mounts, before the menu opens', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  renderMenu();
  await screen.findByRole('button', { name: 'Account' });

  await waitFor(() => expect(document.documentElement.classList.contains('light')).toBe(true));
  expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
});
