// SPDX-License-Identifier: AGPL-3.0-only
// Development-only browser fixture, not imported by the application.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../app/styles.css';
import { Templates, MemberWaivers } from './screens.js';
import { SignWaiver } from '../portal/waivers/page.js';
import { portalWaiverEndpoints } from '../portal/waivers/endpoints.js';
import { portalCall, type PortalScope } from '../portal/household/api.js';
const id = '01900000-0000-7000-8000-000000000001';
const portal = new URLSearchParams(location.search).has('portal');
const scope: PortalScope = { key: ['portal', id, id, 'household', id], ready: true, moving: false, refreshing: false, settling: false,
  own: answer => answer, run: operation => operation(), call: portalCall };
const template = { id, name: 'Participation agreement', kind: 'agreement' as const, version: 2, body: '', retiredAt: null, createdAt: '2026-10-24T12:00:00Z',
  document: { key: id + '/waivers/templates/' + id + '.pdf', hash: 'c'.repeat(64), pages: 1, bytes: 1024 } };
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  {portal ? <SignWaiver template={template} member={{ id, firstName: 'Ava', lastName: 'Chen', dateOfBirth: '2018-01-01' }} minor
    endpoints={portalWaiverEndpoints(true)} scope={scope} close={() => undefined} saved={async () => undefined} />
    : <div className="p-4"><Templates gymId={id} manage /><MemberWaivers gymId={id} memberId={id} timezone="America/Vancouver" locale="en-CA" manage /></div>}
</QueryClientProvider>);
