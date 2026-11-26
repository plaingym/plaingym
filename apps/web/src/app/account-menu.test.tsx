// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { AccountMenu } from './account-menu.js';
import { resetThemeChoice, themeStorageKey } from '../lib/theme.js';

function renderMenu(shell: 'admin' | 'portal' = 'admin', onSignOut: () => void = vi.fn(), signingOut = false) {
  const root = createRootRoute({ component: () => <AccountMenu
    accountPath={shell === 'admin' ? '/admin/account' : '/portal/account'} onSignOut={onSignOut} signingOut={signingOut} /> });
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
  sessionStorage.clear();
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

it.each([
  { clear: 'succeeds', stored: null },
  { clear: 'fails', stored: 'light' },
])('keeps a failed-save pick on the other shell when clearing storage $clear', async ({ stored }) => {
  localStorage.setItem(themeStorageKey, 'light');
  const user = userEvent.setup();
  renderMenu('admin');
  const { theme } = await openThemeMenu(user);
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  if (stored !== null) {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('read-only'); });
  }

  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem(themeStorageKey)).toBe(stored);

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

it('uses a newer choice stored between shell mounts without writing it back', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  const user = userEvent.setup();
  renderMenu('admin');
  const { theme } = await openThemeMenu(user);
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });

  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem(themeStorageKey)).toBeNull();

  cleanup();
  setItem.mockRestore();
  localStorage.setItem(themeStorageKey, 'light');
  fireEvent(window, new StorageEvent('storage', {
    key: themeStorageKey, oldValue: null, newValue: 'light', storageArea: localStorage, url: window.location.href,
  }));
  const mountWrite = vi.spyOn(Storage.prototype, 'setItem');
  renderMenu('portal');
  const { theme: portalTheme } = await openThemeMenu(user);
  expect(portalTheme.getByRole('radio', { name: 'Light', checked: true })).toBeDefined();
  expect(document.documentElement.classList.contains('light')).toBe(true);
  expect(mountWrite).not.toHaveBeenCalled();
});

it('uses a different valid choice stored after a failed clear when a shell mounts', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  const user = userEvent.setup();
  renderMenu('admin');
  const { theme } = await openThemeMenu(user);
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('read-only'); });

  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem(themeStorageKey)).toBe('light');

  cleanup();
  setItem.mockRestore();
  removeItem.mockRestore();
  localStorage.setItem(themeStorageKey, 'system');
  const mountWrite = vi.spyOn(Storage.prototype, 'setItem');
  renderMenu('portal');
  const { theme: portalTheme } = await openThemeMenu(user);
  expect(portalTheme.getByRole('radio', { name: 'System', checked: true })).toBeDefined();
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(mountWrite).not.toHaveBeenCalled();
});

it.each([
  { change: 'local theme entries', area: 'local', key: themeStorageKey, values: ['system', 'light'], choice: 'Light', themeClass: 'light' },
  { change: 'all local entries', area: 'local', key: null, values: [], choice: 'System', themeClass: 'theme-system' },
  { change: 'an unrelated local entry', area: 'local', key: 'unrelated', values: ['system'], choice: 'Dark', themeClass: 'dark' },
  { change: 'a session theme entry', area: 'session', key: themeStorageKey, values: ['system'], choice: 'Dark', themeClass: 'dark' },
])('mounts the portal with $choice after storage events for $change', async ({ area, key, values, choice, themeClass }) => {
  localStorage.setItem(themeStorageKey, 'light');
  const user = userEvent.setup();
  renderMenu('admin');
  const { theme } = await openThemeMenu(user);
  const failedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const failedClear = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('read-only'); });

  await user.click(theme.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem(themeStorageKey)).toBe('light');
  cleanup();
  failedWrite.mockRestore();
  failedClear.mockRestore();

  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
  const clear = vi.spyOn(Storage.prototype, 'clear');
  const storageArea = area === 'session' ? sessionStorage : localStorage;
  if (key === null) {
    storageArea.clear();
    clear.mockClear();
    fireEvent(window, new StorageEvent('storage', { storageArea }));
  } else {
    for (const newValue of values) {
      const oldValue = storageArea.getItem(key);
      storageArea.setItem(key, newValue);
      setItem.mockClear();
      fireEvent(window, new StorageEvent('storage', { key, oldValue, newValue, storageArea }));
      expect(setItem).not.toHaveBeenCalled();
    }
  }
  renderMenu('portal');
  const { theme: portalTheme } = await openThemeMenu(user);
  expect(portalTheme.getByRole('radio', { name: choice, checked: true })).toBeDefined();
  expect(document.documentElement.classList.contains(themeClass)).toBe(true);
  expect(setItem).not.toHaveBeenCalled();
  expect(removeItem).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
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

it('closes the menu and returns focus to its button when Sign out is pressed', async () => {
  const user = userEvent.setup(), onSignOut = vi.fn();
  renderMenu('portal', onSignOut);
  const account = await screen.findByRole('button', { name: 'Account' });
  await user.click(account);
  expect(account.getAttribute('aria-expanded')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(onSignOut).toHaveBeenCalledOnce();
  expect(account.getAttribute('aria-expanded')).toBe('false');
  expect(document.getElementById('account-menu')?.hidden).toBe(true);
  expect(document.activeElement).toBe(account);
});

it('shows a sign-out being sent while the menu is closed', async () => {
  const user = userEvent.setup();
  renderMenu('portal', vi.fn(), true);
  const account = await screen.findByRole('button', { name: 'Account' });
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('Signing out…');
  expect(status.classList.contains('sr-only')).toBe(false);
  expect(status.classList.contains('pointer-events-none')).toBe(true);
  await user.click(account);
  // The open menu's disabled Sign out is the cue there.
  expect(screen.getByRole('status')).toBe(status);
  expect(status.classList.contains('sr-only')).toBe(true);
  expect(status.textContent).toBe('');
  expect((screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard('{Escape}');
  expect(status.textContent).toBe('Signing out…');
});

it('keeps an empty status while no sign-out is being sent', async () => {
  renderMenu();
  await screen.findByRole('button', { name: 'Account' });
  expect(screen.getByRole('status').textContent).toBe('');
  expect(screen.getByRole('status').classList.contains('sr-only')).toBe(true);
});

it('applies the stored theme when the shell mounts, before the menu opens', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  renderMenu();
  await screen.findByRole('button', { name: 'Account' });

  await waitFor(() => expect(document.documentElement.classList.contains('light')).toBe(true));
  expect(screen.queryByRole('group', { name: 'Theme' })).toBeNull();
});
