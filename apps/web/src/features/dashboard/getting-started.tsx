// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { goLiveChecklistResponseSchema } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { parseResponse } from '../../lib/response.js';
import { t } from '../../lib/i18n.js';

const text = (key: string) => t('dashboard/getting-started:' + key);
const needsMembers = (checklist: { items: { id: string; status: string }[] } | undefined) =>
  checklist?.items.find(item => item.id === 'members_imported')?.status === 'needs_attention';
/** The existing readiness read includes all members, including inactive members absent from the active count. */
export function GettingStarted({ gymId, roles }: { gymId: string; roles: readonly StaffRole[] }) {
  const allowed = canStaff(roles, 'go_live.manage');
  const query = useQuery({ queryKey: ['dashboard-getting-started', gymId, [...roles].sort()], enabled: allowed,
    queryFn: async ({ signal }) => {
      const result = await api.GET('/api/settings/go-live', { signal, cache: 'no-store' });
      if (!result.response.ok) throw new Error('Readiness request failed');
      return parseResponse(goLiveChecklistResponseSchema, result.data).data;
    // The checklist read is heavy: poll it only while the panel shows, not for a roster that has members but none active.
    }, refetchInterval: (current) => needsMembers(current.state.data) ? 60_000 : false });
  if (!allowed || query.isError || !needsMembers(query.data)) return null;
  const link = (href: string, key: string) => <a href={href} className="inline-flex min-h-11 items-center rounded-md font-medium underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{text(key)}</a>;
  return <section aria-labelledby="getting-started-title" className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6">
    <h2 id="getting-started-title" className="text-lg font-semibold">{text('title')}</h2>
    <p className="text-sm text-muted-foreground">{text('help')}</p>
    <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
      {canStaff(roles, 'schedule.manage') && <li>{link('/admin/schedule', 'classes')}<p className="text-sm text-muted-foreground">{text('classesHelp')}</p></li>}
      {canStaff(roles, 'plans.manage') && <li>{link('/admin/billing/plans', 'plans')}<p className="text-sm text-muted-foreground">{text('plansHelp')}</p></li>}
      <li><div className="flex flex-wrap gap-x-3">{link('/admin/members', 'members')}{canStaff(roles, 'settings.manage') && link('/admin/imports', 'import')}</div><p className="text-sm text-muted-foreground">{text('membersHelp')}</p></li>
      <li>{link('/admin/settings#settingsSections.settings.go-live', 'live')}<p className="text-sm text-muted-foreground">{text('liveHelp')}</p></li>
    </ul>
  </section>;
}
