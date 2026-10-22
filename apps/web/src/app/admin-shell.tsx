// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { canStaff, type NavigationEntry } from '@plaingym/shared';
import { createRegistries } from '../lib/registries.js';
import { t } from '../lib/i18n.js';
import { Button } from '../components/ui/button.js';
import type { ShellBootstrap, ShellSession } from './services.js';
import { useDemoSandbox } from '../features/demo/notice.js';
export function visibleAdminNavigation(
  entries: readonly NavigationEntry[], session: ShellSession, enabledModules: readonly string[],
) {
  return entries.filter((entry) => entry.enabled && (!entry.moduleId || enabledModules.includes(entry.moduleId))
    && entry.permission.kind === 'staff' && canStaff(session.roles, entry.permission.capability));
}
export function AdminShell({ state, entries = createRegistries().adminNav.all(), children, onSignOut, signingOut = false }:
  { state: ShellBootstrap & { session: ShellSession }; entries?: readonly NavigationEntry[];
    children: ReactNode; onSignOut: () => void; signingOut?: boolean }) {
  const [open, setOpen] = useState(false);
  const demo = useDemoSandbox();
  const entriesToShow = visibleAdminNavigation(entries.map((entry) => entry.id === 'adminNav.outbox'
    ? { ...entry, enabled: demo } : entry), state.session, state.gym.enabledModules);
  return <div className="flex flex-1 flex-col">
    <header className="flex items-center justify-between gap-4 border-b border-border p-4">
      <div><p className="font-semibold">{state.gym.name}</p><p className="text-xs text-muted-foreground">{t('shell/shell:admin')}</p></div>
      <div className="flex gap-2"><Button variant="outline" className="md:hidden" aria-expanded={open} aria-controls="admin-navigation" onClick={() => setOpen(!open)}>{t('shell/shell:menu')}</Button>
        <Button variant="ghost" onClick={onSignOut} disabled={signingOut}>{t('shell/shell:signOut')}</Button></div>
    </header>
    <div className="flex flex-1 flex-col md:flex-row">
      <nav id="admin-navigation" aria-label={t('shell/shell:navigation')} className={`${open ? 'block' : 'hidden'} border-b border-border p-4 md:block md:w-60 md:border-b-0 md:border-r`}>
        <ul className="space-y-1">{entriesToShow.map((entry) => <li key={entry.id}>
          <Link to={entry.href} onClick={() => setOpen(false)} activeOptions={{ exact: entry.href === '/admin' }}
            activeProps={{ className: 'bg-muted font-semibold', 'aria-current': 'page' }}
            className="block rounded-md px-3 py-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t(entry.labelKey)}</Link>
        </li>)}</ul>
      </nav>
      <main id="main-content" className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  </div>;
}
