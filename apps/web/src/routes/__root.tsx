// SPDX-License-Identifier: AGPL-3.0-only
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Button } from '../components/ui/button.js';
import { t } from '../lib/i18n.js';
import { DemoShell } from '../features/demo/notice.js';
import { checkOnNavigation, clientVersion, versionLabel } from '../app/version.js';
// `/source` redirects to the running install's SOURCE_URL, so a modified install can change it at runtime.
// The version beside it is this bundle's build; a plain release links to its notes in the source repository.
export function SourceFooter({ sourceUrl = '/source', version = clientVersion?.version, repository = typeof __SOURCE_URL__ === 'undefined' ? '' : __SOURCE_URL__ }:
{ sourceUrl?: string; version?: string; repository?: string }) {
  const label = version ? versionLabel(version, repository) : undefined;
  const shown = label && <><span aria-hidden="true">{label.text}</span><span className="sr-only">{t('shell/shell:version', { version: version ?? '' })}</span></>;
  return <footer className="flex flex-wrap items-center justify-center gap-x-4 border-t border-border px-4 py-2 text-center text-sm text-muted-foreground sm:px-6">
    <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={sourceUrl}>{t('shell/shell:source')}</a>
    {label && (label.href
      ? <a className="inline-flex min-h-11 items-center break-all underline underline-offset-4" href={label.href}>{shown}</a>
      : <span className="inline-flex min-h-11 items-center break-all">{shown}</span>)}
  </footer>;
}
export function RootLayout() {
  return <div className="flex min-h-dvh flex-col bg-background font-sans text-foreground">
    <a href="#main-content" className="sr-only focus:not-sr-only focus:p-3">{t('shell/shell:skip')}</a>
    <DemoShell><div className="flex flex-1 flex-col"><Outlet /></div></DemoShell><SourceFooter />
  </div>;
}
export function RootError({ reset }: { reset: () => void }) {
  return <div className="flex min-h-dvh flex-col"><main id="main-content" className="flex-1 p-6">
    <h1>{t('shell/shell:error')}</h1><Button onClick={reset}>{t('shell/shell:retry')}</Button>
  </main><SourceFooter /></div>;
}
export function NotFound() {
  return <main id="main-content" className="p-6"><h1>{t('shell/shell:notFound')}</h1>
    <a href="/login" className="underline">{t('shell/shell:home')}</a></main>;
}
export const Route = createRootRoute({ beforeLoad: ({ preload, location }) => checkOnNavigation({ preload, location }), component: RootLayout, errorComponent: RootError, notFoundComponent: NotFound });
