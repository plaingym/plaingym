// SPDX-License-Identifier: AGPL-3.0-only
import { dateFormatter } from '../../../lib/instant.js';
import { formatCount } from '../../../lib/count.js';
import { PortalRecovery } from '../household/recovery.js';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, localDate, localMidnight } from '@plaingym/shared/time';
import type { MemberBooking, PortalContext, PortalScheduleMember, PortalScheduleSession } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { ApiError } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Badge } from '../../../components/ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { BookingConflictError, portalClient, type PortalClient } from './client.js';
import { MemberPicker, usePortalMembers } from './members.js';
import { weekStart } from '../../schedule/calendar.js';

const text = (key: string, values?: Record<string, string | number>) => t('portal/schedule:' + key, values);
const currentTime = () => new Date();
export type SessionAction =
  | { kind: 'cancelled' | 'started' | 'dropIn' | 'book' | 'waitlist' | 'closed' }
  | { kind: 'opens'; at: Date }
  | { kind: 'cancel' | 'locked'; booking: MemberBooking };
/** What the chosen member can do now. Cancel is offered only through the engine's cutoff; the server still decides. */
export function sessionAction(session: PortalScheduleSession, memberId: string, now: Date): SessionAction {
  const booking = session.bookings.find(row => row.memberId === memberId);
  if (session.status === 'cancelled') return { kind: 'cancelled' };
  if (Date.parse(session.startsAt) <= now.getTime()) return { kind: 'started' };
  if (booking) return now.getTime() <= Date.parse(session.cancelBefore) ? { kind: 'cancel', booking } : { kind: 'locked', booking };
  if (session.capacity === null) return { kind: 'dropIn' };
  if (now.getTime() < Date.parse(session.bookingOpensAt)) return { kind: 'opens', at: new Date(session.bookingOpensAt) };
  if (session.placesLeft === 0 && now.getTime() > Date.parse(session.cancelBefore)) return { kind: 'closed' };
  return { kind: session.placesLeft === 0 ? 'waitlist' : 'book' };
}
function weekRange(today: string, week: number, timezone: string) {
  const start = addDays(weekStart(today), week * 7), end = addDays(start, 7);
  return { start, from: localMidnight(start, timezone).toISOString(), to: localMidnight(end, timezone).toISOString() };
}
function status(booking: MemberBooking) {
  return booking.status === 'waitlisted' ? text(booking.queueRank === null ? 'waitlistedUnknown' : 'waitlisted', { rank: booking.queueRank === null ? '' : formatCount(booking.queueRank) }) : text('booked');
}

