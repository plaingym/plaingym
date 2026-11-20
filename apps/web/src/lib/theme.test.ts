// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  applyThemeChoice, effectiveThemeChoice, isKioskPath, readThemeChoice, resetThemeChoice, setThemeChoice,
  syncThemeColor, themeColors, themeStorageKey, writeThemeChoice,
} from './theme.js';

const meta = (scheme: 'light' | 'dark', color: string) =>
  `<meta name="theme-color" content="${color}" media="(prefers-color-scheme: ${scheme})" data-theme-scheme="${scheme}" />`;

function resetDocument() {
  document.head.innerHTML = meta('light', themeColors.light) + meta('dark', themeColors.dark);
  document.documentElement.className = '';
}

beforeEach(() => {
  localStorage.clear();
  resetThemeChoice();
  resetDocument();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetThemeChoice();
  resetDocument();
});

const themeClasses = () => [...document.documentElement.classList].filter(name => ['theme-system', 'light', 'dark'].includes(name));
const metaColors = () => [...document.querySelectorAll('meta[name="theme-color"]')].map(element => element.getAttribute('content'));

it('reads a stored choice and applies it to the document', () => {
  localStorage.setItem(themeStorageKey, 'dark');
  expect(readThemeChoice('/admin')).toBe('dark');
  expect(applyThemeChoice(readThemeChoice('/admin'))).toBe('dark');
  expect(themeClasses()).toEqual(['dark']);
  expect(metaColors()).toEqual([themeColors.dark, themeColors.dark]);
});

it('writes an explicit choice and keeps the theme-colour metas in step', () => {
  expect(setThemeChoice('light')).toBe('light');
  expect(localStorage.getItem(themeStorageKey)).toBe('light');
  expect(themeClasses()).toEqual(['light']);
  expect(metaColors()).toEqual([themeColors.light, themeColors.light]);

  expect(setThemeChoice('system')).toBe('system');
  expect(localStorage.getItem(themeStorageKey)).toBe('system');
  expect(themeClasses()).toEqual(['theme-system']);
  expect(metaColors()).toEqual([themeColors.light, themeColors.dark]);

  syncThemeColor('dark');
  expect(metaColors()).toEqual([themeColors.dark, themeColors.dark]);
});

it('falls back to System when a storage read or write throws', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readThemeChoice('/admin')).toBe('system');
  vi.restoreAllMocks();

  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(setThemeChoice('dark')).toBe('system');
  expect(themeClasses()).toEqual(['theme-system']);
});

it('applies a failed write and clears the readable stored choice so a reload starts from System', () => {
  localStorage.setItem(themeStorageKey, 'dark');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });

  expect(setThemeChoice('light')).toBe('light');
  expect(themeClasses()).toEqual(['light']);
  expect(localStorage.getItem(themeStorageKey)).toBeNull();
});

it('applies a failed write even when the stale key cannot be removed', () => {
  localStorage.setItem(themeStorageKey, 'dark');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('read-only'); });

  expect(setThemeChoice('light')).toBe('light');
  expect(themeClasses()).toEqual(['light']);
  expect(localStorage.getItem(themeStorageKey)).toBe('dark');
});

it('keeps a failed-save pick for a later shell mount in the same page', () => {
  localStorage.setItem(themeStorageKey, 'light');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });

  expect(setThemeChoice('dark', { pathname: '/admin' })).toBe('dark');
  expect(localStorage.getItem(themeStorageKey)).toBeNull();
  expect(readThemeChoice('/admin')).toBe('dark');
});

it('does not let an earlier saved pick override storage on a later mount', () => {
  localStorage.setItem(themeStorageKey, 'light');
  expect(setThemeChoice('dark', { pathname: '/admin' })).toBe('dark');
  localStorage.setItem(themeStorageKey, 'light');
  expect(readThemeChoice('/admin')).toBe('light');
});

it('starts a full reload from storage or System, not a failed in-page pick', async () => {
  localStorage.setItem(themeStorageKey, 'light');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(setThemeChoice('dark', { pathname: '/admin' })).toBe('dark');
  expect(readThemeChoice('/admin')).toBe('dark');
  vi.restoreAllMocks();

  localStorage.setItem(themeStorageKey, 'dark');
  vi.resetModules();
  const stored = await import('./theme.js');
  expect(stored.readThemeChoice('/admin')).toBe('dark');

  localStorage.removeItem(themeStorageKey);
  vi.resetModules();
  const empty = await import('./theme.js');
  expect(empty.readThemeChoice('/admin')).toBe('system');
});

it('keeps System when a failed write cannot read the stored choice either', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });

  expect(setThemeChoice('dark')).toBe('system');
  expect(themeClasses()).toEqual(['theme-system']);
});

it('keeps the kiosk on System even when the page holds a failed admin pick', () => {
  localStorage.setItem(themeStorageKey, 'light');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(setThemeChoice('dark', { pathname: '/admin' })).toBe('dark');
  expect(readThemeChoice('/kiosk')).toBe('system');
  expect(applyThemeChoice(readThemeChoice('/kiosk'), { pathname: '/kiosk' })).toBe('system');
  expect(themeClasses()).toEqual(['theme-system']);
});

it('always follows the device on the kiosk, whatever this browser stored', () => {
  localStorage.setItem(themeStorageKey, 'dark');
  expect(isKioskPath('/kiosk')).toBe(true);
  expect(isKioskPath('/kiosk/setup')).toBe(true);
  expect(isKioskPath('/admin/kiosk')).toBe(false);
  expect(readThemeChoice('/kiosk')).toBe('system');
  expect(effectiveThemeChoice('dark', '/kiosk')).toBe('system');
  expect(applyThemeChoice('dark', { pathname: '/kiosk' })).toBe('system');
  expect(themeClasses()).toEqual(['theme-system']);
  expect(setThemeChoice('light', { pathname: '/kiosk' })).toBe('system');
  expect(themeClasses()).toEqual(['theme-system']);
  expect(readThemeChoice('/admin')).toBe('dark');
});

it('keeps exactly one theme class on the document', () => {
  document.documentElement.className = 'dark other';
  expect(applyThemeChoice('light')).toBe('light');
  expect(document.documentElement.classList.contains('other')).toBe(true);
  expect(themeClasses()).toEqual(['light']);
  expect(writeThemeChoice('dark', { storage: localStorage })).toBe('dark');
});

it('shares the storage key and theme colours with the pre-paint script', () => {
  const script = readFileSync('apps/web/src/lib/theme-init.js', 'utf8');
  expect(script).toContain(`'${themeStorageKey}'`);
  for (const color of Object.values(themeColors)) expect(script).toContain(color);
});
