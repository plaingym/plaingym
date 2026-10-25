// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { canStaff, type StaffPermission, type StaffRole } from '@plaingym/shared';
import type { DashboardWidget } from '@plaingym/shared/contracts';
import { Card } from '../../components/ui/card.js';
import { t } from '../../lib/i18n.js';

export interface DashboardView {
  readonly id: string;
  readonly permission: StaffPermission;
  render(widget: DashboardWidget): ReactNode;
}
const label = (key: string) => t('dashboard/dashboard:' + key);
const knownPermissions: Partial<Record<DashboardWidget['id'], StaffPermission>> = {
  active_members: 'members.read', not_seen: 'members.read', promotion_ready: 'promotions.manage',
  mrr: 'billing.read', past_due: 'billing.read', upcoming_charges: 'billing.read', disputes: 'billing.read',
};
/** Data and renderer extensions are independent of the page framework. */
export function DashboardWidgets({ widgets, roles, views = [] }: {
  widgets: readonly DashboardWidget[]; roles: readonly StaffRole[]; views?: readonly DashboardView[];
}) {
  return <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">{widgets.map((widget) => {
    const view = views.find((entry) => entry.id === widget.id);
    if (!canStaff(roles, view?.permission ?? knownPermissions[widget.id] ?? 'members.read')) return null;
    return <Card key={widget.id} aria-labelledby={'dashboard-' + widget.id} className="min-w-0 p-4 sm:p-6">
      <h2 id={'dashboard-' + widget.id} className="text-lg font-semibold">{t(widget.titleKey)}</h2>
      {widget.status !== 'ready' ? <p className="mt-3 text-muted-foreground">{label('status.' + widget.status)}</p>
        : view ? view.render(widget) : <>
          {'count' in widget && <p className="mt-3 text-4xl font-semibold tabular-nums">{widget.count.toLocaleString()}</p>}
          {'members' in widget && <>
            <p className="mt-3 text-sm text-muted-foreground">{label('description.' + widget.id)}</p>
            {widget.members.length === 0 ? <p className="mt-4 rounded-lg border border-dashed border-border p-4 text-sm">{label('empty.' + widget.id)}</p>
              : <ul className="mt-3 divide-y divide-border">{widget.members.map((member) => <li key={member.memberId} className="py-2">
                <a className="flex min-h-11 items-center break-words font-medium underline underline-offset-4" href={'/admin/members/' + encodeURIComponent(member.memberId)}>{member.firstName} {member.lastName}</a>
                <p className="text-sm text-muted-foreground">{label('lastSeen')}: {member.lastSeenAt
                  ? <time dateTime={member.lastSeenAt}>{new Date(member.lastSeenAt).toLocaleDateString()}</time> : label('neverSeen')}</p>
              </li>)}</ul>}
            {widget.count > widget.members.length && <p className="mt-4 text-sm text-muted-foreground">{t('dashboard/dashboard:showing', { shown: widget.members.length, total: widget.count })}</p>}
          </>}
        </>}
    </Card>;
  })}</div>;
}
