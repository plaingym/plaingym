// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './app/router.js';
import { ShellServicesContext } from './app/context.js';
import { defaultShellServices, type ShellServices } from './app/services.js';
/**
 * Whether the page at this path holds its reads: only the member portal's wait while the browser says it is offline.
 * Every other page, the portal's claim page among them (it has no offline banner), sends them and shows its own error,
 * since the server may be reachable all the same (an install on this machine with no network).
 */
export const readsWait = (pathname: string) => !navigator.onLine && /^\/portal(?:[/?#]|$)/.test(pathname)
  && !/^\/portal\/claim(?:[/?#]|$)/.test(pathname);
// The library's own listener starts online and only follows the `online` and `offline` events, so it would send reads
// from a browser that was already offline.
onlineManager.setEventListener(setOnline => {
  const update = () => setOnline(!readsWait(window.location.pathname));
  update();
  window.addEventListener('online', update); window.addEventListener('offline', update);
  return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
});
export function createShellQueryClient() {
  // A write never waits for a connection: it is sent at once and shows its screen's error if it can't be.
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false, networkMode: 'always' } } });
}
/** A page restored from the back-forward cache may show the last account's screen after a sign-out, so it is loaded again. */
export const reloadRestoredPage = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
export function App({ services = defaultShellServices, router: suppliedRouter }:
  { services?: ShellServices; router?: ReturnType<typeof createAppRouter> }) {
  const [queryClient] = useState(createShellQueryClient);
  const [router] = useState(() => suppliedRouter ?? createAppRouter());
  useEffect(() => {
    window.addEventListener('pageshow', reloadRestoredPage);
    return () => window.removeEventListener('pageshow', reloadRestoredPage);
  }, []);
  // One tab can move between the portal and other pages, so each navigation answers again before its page loads, and
  // once more when it has: the portal stays up while the next page loads, and still answers for itself until it goes.
  useEffect(() => {
    const answer = ({ toLocation }: { toLocation: { pathname: string } }) => onlineManager.setOnline(!readsWait(toLocation.pathname));
    const stops = [router.subscribe('onBeforeLoad', answer), router.subscribe('onResolved', answer)];
    return () => stops.forEach(stop => stop());
  }, [router]);
  return <QueryClientProvider client={queryClient}>
    <ShellServicesContext.Provider value={services}><RouterProvider router={router} /></ShellServicesContext.Provider>
  </QueryClientProvider>;
}
