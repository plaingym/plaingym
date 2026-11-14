// SPDX-License-Identifier: AGPL-3.0-only
import { dateFormatter } from '../../../lib/instant.js';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { portalContracts as contracts } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { Criteria } from '../../ranks/page.js';
import { rankLabel } from '../progress/page.js';
import { portalClient, type PortalClient } from '../schedule/client.js';
import { MemberPicker, usePortalMembers } from '../schedule/members.js';
import { portalWaiverEndpoints } from '../waivers/endpoints.js';
import { PortalRecovery } from '../household/recovery.js';

const text = (key: string, values?: Record<string, string | number>) => t('portal/shell:' + key, values);
const card = 'min-w-0 space-y-3 rounded-xl border border-border p-4';
/** All summaries use the open household's key and check each answer before it enters the cache. */
export function PortalHome({ client = portalClient }: { client?: PortalClient }) {
  const bootstrap = useBootstrap(), { scope, context, members, memberId, choose } = usePortalMembers(client);
  const [from] = useState(() => new Date().toISOString());
  const to = new Date(Date.parse(from) + 30 * 86_400_000).toISOString();
  const payer = context.data?.role === 'payer';
  const schedule = useQuery({ queryKey: [...scope.key, 'home', 'schedule', from, to], enabled: scope.ready,
    queryFn: async () => scope.own(await scope.run(() => client.schedule(from, to))).data, staleTime: 0 });
  const progress = useQuery({ queryKey: [...scope.key, 'progress', memberId], enabled: scope.ready && !!memberId,
    queryFn: async () => scope.own(await scope.run(() => client.progress(memberId, scope.key[4]!))).data, staleTime: 0 });
  const pending = useQuery({ queryKey: [...scope.key, 'home', 'waivers', context.data?.role], enabled: scope.ready && !!context.data,
    queryFn: async () => scope.own(await scope.call(portalWaiverEndpoints(payer).pending, undefined, {}, { limit: 1, offset: 0 })).pagination.total, staleTime: 0 });
  const invoices = useQuery({ queryKey: [...scope.key, 'home', 'invoices'], enabled: scope.ready && payer,
    queryFn: async () => {
      const pages = await Promise.all((['open', 'past_due'] as const).map(async status =>
        scope.own(await scope.call(contracts.invoices, undefined, {}, { status, limit: 1, offset: 0 }))));
      return pages.reduce((total, page) => total + page.pagination.total, 0);
    }, staleTime: 0 });
  const next = schedule.data?.filter(session => session.status === 'scheduled' && Date.parse(session.startsAt) >= Date.now()
    && session.bookings.some(booking => booking.status === 'booked'))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  const date = dateFormatter('instant', bootstrap.data?.gym.timezone ?? 'UTC');
  return <Page className="max-w-4xl"><PortalRecovery moving={scope.moving}>
    <PageHeader title={text('welcome')} description={text('homeDescription')} />
    <div className="grid gap-4 sm:grid-cols-2">
      <PageSection className={card} title={text('nextClass')}>
        {schedule.isPending ? <LoadingState /> : schedule.isError ? <ErrorState onRetry={() => void schedule.refetch()} />
          : next ? <><p className="break-words font-semibold">{next.name}</p><p>{date.format(new Date(next.startsAt))}</p>
            <ul className="text-sm text-muted-foreground">{next.bookings.filter(booking => booking.status === 'booked').flatMap(booking => {
              const name = members.data?.find(member => member.id === booking.memberId)?.name;
              return name ? [<li key={booking.id}>{name}</li>] : [];
            })}</ul></>
            : <p>{text('noNextClass')}</p>}
        <Button asChild variant="outline"><Link to="/portal/schedule">{text('viewSchedule')}</Link></Button>
      </PageSection>
      <PageSection className={card} title={text('checkinShortcut')}>
        <p>{text('checkinHelp')}</p>
        <Button asChild><Link to="/portal/checkin">{text('showCode')}</Link></Button>
      </PageSection>
      <PageSection className={card} title={text('waiting')}>
        {context.isError && <ErrorState onRetry={() => void context.refetch()} />}
        {(context.isPending || (!!context.data && pending.isPending)) && <LoadingState />}
        {pending.isError ? <ErrorState onRetry={() => void pending.refetch()} /> : pending.data !== undefined && <p>{text(pending.data ? 'pendingWaivers' : 'noPendingWaivers', { count: pending.data })}</p>}
        <Button asChild variant="outline"><Link to="/portal/waivers">{text('viewWaivers')}</Link></Button>
        {payer && <>
          {invoices.isPending ? <LoadingState /> : invoices.isError ? <ErrorState onRetry={() => void invoices.refetch()} />
            : <p>{text(invoices.data ? 'unpaidInvoices' : 'noUnpaidInvoices', { count: invoices.data })}</p>}
          <Button asChild variant="outline"><Link to="/portal/billing">{text('viewInvoices')}</Link></Button>
        </>}
      </PageSection>
      <PageSection className={card} title={text('rankProgress')}>
        {members.isError ? <ErrorState onRetry={() => void members.refetch()} /> : members.isPending ? <LoadingState /> : <>
          <MemberPicker label={text('progressFor')} members={members.data} value={memberId} onChange={choose} />
          {memberId && progress.isPending ? <LoadingState /> : progress.isError ? <ErrorState onRetry={() => void progress.refetch()} />
            : !progress.data?.programs.length ? <p>{text('noRankProgress')}</p>
              : <ul className="space-y-4">{progress.data.programs.map(program => <li key={program.id} className="space-y-2">
                <h3 className="break-words font-semibold">{program.name}</h3>
                <p>{program.current ? text('currentRank', { rank: rankLabel(progress.data.ranks, program.current.rankId, program.current.subRank) }) : text('noCurrentRank')}</p>
                {program.next && <p>{text('nextRank', { rank: rankLabel(progress.data.ranks, program.next.rankId, program.next.subRank) })}</p>}
                <Criteria name={program.name} criteria={progress.data.criteria.filter(item => item.programId === program.id)
                  .map(item => ({ labelKey: item.labelKey, current: item.current, target: item.required }))} />
              </li>)}</ul>}
        </>}
        <Button asChild variant="outline"><Link to="/portal/progress">{text('viewProgress')}</Link></Button>
      </PageSection>
    </div>
  </PortalRecovery></Page>;
}
