// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './app/router.js';
import { ShellServicesContext } from './app/context.js';
import { defaultShellServices, type ShellServices } from './app/services.js';
// Reads wait while the browser says it is offline. The library's own listener starts online and only follows the
// `online` and `offline` events, so it would send reads from a browser that was already offline.
onlineManager.setEventListener(setOnline => {
  const update = () => setOnline(navigator.onLine);
  update();
  window.addEventListener('online', update); window.addEventListener('offline', update);
  return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
});
export function createShellQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } } });
}
export function App({ services = defaultShellServices, router: suppliedRouter }:
  { services?: ShellServices; router?: ReturnType<typeof createAppRouter> }) {
  const [queryClient] = useState(createShellQueryClient);
  const [router] = useState(() => suppliedRouter ?? createAppRouter());
  return <QueryClientProvider client={queryClient}>
    <ShellServicesContext.Provider value={services}><RouterProvider router={router} /></ShellServicesContext.Provider>
  </QueryClientProvider>;
}
