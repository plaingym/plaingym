// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { canStaff, type NavigationEntry } from '@plaingym/shared';
import { createRegistries } from '../lib/registries.js';
import { t } from '../lib/i18n.js';
import { Button } from '../components/ui/button.js';
import { CloseIcon, MenuIcon } from '../components/ui/icons.js';
import { lockPageScroll } from '../components/ui/dialog.js';
import type { ShellBootstrap, ShellSession } from './services.js';
import { sessionName } from './identity.js';
import { useDemoSandbox } from '../features/demo/notice.js';
import { AccountMenu, useDismiss } from './account-menu.js';
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
export function AdminShell({ state, entries = createRegistries().adminNav.all(), children, banner = null, onSignOut, signingOut = false }:
  { state: ShellBootstrap & { session: ShellSession }; entries?: readonly NavigationEntry[];
    children: ReactNode; banner?: ReactNode; onSignOut: () => void; signingOut?: boolean }) {
  const [open, setOpen] = useState(false);
  const demo = useDemoSandbox();
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  const menuButton = useRef<HTMLButtonElement>(null), nav = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null), bannerRef = useRef<HTMLDivElement>(null);
  const [menuTop, setMenuTop] = useState<number>();
  const [refs] = useState(() => [menuButton, nav]);
  const [close] = useState(() => () => setOpen(false));
  useDismiss(open, close, refs, menuButton);
  // Any navigation, including back/forward, closes the phone menu.
  useEffect(() => { setOpen(false); }, [pathname]);
  // Tailwind's `md` breakpoint shows the sidebar, so the menu is no longer open. Read the same media query the
  // layout uses instead of repeating its pixel width.
  useEffect(() => {
    if (!open) return;
    const desktop = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 48rem)') : null;
    const closeOnDesktop = () => { if (desktop?.matches) setOpen(false); };
    closeOnDesktop();
    desktop?.addEventListener('change', closeOnDesktop);
    return () => desktop?.removeEventListener('change', closeOnDesktop);
  }, [open]);
  // Anchor the menu below whatever chrome is above the content: the header, the demo row and the update banner.
  // The menu is fixed, so convert the content's document top to viewport coordinates with the scroll at measure time.
  // The content container is observed too: showing or hiding a banner above it moves the menu without resizing the header.
  useLayoutEffect(() => {
    if (!open) { setMenuTop(undefined); return; }
    const measure = () => {
      const headerHeight = header.current?.offsetHeight ?? 0;
      let contentTop = 0;
      for (let node: HTMLElement | null = content.current; node; node = node.offsetParent as HTMLElement | null) contentTop += node.offsetTop;
      const top = Math.max(headerHeight, contentTop - window.scrollY);
      setMenuTop((current) => current === top ? current : top);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (header.current) observer?.observe(header.current);
    if (bannerRef.current) observer?.observe(bannerRef.current);
    if (content.current) observer?.observe(content.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
  }, [open]);
  // The page behind the menu must not scroll or show a scrollbar. The shared page lock keeps the content where it was
  // and counts with any open dialog, so the two can close in either order.
  // Clip the body instead of hiding it: hiding it makes the body a scroll container, which breaks the sticky header.
  useLayoutEffect(() => {
    if (!open) return;
    const body = document.body;
    const previousBodyOverflow = body.style.overflow;
    const release = lockPageScroll();
    body.style.overflow = 'clip';
    return () => {
      body.style.overflow = previousBodyOverflow;
      release();
    };
  }, [open]);
  useEffect(() => { if (open) nav.current?.querySelector<HTMLElement>('a')?.focus(); }, [open]);
  const entriesToShow = visibleAdminNavigation(entries.map((entry) => entry.id === 'adminNav.outbox'
    ? { ...entry, enabled: demo } : entry), state.session, state.gym.enabledModules);
  return <div className="flex flex-1 flex-col">
    <header ref={header} className="sticky top-0 z-30 border-b border-border bg-background">
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
        <AccountMenu accountPath="/admin/account" onSignOut={onSignOut} signingOut={signingOut}
          identity={<p className="px-3 pb-2 pt-1 text-sm text-muted-foreground">
            {state.session.displayName === null ? sessionName(state.session) : <>{t('shell/shell:signedInAs')} <span className="wrap-anywhere font-medium text-foreground">{sessionName(state.session)}</span></>}{state.session.roles.length > 0 && ` (${roleNames(state.session)})`}
          </p>} />
      </div>
    </header>
    <div ref={bannerRef}>{banner}</div>
    <div ref={content} className="relative flex flex-1">
      {open && <div aria-hidden="true" style={menuTop === undefined ? undefined : { top: menuTop }} className="fixed inset-x-0 bottom-0 z-10 bg-foreground/20 md:hidden" />}
      <nav ref={nav} id="admin-navigation" aria-label={t('shell/shell:navigation')}
        style={open && menuTop !== undefined ? { top: menuTop } : undefined}
        className={`${open ? 'fixed inset-x-0 bottom-0 z-20 block' : 'hidden'} overflow-y-auto overscroll-contain border-b border-border bg-background p-2 shadow-lg
          md:sticky md:top-header md:bottom-auto md:block md:max-h-[calc(100dvh-var(--spacing-header))] md:w-60 md:shrink-0 md:self-start md:border-b-0 md:border-r md:p-3 md:shadow-none`}>
        <div className="space-y-4">{adminNavigationGroups(entriesToShow).map(group => <section key={group.id} aria-labelledby={'nav-' + group.id}>
          <h2 id={'nav-' + group.id} className="hidden px-3 pb-1 text-xs font-semibold text-muted-foreground md:block">{t('shell/shell:nav.' + group.id)}</h2>
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
