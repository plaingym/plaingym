// SPDX-License-Identifier: AGPL-3.0-only
import type { DashboardWidget } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import type { DashboardView } from './widgets.js';

const label = (key: string, values?: Parameters<typeof t>[1]) => t('leads/screens:tile.' + key, values);
/** The follow-ups due tile: how many open leads are due, the soonest (up to 20) linking to their lead pages, and the list. */
function FollowUpsDue({ widget }: { widget: DashboardWidget }) {
  if (!('kind' in widget)) return null;
  const items = widget.items ?? [];
  return <div className="min-w-0 space-y-3 pt-3">
    <p className="text-4xl font-semibold tabular-nums">{widget.count.toLocaleString()}</p>
    <p className="text-sm text-muted-foreground">{label('help')}</p>
    {items.length > 0 && <ul className="divide-y divide-border">{items.map(item => <li key={item.href}>
      <a className="flex min-h-11 items-center font-medium underline underline-offset-4" href={item.href}>{item.label}</a>
    </li>)}</ul>}
    {widget.count > items.length && <p className="text-sm text-muted-foreground">{label('showing', { shown: items.length, total: widget.count })}</p>}
    <a className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" href="/admin/leads">{label('all')}</a>
  </div>;
}
export const leadsWidgetViews: readonly DashboardView[] = [
  { id: 'leads.follow-ups-due', permission: 'leads.manage', render: widget => <FollowUpsDue widget={widget} /> },
];
