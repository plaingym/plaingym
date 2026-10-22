// SPDX-License-Identifier: AGPL-3.0-only
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Button } from '../components/ui/button.js';
import { t } from '../lib/i18n.js';
import { DemoShell } from '../features/demo/notice.js';
// `/source` redirects to the running install's SOURCE_URL, so a modified install can change it at runtime.
export function SourceFooter({ sourceUrl = '/source' }: { sourceUrl?: string }) {
  return <footer className="border-t border-border px-6 py-4 text-center text-sm text-muted-foreground">
    <a className="underline underline-offset-4" href={sourceUrl}>{t('shell/shell:source')}</a>
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
export const Route = createRootRoute({ component: RootLayout, errorComponent: RootError, notFoundComponent: NotFound });
