// SPDX-License-Identifier: AGPL-3.0-only
// Standalone browser check, not imported by the application.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../app/styles.css';
import { AnnouncementWorkspace } from './page.js';
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <div className="p-4"><AnnouncementWorkspace gymId="01900000-0000-7000-8000-000000000001" gymName="Our Gym" timezone="America/Los_Angeles" /></div>
</QueryClientProvider>);
