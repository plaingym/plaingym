// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import type { MemberBooking, PortalContext, PortalScheduleMember, PortalScheduleSession } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { ApiError } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Badge } from '../../../components/ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { portalClient, type PortalClient } from './client.js';
import { MemberPicker, usePortalMembers } from './members.js';

const text = (key: string, values?: Record<string, string | number>) => t('portal/schedule:' + key, values);
export type SessionAction =
  | { kind: 'cancelled' | 'started' | 'dropIn' | 'book' | 'waitlist' }
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
  return { kind: session.placesLeft === 0 ? 'waitlist' : 'book' };
}
function weekRange(today: string, week: number, timezone: string) {
  const start = addDays(today, week * 7), end = addDays(start, 7);
  return { start, from: zonedInstant(start, '00:00', timezone, { gap: 'shift' })!.toISOString(), to: zonedInstant(end, '00:00', timezone, { gap: 'shift' })!.toISOString() };
}
function status(booking: MemberBooking) {
  return booking.status === 'waitlisted' ? text('waitlisted', { rank: booking.queueRank }) : text('booked');
}

export function PortalSchedulePage({ client = portalClient, now = () => new Date() }: { client?: PortalClient; now?: () => Date }) {
  const bootstrap = useBootstrap(), cache = useQueryClient(), timezone = bootstrap.data?.gym.timezone ?? 'UTC';
  const { key, context, members, memberId, member, choose } = usePortalMembers(client);
  const [week, setWeek] = useState(0), [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string }>();
  const range = weekRange(localDate(now(), timezone), week, timezone);
  const schedule = useQuery({ queryKey: [...key, 'schedule', range.from], queryFn: () => client.schedule(range.from, range.to), staleTime: 0 });
  const change = useMutation({
    mutationFn: async (input: { action: 'book' | 'cancel'; session: PortalScheduleSession; booking?: MemberBooking; context: PortalContext; member: PortalScheduleMember }) =>
      input.action === 'book' ? client.book(input.context, input.member.id, input.session.id) : client.cancel(input.context, input.member.id, input.booking!.id),
    onMutate: () => setMessage(undefined),
    onSuccess: (row, input) => setMessage({ tone: 'success', text: row.status === 'cancelled' ? text('cancelledSaved', { name: input.member.name })
      : row.status === 'waitlisted' ? text('waitlistSaved', { name: input.member.name, rank: row.queueRank }) : text('bookedSaved', { name: input.member.name }) }),
    onError: error => setMessage({ tone: 'error', text: text(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error') }),
    onSettled: () => cache.invalidateQueries({ queryKey: [...key, 'schedule'] }),
  });
  const dateLabel = new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' });
  const timeLabel = new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  const whenLabel = new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
  const names = new Map(members.data?.map(row => [row.id, row.name]));
  if (context.isPending || members.isPending) return <LoadingState />;
  if (context.isError || members.isError) return <ErrorState message={text('error')} onRetry={() => { void context.refetch(); void members.refetch(); }} />;
  const days = new Map<string, PortalScheduleSession[]>();
  for (const session of schedule.data ?? []) {
    const day = localDate(new Date(session.startsAt), timezone);
    days.set(day, [...days.get(day) ?? [], session]);
  }
  const current = now();
  return <Page>
    <PageHeader title={text('title')} description={text('description')} />
    <MemberPicker label={text('member')} members={members.data} value={memberId} onChange={id => { setMessage(undefined); choose(id); }} />
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Button variant="outline" disabled={week <= 0} onClick={() => setWeek(week - 1)}>{text('previousWeek')}</Button>
      <p className="text-center text-sm font-medium sm:flex-1" aria-live="polite">{text('weekOf', { date: dateLabel.format(new Date(range.from)) })}</p>
      <Button variant="outline" onClick={() => setWeek(week + 1)}>{text('nextWeek')}</Button>
    </div>
    {message && <Alert role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</Alert>}
    {schedule.isPending ? <LoadingState label={text('loading')} />
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
                    <p className="break-words font-semibold">{session.name}</p>
                    <p className="text-sm text-muted-foreground">{timeLabel.formatRange(new Date(session.startsAt), new Date(session.endsAt))}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {session.status === 'cancelled' ? <Badge tone="destructive">{text('sessionCancelled')}</Badge>
                      : session.capacity === null ? <Badge tone="muted">{text('dropIn')}</Badge>
                        : session.placesLeft === 0 ? <Badge tone="warning">{text('full')}</Badge>
                          : <Badge tone="muted">{text('placesLeft', { count: session.placesLeft ?? 0 })}</Badge>}
                  </div>
                </div>
                {session.bookings.length > 0 && <ul className="space-y-1 text-sm" aria-label={text('householdPlaces')}>
                  {session.bookings.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2">
                    <span className="break-words">{names.get(row.memberId) ?? text('member')}</span>
                    <Badge tone={row.status === 'booked' ? 'success' : 'warning'}>{status(row)}</Badge></li>)}
                </ul>}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {action.kind === 'book' || action.kind === 'waitlist'
                    ? <Button disabled={busy} onClick={() => run('book')} aria-label={text(action.kind === 'book' ? 'bookNamed' : 'waitlistNamed', { name: member!.name, session: session.name })}>
                      {text(action.kind === 'book' ? 'book' : 'joinWaitlist')}</Button>
                    : action.kind === 'cancel'
                      ? <Button variant="outline" disabled={busy} onClick={() => run('cancel', action.booking)} aria-label={text(action.booking.status === 'waitlisted' ? 'leaveNamed' : 'cancelNamed', { name: member!.name, session: session.name })}>
                        {text(action.booking.status === 'waitlisted' ? 'leaveWaitlist' : 'cancel')}</Button>
                      : <p className="text-sm text-muted-foreground">{action.kind === 'opens' ? text('opens', { when: whenLabel.format(action.at) })
                        : action.kind === 'locked' ? text('locked') : action.kind === 'dropIn' ? text('dropInHelp')
                          : action.kind === 'cancelled' ? text('sessionCancelled') : text('started')}</p>}
                  {action.kind === 'cancel' && <p className="text-sm text-muted-foreground">{text('cancelUntil', { when: whenLabel.format(new Date(session.cancelBefore)) })}</p>}
                </div>
              </li>;
            })}</ul>
          </PageSection>)}
  </Page>;
}
/** The registered portal page, with the production client. */
export function PortalScheduleView() { return <PortalSchedulePage />; }
