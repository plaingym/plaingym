// SPDX-License-Identifier: AGPL-3.0-only
// Standalone browser check, not imported by the application.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShellServicesContext } from '../../app/context.js';
import { defaultShellServices } from '../../app/services.js';
import '../../app/styles.css';
import { LeadsPage } from './page.js';
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <ShellServicesContext.Provider value={defaultShellServices}><div className="p-4"><LeadsPage /></div></ShellServicesContext.Provider>
</QueryClientProvider>);
