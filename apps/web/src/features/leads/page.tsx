// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { leadSourceSchema } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { Page, PageHeader } from '../../components/ui/page.js';
import { Alert } from '../../components/ui/alert.js';
import { Label } from '../../components/ui/label.js';
import { Select, CheckboxField } from '../../components/ui/select.js';
import { LoadingState, ErrorState } from '../../components/ui/states.js';
import { leadClient, type LeadClient } from './api.js';
import { StageColumn, openStages, type Filters } from './board.js';
import type { Outcome } from './dialogs.js';
import { text } from './text.js';

interface WorkspaceProps { timezone: string; roles: readonly StaffRole[]; client?: LeadClient }
export function LeadsWorkspace({ timezone, roles, client = leadClient }: WorkspaceProps) {
  if (!canStaff(roles, 'leads.manage')) return <Alert>{text('noAccess')}</Alert>;
  return <LeadsBoard timezone={timezone} client={client} />;
}
function LeadsBoard({ timezone, client }: { timezone: string; client: LeadClient }) {
  const [filters, setFilters] = useState<Filters>({ source: '', due: false }), [showLost, setShowLost] = useState(false);
  const [version, setVersion] = useState(0), [outcome, setOutcome] = useState<Outcome | null>(null);
  const stages = showLost ? [...openStages, 'lost' as const] : openStages;
  function done(result: Outcome) { setOutcome(result); if (result.reload) setVersion(value => value + 1); }
  return <Page>
    <PageHeader title={text('title')} description={text('help')} />
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:items-end">
      <div className="min-w-0 space-y-2"><Label htmlFor="leads-source">{text('source')}</Label>
        <Select id="leads-source" value={filters.source} onChange={event => setFilters({ ...filters, source: event.target.value as Filters['source'] })}>
          <option value="">{text('allSources')}</option>
          {[...leadSourceSchema.options, 'unknown' as const].map(source => <option key={source} value={source}>{text('source.' + source)}</option>)}
        </Select></div>
      <CheckboxField label={text('due')} checked={filters.due} onChange={event => setFilters({ ...filters, due: event.target.checked })} />
      <CheckboxField label={text('showLost')} checked={showLost} onChange={event => setShowLost(event.target.checked)} />
    </div>
    <p className="text-sm text-muted-foreground">{text('dueHelp', { timezone })}</p>
    {outcome && (outcome.error ? <Alert role="alert">{outcome.message}</Alert> : <p role="status" className="text-sm">{outcome.message}</p>)}
    <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {stages.map(stage => <StageColumn key={stage} stage={stage} filters={filters} version={version} client={client} timezone={timezone} onDone={done} />)}
    </div>
  </Page>;
}
export function LeadsPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <LoadingState />;
  if (bootstrap.isError) return <ErrorState onRetry={() => void bootstrap.refetch()} />;
  const { gym, session } = bootstrap.data;
  if (!session) return <Alert>{text('noAccess')}</Alert>;
  return <LeadsWorkspace key={gym.id + session.userId} timezone={gym.timezone} roles={session.roles} />;
}
