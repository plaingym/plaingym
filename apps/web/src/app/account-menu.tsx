// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Button } from '../components/ui/button.js';
import { ChevronDownIcon, UserIcon } from '../components/ui/icons.js';
import { t } from '../lib/i18n.js';
import { applyThemeChoice, readThemeChoice, setThemeChoice, syncThemeChoiceFromStorage, themeChoices, themeStorageKey, type ThemeChoice as ThemeChoiceValue } from '../lib/theme.js';

/** Closes an open popover on Escape (returning focus to its trigger) or on a press outside it. */
export function useDismiss(open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[], trigger: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); trigger.current?.focus(); } };
    const onPointer = (event: PointerEvent) => {
      if (!refs.some((ref) => ref.current?.contains(event.target as Node))) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [open, close, refs, trigger]);
}

function ThemeChoice({ choice, onChoose }: { choice: ThemeChoiceValue; onChoose(choice: ThemeChoiceValue): void }) {
  return <fieldset className="mx-1 my-2 min-w-0 border-y border-border px-1 pb-2">
    <legend className="px-1 text-sm text-muted-foreground">{t('shell/shell:theme')}</legend>
    <div className="grid grid-cols-3 gap-1">
      {themeChoices.map((option) => <label key={option} className="relative min-w-11">
        <input type="radio" name="plaingym-theme-choice" value={option} checked={choice === option}
          onChange={() => onChoose(option)}
          className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0" />
        <span className="flex min-h-11 items-center justify-center rounded-md px-1 text-sm
          peer-hover:bg-muted peer-checked:bg-primary peer-checked:font-semibold peer-checked:text-primary-foreground
          peer-checked:peer-hover:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card">
          {t('shell/shell:theme.' + option)}
        </span>
      </label>)}
    </div>
  </fieldset>;
}

export function AccountMenu({ accountPath, identity, onSignOut, signingOut }:
  { accountPath: '/admin/account' | '/portal/account' | undefined; identity?: ReactNode; onSignOut(): void; signingOut: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [refs] = useState(() => [trigger, panel]);
  const [close] = useState(() => () => setOpen(false));
  // The choice outlives both shell lifetimes, so a failed save is not undone when the menu reopens or the other shell mounts.
  const [theme, setTheme] = useState<ThemeChoiceValue>('system');
  const [chooseTheme] = useState(() => (option: ThemeChoiceValue) => setTheme(setThemeChoice(option)));
  useEffect(() => {
    setTheme(applyThemeChoice(readThemeChoice()));
    const onStorage = (event: StorageEvent) => {
      // A null key means the other tab cleared its storage, so the choice is gone too.
      if (event.key !== null && event.key !== themeStorageKey) return;
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      setTheme(syncThemeChoiceFromStorage(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  useEffect(close, [close, pathname]);
  useDismiss(open, close, refs, trigger);
  return <div className="relative ml-auto">
    <Button ref={trigger} variant="ghost" className="min-w-11 px-2 sm:px-3" aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen(!open)}>
      <UserIcon /><span className="sr-only sm:not-sr-only">{t('shell/shell:account')}</span><ChevronDownIcon className="hidden size-4 sm:block" />
    </Button>
    <div ref={panel} id="account-menu" hidden={!open}
      className="absolute right-0 top-full z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
      {identity}
      {accountPath && <Button asChild variant="ghost" className="w-full justify-start">
        <Link to={accountPath} activeProps={{ 'aria-current': 'page' }} onClick={close}>{t('auth/account:menuLink')}</Link>
      </Button>}
      {open && <ThemeChoice choice={theme} onChoose={chooseTheme} />}
      <Button variant="ghost" className="w-full justify-start" onClick={() => { close(); trigger.current?.focus(); onSignOut(); }} disabled={signingOut}>{t('shell/shell:signOut')}</Button>
    </div>
  </div>;
}
