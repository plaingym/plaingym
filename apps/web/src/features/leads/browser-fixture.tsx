// SPDX-License-Identifier: AGPL-3.0-only
// Standalone browser check, not imported by the application.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShellServicesContext } from '../../app/context.js';
import { defaultShellServices } from '../../app/services.js';
import '../../app/styles.css';
import { DashboardWidgets } from '../dashboard/widgets.js';
import { leadsWidgetViews } from '../dashboard/leads.widgets.js';
import { Page } from '../../components/ui/page.js';
import { LeadPage } from './lead.js';
import { LeadsPage } from './page.js';

// `?view=lead&memberId=<id>` shows a lead page; `?view=tile` the follow-ups due tile with `?items=<n>` leads.
const params = new URLSearchParams(location.search), view = params.get('view');
const items = Array.from({ length: Number(params.get('items') ?? 3) }, (_, n) => ({
  label: n === 0 ? 'Lead ' + 'Averylongsurname'.repeat(8) : 'Lead No' + (n + 1), href: `/admin/leads/0194a000-0000-7000-8000-${String(n + 1).padStart(12, '0')}` }));
const content = view === 'lead' ? <LeadPage memberId={params.get('memberId') ?? ''} />
  : view === 'tile' ? <Page><DashboardWidgets roles={['front_desk']} views={leadsWidgetViews} widgets={[{ id: 'leads.follow-ups-due',
    titleKey: 'leads/screens:tile.title', status: 'ready', kind: 'count', count: items.length + 4, items }]} /></Page>
    : <LeadsPage />;
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <ShellServicesContext.Provider value={defaultShellServices}><div className="p-4">{content}</div></ShellServicesContext.Provider>
</QueryClientProvider>);
