// SPDX-License-Identifier: AGPL-3.0-only
// Development-only fixture, not imported by the application.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../app/styles.css';
import { CampaignWorkspace } from './page.js';
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <div className="p-4"><CampaignWorkspace gymId="01900000-0000-7000-8000-000000000001" timezone="America/Los_Angeles" /></div>
</QueryClientProvider>);
