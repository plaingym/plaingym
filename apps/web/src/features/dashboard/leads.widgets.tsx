// SPDX-License-Identifier: AGPL-3.0-only
import type { DashboardWidget } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import { CountWidget, type DashboardView } from './widgets.js';

const label = (key: string, values?: Parameters<typeof t>[1]) => t('leads/screens:tile.' + key, values);
/** The follow-ups due tile: how many open leads are due, the soonest (up to 20) linking to their lead pages, and the list. */
function FollowUpsDue({ widget }: { widget: DashboardWidget }) {
  if (!('kind' in widget)) return null;
  return <CountWidget widget={widget} help={label('help')} footer={
    <a className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" href="/admin/leads">{label('all')}</a>
  } />;
}
export const leadsWidgetViews: readonly DashboardView[] = [
  { id: 'leads.follow-ups-due', permission: 'leads.manage', render: widget => <FollowUpsDue widget={widget} /> },
];
