// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './app/router.js';
import { ShellServicesContext } from './app/context.js';
import { defaultShellServices, type ShellServices } from './app/services.js';
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