export function PortalSchedulePage({ client = portalClient, now = currentTime }: { client?: PortalClient; now?: () => Date }) {
  const bootstrap = useBootstrap(), cache = useQueryClient(), timezone = bootstrap.data?.gym.timezone ?? 'UTC';
  const { scope, context, members, memberId, member, choose } = usePortalMembers(client);
  const [week, setWeek] = useState(0), [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [tick, setTick] = useState(0);
  const current = now(), instant = current.getTime();
  const range = weekRange(localDate(current, timezone), week, timezone);
  const schedule = useQuery({ queryKey: [...scope.key, 'schedule', range.from], enabled: scope.ready, queryFn: async () => scope.own(await scope.run(() => client.schedule(range.from, range.to))).data, staleTime: 0 });
  useEffect(() => {
    const refresh = () => setTick(value => value + 1);
    // Also refresh when booking opens or a class starts, without polling the whole page.
    const boundaries = (schedule.data ?? []).filter(session => session.status !== 'cancelled')
      .flatMap(session => [Date.parse(session.cancelBefore) + 1, Date.parse(session.bookingOpensAt), Date.parse(session.startsAt)])
      .filter(at => at > instant);
    const nearest = Math.min(...boundaries);
    // A boundary can pass between rendering and this effect. Refresh immediately rather than skipping it.
    const timer = Number.isFinite(nearest) ? window.setTimeout(refresh, Math.min(2_147_483_647, Math.max(0, nearest - now().getTime()))) : undefined;
    window.addEventListener('focus', refresh);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refresh); };
  }, [schedule.data, now, tick, instant]);
  const change = useMutation({
    mutationFn: async (input: { action: 'book' | 'cancel'; session: PortalScheduleSession; booking?: MemberBooking; context: PortalContext; member: PortalScheduleMember }) =>
      scope.run(() => input.action === 'book' ? client.book(input.context, input.member.id, input.session.id, scope.key[4]!) : client.cancel(input.context, input.member.id, input.booking!.id, scope.key[4]!)),
    onMutate: () => setMessage(undefined),
    onSuccess: (row, input) => setMessage({ tone: 'success', text: row.status === 'cancelled' ? text('cancelledSaved', { name: input.member.name })
      : row.status === 'waitlisted' ? text(row.queueRank === null ? 'waitlistSavedUnknown' : 'waitlistSaved', { name: input.member.name, rank: row.queueRank === null ? '' : formatCount(row.queueRank) }) : text('bookedSaved', { name: input.member.name }) }),
    onError: error => setMessage({ tone: 'error', text: error instanceof BookingConflictError ? error.message : text(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error') }),
    onSettled: () => cache.invalidateQueries({ queryKey: [...scope.key, 'schedule'] }),
  });
  const dateLabel = dateFormatter('day', timezone);
  const timeLabel = dateFormatter('time', timezone);
  const whenLabel = dateFormatter('instant', timezone);
  const names = new Map(members.data?.map(row => [row.id, row.name]));
  if (!context.data || !members.data) return context.isPending || members.isPending || scope.settling ? <LoadingState />
    : <ErrorState message={text('error')} onRetry={() => { void context.refetch(); void members.refetch(); }} />;
  const days = new Map<string, PortalScheduleSession[]>();
  for (const session of schedule.data ?? []) {
    const day = localDate(new Date(session.startsAt), timezone);
    days.set(day, [...days.get(day) ?? [], session]);
  }
  return <Page className="max-w-3xl"><PortalRecovery moving={scope.moving}>
    <PageHeader title={text('title')} description={text('description')} />
    <MemberPicker label={text('member')} members={members.data} value={memberId} onChange={id => { setMessage(undefined); choose(id); }} />
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Button variant="outline" disabled={week <= 0} onClick={() => setWeek(week - 1)}>{text('previousWeek')}</Button>
      <p className="text-center text-sm font-medium sm:flex-1" aria-live="polite">{text('weekOf', { date: dateLabel.format(new Date(range.from)) })}</p>
      <Button variant="outline" onClick={() => setWeek(week + 1)}>{text('nextWeek')}</Button>
    </div>
    {message && <Alert variant={message.tone === 'error' ? 'error' : 'info'} focusOnReveal>{message.text}</Alert>}
    {schedule.isPending || (!schedule.data && scope.settling) ? <LoadingState label={text('loading')} />
      : schedule.isError ? <ErrorState message={text('error')} onRetry={() => void schedule.refetch()} />
        : !days.size ? <EmptyState title={text('empty')} description={text('emptyDescription')} />
          : [...days].map(([day, sessions]) => <PageSection key={day} title={dateLabel.format(new Date(sessions[0]!.startsAt))}>
            <ul className="space-y-3">{sessions.map(session => {
              const action = member ? sessionAction(session, member.id, current) : { kind: 'started' as const };
              const busy = change.isPending && change.variables?.session.id === session.id;
              const run = (kind: 'book' | 'cancel', booking?: MemberBooking) => context.data && member
                && change.mutate({ action: kind, session, context: context.data, member, ...(booking ? { booking } : {}) });
              return <li key={session.id} className="space-y-3 rounded-xl border border-border p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold">{session.name}</p>
                    <p className="text-sm text-muted-foreground">{timeLabel.formatRange(new Date(session.startsAt), new Date(session.endsAt))}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {session.status === 'cancelled' ? <Badge tone="destructive">{text('sessionCancelled')}</Badge>
                      : session.capacity === null ? <Badge tone="muted">{text('dropIn')}</Badge>
                        : session.placesLeft === 0 ? <Badge tone="warning">{text(current.getTime() > Date.parse(session.cancelBefore) ? 'fullClosed' : 'full')}</Badge>
                          : <Badge tone="muted">{text('placesLeft', { count: formatCount(session.placesLeft ?? 0) })}</Badge>}
                  </div>
                </div>
                {session.bookings.length > 0 && <ul className="space-y-1 text-sm" aria-label={text('householdPlaces')}>
                  {session.bookings.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2">
                    <span>{names.get(row.memberId) ?? text('member')}</span>
                    <Badge tone={row.status === 'booked' ? 'success' : 'warning'}>{status(row)}</Badge></li>)}
                </ul>}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {action.kind === 'book' || action.kind === 'waitlist'
                    ? <Button disabled={busy} onClick={() => run('book')} aria-label={text(action.kind === 'book' ? 'bookNamed' : 'waitlistNamed', { name: member!.name, session: session.name })}>
                      {text(action.kind === 'book' ? 'book' : 'joinWaitlist')}</Button>
                    : action.kind === 'cancel'
                      ? <Button variant="outline" disabled={busy} onClick={() => run('cancel', action.booking)} aria-label={text(action.booking.status === 'waitlisted' ? 'leaveNamed' : 'cancelNamed', { name: member!.name, session: session.name })}>
                        {text(action.booking.status === 'waitlisted' ? 'leaveWaitlist' : 'cancel')}</Button>
                      : action.kind !== 'cancelled' && <p className="text-sm text-muted-foreground">{action.kind === 'opens' ? text('opens', { when: whenLabel.format(action.at) })
                        : action.kind === 'locked' ? text('locked') : action.kind === 'dropIn' ? text('dropInHelp')
                          : action.kind === 'closed' ? text('waitlistClosed') : text('started')}</p>}
                  {action.kind === 'cancel' && <p className="text-sm text-muted-foreground">{text('cancelUntil', { when: whenLabel.format(new Date(session.cancelBefore)) })}</p>}
                </div>
              </li>;
            })}</ul>
          </PageSection>)}
  </PortalRecovery></Page>;
}
/** The registered portal page, with the production client. */
export function PortalScheduleView() { return <PortalSchedulePage />; }
