// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { minorUnitsToInput } from '@plaingym/shared/money';
import type { AttendanceReportQuery, ReportRangeQuery } from '@plaingym/shared/contracts';
import { LoadingState, EmptyState, ErrorState } from '../../components/ui/states.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { PageSection } from '../../components/ui/page.js';
import type { ReportClient } from './api.js';
import { text, attendanceTable, membersTable, revenueTable, allPrograms, programKey } from './data.js';
import { ReportChart } from './chart.js';
import { DataTable } from './table.js';

function Result<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  return children(query.data);
}
const empty = () => <EmptyState title={text('empty')} description={text('emptyHelp')} />;
const filename = (report: string, range: ReportRangeQuery, suffix = '') => `${report}-${range.from}-${range.to}${suffix}.csv`;
// Switching tabs reuses a recently read report while keeping explicit retries available.
const staleTime = 60_000;
export interface ReportViewProps { gymId: string; userId: string; range: ReportRangeQuery; client: ReportClient }
export function AttendanceReport({ gymId, userId, range, client, granularity, selected, onSelect }: ReportViewProps & {
  granularity: AttendanceReportQuery['granularity']; selected: string; onSelect: (program: string) => void;
}) {
  const query = useQuery({ queryKey: ['reports', gymId, userId, 'attendance', range, granularity],
    staleTime, queryFn: ({ signal }) => client.attendance({ ...range, granularity }, signal) });
  const model = useMemo(() => {
    const data = query.data;
    if (!data) return undefined;
    const programs = new Map(data.buckets.flatMap(bucket => bucket.programs.map(program => [programKey(program.programId), program.programName ?? text('unassigned')] as const)));
    const table = attendanceTable(data, selected);
    const values = data.buckets.map(bucket => selected === allPrograms ? bucket.totals.checkIns
      : bucket.programs.find(program => programKey(program.programId) === selected)?.checkIns ?? 0);
    return { programs, table, values, periods: data.buckets.map(bucket => bucket.startDate), series: [{ label: text('checkIns'), values }] };
  }, [query.data, selected]);
  return <Result query={query}>{() => {
    const { programs, table, values, periods, series } = model!;
    return <PageSection title={text('attendance')}>
      <div className="max-w-full space-y-2 sm:max-w-sm"><Label htmlFor="report-program">{text('program')}</Label>
        <Select id="report-program" value={selected} onChange={event => onSelect(event.target.value)}>
          <option value={allPrograms}>{text('allPrograms')}</option>
          {[...programs].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
      </div>
      <p className="text-sm text-muted-foreground">{text('attendanceHelp')}</p>
      {values.every(value => value === 0) && empty()}
      {periods.length > 0 && <ReportChart title={text('attendanceChart')} periods={periods} series={series} />}
      <DataTable title={text('attendanceTable')} table={table} filename={filename('attendance', range, '-' + granularity)} />
    </PageSection>;
  }}</Result>;
}
export function MembersReport({ gymId, userId, range, client }: ReportViewProps) {
  const query = useQuery({ queryKey: ['reports', gymId, userId, 'members', range], staleTime, queryFn: ({ signal }) => client.members(range, signal) });
  const model = useMemo(() => query.data && ({ table: membersTable(query.data),
    periods: query.data.buckets.map(bucket => bucket.startDate), series: [
      { label: text('new'), values: query.data.buckets.map(bucket => bucket.new) },
      { label: text('cancelled'), values: query.data.buckets.map(bucket => bucket.cancelled) },
      { label: text('activeAtEnd'), values: query.data.buckets.map(bucket => bucket.activeAtEnd), line: true },
    ] }), [query.data]);
  return <Result query={query}>{data => <PageSection title={text('members')}>
    <p className="text-sm text-muted-foreground">{text('membersHelp')}</p>
    {data.buckets.every(bucket => bucket.activeAtStart === 0 && bucket.activeAtEnd === 0 && bucket.frozenAtEnd === 0
      && bucket.new === 0 && bucket.imported === 0 && bucket.cancelled === 0) && empty()}
    {data.buckets.length > 0 && <ReportChart title={text('membersChart')} periods={model!.periods} series={model!.series} />}
    <DataTable title={text('membersTable')} table={model!.table} filename={filename('members', range)} />
  </PageSection>}</Result>;
}
export function RevenueReport({ gymId, userId, range, client }: ReportViewProps) {
  const query = useQuery({ queryKey: ['reports', gymId, userId, 'revenue', range], staleTime, queryFn: ({ signal }) => client.revenue(range, signal) });
  const currencies = useMemo(() => query.data?.currencies.map(currency => ({ ...currency,
    table: revenueTable(currency, query.data!.timezone), periods: currency.buckets.map(bucket => bucket.startDate),
    series: [{ label: text('net'), values: currency.buckets.map(bucket => bucket.totals.net) }],
  })), [query.data]);
  return <Result query={query}>{data => <div className="min-w-0 space-y-6">
    <p className="text-sm text-muted-foreground">{text('revenueHelp')}</p>
    {data.currencies.length === 0 && empty()}
    {currencies!.map(currency => <PageSection key={currency.currency} title={text('revenueCurrency', { currency: currency.currency })}>
      <ReportChart title={text('revenueChart', { currency: currency.currency })} periods={currency.periods}
        series={currency.series} format={value => minorUnitsToInput(value, currency.currency)} />
      <DataTable title={text('revenueTable', { currency: currency.currency })} table={currency.table} filename={filename('revenue', range, '-' + currency.currency)} />
    </PageSection>)}
  </div>}</Result>;
}
