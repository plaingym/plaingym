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

/** The choice this loaded page applied for itself, held above the admin and portal shell lifetimes. */
let appliedThemeChoice: ThemeChoice | undefined;
let keepAppliedThemeChoice = false;

function rememberAppliedThemeChoice(choice: ThemeChoice, keep: boolean): void {
  appliedThemeChoice = choice;
  keepAppliedThemeChoice = keep;
}

/** Clears the page's own choice. A full reload does this; exported so tests can simulate one. */
export function resetThemeChoice(): void {
  appliedThemeChoice = undefined;
  keepAppliedThemeChoice = false;
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

/**
 * The choice a shell mount should use: a pick whose save failed in this page, else the stored
 * choice, else System when nothing valid is stored or storage is unavailable.
 */
export function readThemeChoice(pathname = window.location.pathname, storage = browserStorage()): ThemeChoice {
  if (isKioskPath(pathname)) return 'system';
  if (keepAppliedThemeChoice && appliedThemeChoice !== undefined) return appliedThemeChoice;
  try {
    const stored = storage?.getItem(themeStorageKey);
    return isThemeChoice(stored) ? stored : 'system';
  } catch { return 'system'; }
}

interface ThemeWriteOutcome {
  readonly choice: ThemeChoice;
  /** A failed write kept a pick the page must reuse when the shell remounts. */
  readonly keep: boolean;
}

function writeThemeChoiceOutcome(choice: ThemeChoice, environment: ThemeEnvironment): ThemeWriteOutcome {
  if (isKioskPath(environment.pathname)) return { choice: 'system', keep: false };
  const storage = environment.storage ?? browserStorage();
  if (!storage) return { choice: 'system', keep: false };
  try {
    storage.setItem(themeStorageKey, choice);
    return { choice, keep: false };
  } catch {
    // A failed write must not leave an older choice behind to return on the next load.
    let previous: string | null;
    try { previous = storage.getItem(themeStorageKey); } catch { return { choice: 'system', keep: false }; }
    if (previous === null) return { choice: 'system', keep: false }; // Nothing stale to clear; keep the existing System fallback.
    try { storage.removeItem(themeStorageKey); } catch { /* Read-only storage keeps the old value; this page still shows the pick. */ }
    return { choice, keep: true };
  }
}

/** Stores a choice outside the kiosk. A failed write clears an older choice and keeps the pick for this page; unavailable or unreadable storage returns System. */
export function writeThemeChoice(choice: ThemeChoice, environment: ThemeEnvironment = {}): ThemeChoice {
  return writeThemeChoiceOutcome(choice, environment).choice;
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

/** Applies a value another tab stored and makes it this page's choice, replacing a failed local pick. */
export function syncThemeChoiceFromStorage(value: string | null, environment: ThemeEnvironment = {}): ThemeChoice {
  const stored = isThemeChoice(value) ? value : 'system';
  const chosen = applyThemeChoice(stored, environment);
  rememberAppliedThemeChoice(chosen, false);
  return chosen;
}

/** The setter a theme switch uses: apply now, remember the choice for this browser and keep a failed save for this page. */
export function setThemeChoice(choice: ThemeChoice, environment: ThemeEnvironment = {}): ThemeChoice {
  const outcome = writeThemeChoiceOutcome(choice, environment);
  const chosen = applyThemeChoice(outcome.choice, environment);
  rememberAppliedThemeChoice(chosen, outcome.keep);
  return chosen;
}
