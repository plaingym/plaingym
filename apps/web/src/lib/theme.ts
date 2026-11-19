// SPDX-License-Identifier: AGPL-3.0-only

/** The three choices: follow the device, or force one of the two schemes. */
export const themeChoices = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof themeChoices)[number];

/** The per-browser key the early script and this module both read. Values are `themeChoices`. */
export const themeStorageKey = 'plaingym.theme';

/** Kept in step with the two `<meta name="theme-color">` elements in `index.html`. */
export const themeColors = { light: '#ffffff', dark: '#0c1514' } as const;

const themeClasses = ['theme-system', 'light', 'dark'] as const;

export interface ThemeEnvironment {
  readonly pathname?: string;
  readonly root?: HTMLElement;
  readonly document?: Document;
  readonly storage?: Storage;
}

function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (themeChoices as readonly string[]).includes(value);
}

/** The kiosk always follows the device, whatever a browser on the tablet stored for another surface. */
export function isKioskPath(pathname = window.location.pathname): boolean {
  return pathname === '/kiosk' || pathname.startsWith('/kiosk/');
}

export function effectiveThemeChoice(choice: ThemeChoice, pathname = window.location.pathname): ThemeChoice {
  return isKioskPath(pathname) ? 'system' : choice;
}

/** Reading `window.localStorage` itself can throw when storage is blocked, not only `getItem`. */
function browserStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

/** The stored choice, or System when nothing valid is stored or storage is unavailable. */
export function readThemeChoice(pathname = window.location.pathname, storage = browserStorage()): ThemeChoice {
  if (isKioskPath(pathname)) return 'system';
  try {
    const stored = storage?.getItem(themeStorageKey);
    return isThemeChoice(stored) ? stored : 'system';
  } catch { return 'system'; }
}

/** Stores a choice outside the kiosk and returns System when storage is unavailable. */
export function writeThemeChoice(choice: ThemeChoice, environment: ThemeEnvironment = {}): ThemeChoice {
  if (isKioskPath(environment.pathname)) return 'system';
  const storage = environment.storage ?? browserStorage();
  if (!storage) return 'system';
  try {
    storage.setItem(themeStorageKey, choice);
    return choice;
  } catch { return 'system'; }
}

/** The colour for the current scheme, or the forced scheme when the choice is explicit. */
export function themeColorFor(choice: ThemeChoice, scheme: 'light' | 'dark'): string {
  return themeColors[choice === 'system' ? scheme : choice];
}

/** Keeps both theme-colour metas right when an explicit choice overrides the device scheme. */
export function syncThemeColor(choice: ThemeChoice, document = globalThis.document): void {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = meta.getAttribute('data-theme-scheme') === 'dark' ? 'dark' : 'light';
    meta.setAttribute('content', themeColorFor(choice, scheme));
  }
}

/** Replaces the three possible classes on `<html>`, so exactly one applies. */
export function applyThemeChoice(choice: ThemeChoice, environment: ThemeEnvironment = {}): ThemeChoice {
  const pathname = environment.pathname ?? window.location.pathname;
  const root = environment.root ?? globalThis.document.documentElement;
  const document = environment.document ?? root.ownerDocument;
  const chosen = effectiveThemeChoice(choice, pathname);
  for (const name of themeClasses) root.classList.remove(name);
  root.classList.add(chosen === 'system' ? 'theme-system' : chosen);
  syncThemeColor(chosen, document);
  return chosen;
}

/** The setter a theme switch uses: apply now, then remember the choice for this browser. */
export function setThemeChoice(choice: ThemeChoice, environment: ThemeEnvironment = {}): ThemeChoice {
  return applyThemeChoice(writeThemeChoice(choice, environment), environment);
}
