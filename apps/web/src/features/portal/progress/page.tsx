// SPDX-License-Identifier: AGPL-3.0-only
import { dateFormatter } from '../../../lib/instant.js';
import { PortalRecovery } from '../household/recovery.js';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PortalMemberProgress } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Badge } from '../../../components/ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { Criteria } from '../../ranks/page.js';
import { portalClient, type PortalClient } from '../schedule/client.js';
import { MemberPicker, usePortalMembers } from '../schedule/members.js';

const text = (key: string, values?: Record<string, string | number>) => t('portal/progress:' + key, values);
type Rank = PortalMemberProgress['ranks'][number];
/** A rank and sub-rank as the gym named them; sub-rank 0 is the rank itself. */
export function rankLabel(ranks: readonly Rank[], rankId: string, subRank: number) {
  const rank = ranks.find(item => item.id === rankId);
  if (!rank) return text('unknownRank');
  return subRank > 0 ? text('withSubRank', { rank: rank.name, subRank: rank.subRanks[subRank - 1]?.name ?? subRank }) : rank.name;
}
function Swatch({ ranks, rankId }: { ranks: readonly Rank[]; rankId: string }) {
  const color = ranks.find(item => item.id === rankId)?.color;
  return color ? <span aria-hidden="true" className="inline-block size-4 shrink-0 rounded-full border border-border" style={{ backgroundColor: color }} /> : null;
}
export function PortalProgressPage({ client = portalClient }: { client?: PortalClient }) {
  const bootstrap = useBootstrap(), timezone = bootstrap.data?.gym.timezone ?? 'UTC';
  const { scope, members, memberId, choose } = usePortalMembers(client);
  const progress = useQuery({ queryKey: [...scope.key, 'progress', memberId], queryFn: async () => scope.own(await scope.run(() => client.progress(memberId, scope.key[4]!))).data, enabled: !!memberId, staleTime: 0 });
  // Each page of visits is checked on its own, so a later page read for another household is never added.
  const attendance = useInfiniteQuery({ queryKey: [...scope.key, 'attendance', memberId], enabled: !!memberId, initialPageParam: 0, staleTime: 0,
    queryFn: async ({ pageParam }) => scope.own(await scope.run(() => client.attendance(memberId, pageParam, scope.key[4]!))),
    getNextPageParam: last => last.pagination.offset + last.data.length < last.pagination.total ? last.pagination.offset + last.data.length : undefined });
  const date = dateFormatter('date', timezone);
  const dateTime = dateFormatter('instant', timezone);
  if (!members.data) return members.isPending || scope.settling ? <LoadingState /> : <ErrorState message={text('error')} onRetry={() => void members.refetch()} />;
  const data = progress.data, programName = (id: string | null) => data?.programs.find(item => item.id === id)?.name;
  const visits = attendance.data?.pages.flatMap(page => page.data) ?? [];
  return <Page className="max-w-3xl"><PortalRecovery moving={scope.moving}>
    <PageHeader title={text('title')} description={text('description')} />
    <MemberPicker label={text('member')} members={members.data} value={memberId} onChange={choose} />
    {progress.isPending || (!progress.data && scope.settling) ? <LoadingState label={text('loading')} />
      : progress.isError || !data ? <ErrorState message={text('error')} onRetry={() => void progress.refetch()} />
        : <>
          <PageSection title={text('ranks')}>
            {!data.programs.length ? <EmptyState title={text('noRanks')} description={text('noRanksHelp')} />
              : <ul className="space-y-3">{data.programs.map(program => {
                const criteria = data.criteria.filter(item => item.programId === program.id);
                const ready = criteria.length > 0 && criteria.every(item => item.eligible);
                return <li key={program.id} className="space-y-3 rounded-xl border border-border p-4">
                  <h3 className="break-words font-semibold">{program.name}</h3>
                  {/* The server picks the current rank with the same ordering it uses for the next step. */}
                  {program.current ? <p className="flex items-center gap-2 text-sm"><Swatch ranks={data.ranks} rankId={program.current.rankId} />
                    <span className="break-words">{text('current', { rank: rankLabel(data.ranks, program.current.rankId, program.current.subRank) })}</span></p>
                    : <p className="text-sm">{text('noCurrent')}</p>}
                  {program.next ? <div className="space-y-2">
                    <p className="flex flex-wrap items-center gap-2 text-sm"><Swatch ranks={data.ranks} rankId={program.next.rankId} />
                      <span className="break-words">{text('next', { rank: rankLabel(data.ranks, program.next.rankId, program.next.subRank) })}</span>
                      {ready && <Badge tone="success">{text('ready')}</Badge>}</p>
                    {criteria.length ? <Criteria name={program.name} criteria={criteria.map(item => ({ labelKey: item.labelKey, current: item.current, target: item.required }))} />
                      : <p className="text-sm text-muted-foreground">{text('coachDecides')}</p>}
                  </div> : <p className="text-sm text-muted-foreground">{text('noNext')}</p>}
                </li>;
              })}</ul>}
          </PageSection>
          {data.history.length > 0 && <PageSection title={text('history')}>
            <ul className="divide-y divide-border rounded-xl border border-border">{data.history.map(row => <li key={row.id} className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:justify-between">
              <span className="break-words">{programName(row.programId) ?? text('program')} · {rankLabel(data.ranks, row.rankId, row.subRank)}</span>
              <span className="text-muted-foreground">{date.format(new Date(row.promotedAt))}</span></li>)}</ul>
          </PageSection>}
        </>}
    <PageSection title={text('attendance')}>
      {attendance.isPending || (!attendance.data && scope.settling) ? <LoadingState label={text('loading')} />
        : attendance.isError ? <ErrorState message={text('error')} onRetry={() => void attendance.refetch()} />
          : !visits.length ? <EmptyState title={text('noAttendance')} />
            : <><p className="text-sm text-muted-foreground">{text('attendanceTotal', { count: attendance.data.pages[0]!.pagination.total })}</p>
              <ul className="divide-y divide-border rounded-xl border border-border">{visits.map(visit => <li key={visit.id} className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:justify-between">
                <span className="break-words">{visit.sessionName ?? text(visit.kind === 'open_mat' ? 'openMat' : 'class')}{programName(visit.programId) ? ' · ' + programName(visit.programId) : ''}</span>
                <span className="text-muted-foreground">{dateTime.format(new Date(visit.occurredAt))}</span></li>)}</ul>
              {attendance.hasNextPage && <Button variant="outline" disabled={attendance.isFetchingNextPage} onClick={() => void attendance.fetchNextPage()}>{text('more')}</Button>}</>}
    </PageSection>
  </PortalRecovery></Page>;
}
/** The registered portal page, with the production client. */
export function PortalProgressView() { return <PortalProgressPage />; }
