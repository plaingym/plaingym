// SPDX-License-Identifier: AGPL-3.0-only
// Development-only browser fixture, not imported by the application.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../app/styles.css';
import { Templates, MemberWaivers } from './screens.js';
const id = '01900000-0000-7000-8000-000000000001';
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <div className="p-4"><Templates gymId={id} manage /><MemberWaivers gymId={id} memberId={id} timezone="America/Vancouver" locale="en-CA" manage /></div>
</QueryClientProvider>);
