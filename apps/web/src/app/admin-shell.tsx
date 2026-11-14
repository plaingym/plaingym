// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { canStaff, type NavigationEntry } from '@plaingym/shared';
import { createRegistries } from '../lib/registries.js';
import { t } from '../lib/i18n.js';
import { Button } from '../components/ui/button.js';
import { ChevronDownIcon, CloseIcon, MenuIcon, UserIcon } from '../components/ui/icons.js';
import type { ShellBootstrap, ShellSession } from './services.js';
import { sessionName } from './identity.js';
import { useDemoSandbox } from '../features/demo/notice.js';
export function visibleAdminNavigation(
  entries: readonly NavigationEntry[], session: ShellSession, enabledModules: readonly string[],
) {
  return entries.filter((entry) => entry.enabled && (!entry.moduleId || enabledModules.includes(entry.moduleId))
    && entry.permission.kind === 'staff' && canStaff(session.roles, entry.permission.capability));
}
const roleNames = (session: ShellSession) => session.roles.map((role) => t('staff/profiles:' + role)).join(', ');
/** Task order is a shell presentation choice; registries and API permissions stay independent. */
export function adminNavigationGroups(entries: readonly NavigationEntry[]) {
  const groups = [
    { id: 'overview', paths: ['/admin'] },
    { id: 'gym', paths: ['/admin/members', '/admin/leads', '/admin/schedule', '/admin/ranks', '/admin/waivers'] },
    { id: 'billing', paths: ['/admin/billing/invoices', '/admin/billing/plans', '/admin/reports'] },
    { id: 'communication', paths: ['/admin/announcements', '/admin/campaigns', '/admin/outbox'] },
    { id: 'administration', paths: ['/admin/staff', '/admin/imports', '/admin/health', '/admin/settings'] },
  ];
  const known = new Set(groups.flatMap(group => group.paths));
  return groups.map(group => ({ id: group.id, entries: [
    ...group.paths.flatMap(path => entries.filter(entry => entry.href === path)),
    ...(group.id === 'administration' ? entries.filter(entry => !known.has(entry.href)) : []),
  ] })).filter(group => group.entries.length);
}
/** Closes an open popover on Escape (returning focus to its trigger) or on a press outside it. */
function useDismiss(open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[], trigger: RefObject<HTMLButtonElement | null>) {
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
function AccountMenu({ session, onSignOut, signingOut }: { session: ShellSession; onSignOut: () => void; signingOut: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [refs] = useState(() => [trigger, panel]);
  const [close] = useState(() => () => setOpen(false));
  useDismiss(open, close, refs, trigger);
  return <div className="relative">
    <Button ref={trigger} variant="ghost" className="min-w-11 px-2 sm:px-3" aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen(!open)}>
      <UserIcon /><span className="sr-only sm:not-sr-only">{t('shell/shell:account')}</span><ChevronDownIcon className="hidden size-4 sm:block" />
    </Button>
    <div ref={panel} id="account-menu" hidden={!open}
      className="absolute right-0 top-full z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
      <p className="px-3 pb-2 pt-1 text-sm text-muted-foreground">
        {session.displayName === null ? sessionName(session) : <>{t('shell/shell:signedInAs')} <span className="break-words font-medium text-foreground">{sessionName(session)}</span></>}{session.roles.length > 0 && ` (${roleNames(session)})`}
      </p>
      <Button asChild variant="ghost" className="w-full justify-start"><Link to="/admin/account" onClick={() => setOpen(false)}>{t('auth/account:menuLink')}</Link></Button>
      <Button variant="ghost" className="w-full justify-start" onClick={onSignOut} disabled={signingOut}>{t('shell/shell:signOut')}</Button>
    </div>
  </div>;
}
export function AdminShell({ state, entries = createRegistries().adminNav.all(), children, banner = null, onSignOut, signingOut = false }:
  { state: ShellBootstrap & { session: ShellSession }; entries?: readonly NavigationEntry[];
    children: ReactNode; banner?: ReactNode; onSignOut: () => void; signingOut?: boolean }) {
  const [open, setOpen] = useState(false);
  const demo = useDemoSandbox();
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  const menuButton = useRef<HTMLButtonElement>(null), nav = useRef<HTMLElement>(null);
  const [refs] = useState(() => [menuButton, nav]);
  const [close] = useState(() => () => setOpen(false));
  useDismiss(open, close, refs, menuButton);
  // Any navigation, including back/forward, closes the phone menu.
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => { if (open) nav.current?.querySelector<HTMLElement>('a')?.focus(); }, [open]);
  const entriesToShow = visibleAdminNavigation(entries.map((entry) => entry.id === 'adminNav.outbox'
    ? { ...entry, enabled: demo } : entry), state.session, state.gym.enabledModules);
  return <div className="flex flex-1 flex-col">
    <header className="sticky top-0 z-30 border-b border-border bg-background">
      <div className="flex h-header items-center gap-2 px-2 sm:px-4">
        <Button ref={menuButton} variant="ghost" size="icon" className="md:hidden" aria-label={t(open ? 'shell/shell:closeMenu' : 'shell/shell:menu')}
          aria-expanded={open} aria-controls="admin-navigation" onClick={() => setOpen(!open)}>
          {open ? <CloseIcon /> : <MenuIcon />}
        </Button>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate font-semibold" title={state.gym.name}>{state.gym.name}</p>
          {/* A long name gives way to its ellipsis; the roles stay. */}
          <p className="flex min-w-0 text-xs text-muted-foreground" data-testid="signed-in-identity">
            <span className="hidden shrink-0 whitespace-pre sm:inline">{t('shell/shell:admin')} · </span>
            <span className="truncate font-medium text-foreground">{sessionName(state.session)}</span>
            {state.session.roles.length > 0 && <span className="shrink-0 whitespace-pre"> · {roleNames(state.session)}</span>}
          </p>
        </div>
        <AccountMenu session={state.session} onSignOut={onSignOut} signingOut={signingOut} />
      </div>
    </header>
    {banner}
    <div className="relative flex flex-1">
      {open && <div aria-hidden="true" className="fixed inset-0 top-header z-10 bg-foreground/20 md:hidden" />}
      <nav ref={nav} id="admin-navigation" aria-label={t('shell/shell:navigation')}
        className={`${open ? 'block' : 'hidden'} absolute inset-x-0 top-0 z-20 max-h-[calc(100dvh-var(--spacing-header))] overflow-y-auto border-b border-border bg-background p-2 shadow-lg
          md:sticky md:top-header md:block md:max-h-[calc(100dvh-var(--spacing-header))] md:w-60 md:shrink-0 md:self-start md:border-b-0 md:border-r md:p-3 md:shadow-none`}>
        <div className="space-y-4">{adminNavigationGroups(entriesToShow).map(group => <section key={group.id} aria-labelledby={'nav-' + group.id}>
          <h2 id={'nav-' + group.id} className="px-3 pb-1 text-xs font-semibold text-muted-foreground">{t('shell/shell:nav.' + group.id)}</h2>
        <ul className="space-y-1">{group.entries.map((entry) => <li key={entry.id}>
          <Link to={entry.href} onClick={() => setOpen(false)} activeOptions={{ exact: entry.href === '/admin' }}
            activeProps={{ className: 'bg-muted font-semibold', 'aria-current': 'page' }}
            className="flex min-h-11 items-center rounded-md px-3 text-base hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm">{t(entry.labelKey)}</Link>
        </li>)}</ul></section>)}</div>
      </nav>
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8">{children}</main>
    </div>
  </div>;
}
