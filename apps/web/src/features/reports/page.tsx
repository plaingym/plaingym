// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type KeyboardEvent } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { reportRangeQuerySchema } from '@plaingym/shared/contracts';
import { localDate } from '@plaingym/shared/time';
import { useBootstrap } from '../../app/context.js';
import { Page, PageHeader } from '../../components/ui/page.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { LoadingState, ErrorState } from '../../components/ui/states.js';
import { reportClient, type ReportClient } from './api.js';
import { allPrograms, defaultRange, text } from './data.js';
import { AttendanceReport, MembersReport, RevenueReport } from './views.js';

export type ReportName = 'attendance' | 'members' | 'revenue';
export function allowedReports(roles: readonly StaffRole[]): ReportName[] {
  if (!canStaff(roles, 'reports.read')) return [];
  return ['attendance', ...(canStaff(roles, 'billing.read') ? ['members' as const] : []),
    ...(canStaff(roles, 'reports.revenue') ? ['revenue' as const] : [])];
}
interface WorkspaceProps { gymId: string; userId: string; timezone: string; roles: readonly StaffRole[]; client?: ReportClient }
export function ReportsWorkspace(props: WorkspaceProps) {
  const reports = allowedReports(props.roles);
  if (!reports.length) return <Alert variant="error">{text('noAccess')}</Alert>;
  return <ReportsContent key={reports.join(',')} {...props} reports={reports} />;
}
function ReportsContent({ gymId, userId, timezone, client = reportClient, reports }: WorkspaceProps & { reports: ReportName[] }) {
  const [range, setRange] = useState(() => defaultRange(timezone));
  const [from, setFrom] = useState(range.from), [to, setTo] = useState(range.to);
  const [invalid, setInvalid] = useState(false), [selected, setSelected] = useState<ReportName>('attendance');
  const [granularity, setGranularity] = useState<'week' | 'month'>('month');
  const [program, setProgram] = useState(allPrograms);
  const currentMonth = localDate(new Date(), timezone).slice(0, 7);
  const view = { gymId, userId, range, client };
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? reports.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % reports.length : event.key === 'ArrowLeft' ? (index + reports.length - 1) % reports.length : null;
    if (target === null) return;
    event.preventDefault(); setSelected(reports[target]!);
    document.getElementById('report-tab-' + reports[target])?.focus();
  }
  return <Page>
    <PageHeader title={text('title')} description={text('help')} />
    <form className="space-y-3" onSubmit={event => {
      event.preventDefault();
      const parsed = reportRangeQuerySchema.safeParse({ from, to });
      if (!parsed.success || to > currentMonth) { setInvalid(true); return; }
      setInvalid(false); setRange(parsed.data); setProgram(allPrograms);
    }}>
      <div className="grid min-w-0 grid-cols-1 items-end gap-3 sm:grid-cols-3">
        <div className="min-w-0 space-y-2"><Label htmlFor="report-from">{text('from')}</Label>
          <Input id="report-from" type="month" required value={from} max={currentMonth} min="0001-01" aria-describedby="report-range-help" onChange={event => setFrom(event.target.value)} />
        </div>
        <div className="min-w-0 space-y-2"><Label htmlFor="report-to">{text('to')}</Label>
          <Input id="report-to" type="month" required value={to} max={currentMonth} min="0001-01" aria-describedby="report-range-help" onChange={event => setTo(event.target.value)} />
        </div>
        <Button type="submit">{text('apply')}</Button>
      </div>
      <p id="report-range-help" className="text-sm text-muted-foreground">{text('rangeHelp', { timezone })}</p>
      {invalid && <Alert variant="error" focusOnReveal role="alert">{text('rangeError')}</Alert>}
    </form>
    <div role="tablist" aria-label={text('reportTabs')} className="flex flex-wrap gap-2">
      {reports.map((report, index) => <Button key={report} className="transition-none" role="tab" id={'report-tab-' + report} aria-controls="report-panel"
        aria-selected={selected === report} tabIndex={selected === report ? 0 : -1} variant={selected === report ? 'default' : 'outline'}
        onClick={() => setSelected(report)} onKeyDown={event => tabKey(event, index)}>{text(report)}</Button>)}
    </div>
    <div id="report-panel" role="tabpanel" aria-labelledby={'report-tab-' + selected} tabIndex={0} className="min-w-0 space-y-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <p className="text-sm text-muted-foreground">{text('shownRange', { from: range.from, to: range.to })}</p>
      {selected === 'attendance' && <>
        <div className="space-y-2 sm:max-w-sm"><Label htmlFor="report-granularity">{text('granularity')}</Label>
          <Select id="report-granularity" value={granularity} onChange={event => { setGranularity(event.target.value as 'week' | 'month'); setProgram(allPrograms); }}>
            <option value="month">{text('month')}</option><option value="week">{text('week')}</option>
          </Select>
        </div>
        <AttendanceReport {...view} granularity={granularity} selected={program} onSelect={setProgram} />
      </>}
      {selected === 'members' && <MembersReport {...view} />}
      {selected === 'revenue' && <RevenueReport {...view} />}
    </div>
  </Page>;
}
export function ReportsPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <LoadingState />;
  if (bootstrap.isError) return <ErrorState onRetry={() => void bootstrap.refetch()} />;
  const { gym, session } = bootstrap.data;
  if (!session) return <Alert variant="error">{text('noAccess')}</Alert>;
  return <ReportsWorkspace key={gym.id + session.userId} gymId={gym.id} userId={session.userId} timezone={gym.timezone} roles={session.roles} />;
}
