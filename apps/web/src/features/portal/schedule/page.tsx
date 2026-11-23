// SPDX-License-Identifier: AGPL-3.0-only
import { dateFormatter } from '../../../lib/instant.js';
import { formatCount } from '../../../lib/count.js';
import { PortalRecovery } from '../household/recovery.js';
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, localDate, localMidnight } from '@plaingym/shared/time';
import type { MemberBooking, PortalContext, PortalScheduleMember, PortalScheduleSession } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { ApiError } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { cn } from '../../../lib/utils.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog, useDialogOperation } from '../../../components/ui/dialog.js';
import { Badge } from '../../../components/ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { Page, PageHeader } from '../../../components/ui/page.js';
import { BookingConflictError, portalClient, type PortalClient } from './client.js';
import { MemberPicker, usePortalMembers } from './members.js';
import { weekStart } from '../../schedule/calendar.js';
import { useWideScreen, WeekLayout } from '../../schedule/week-layout.js';

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

function weekDays(start: string, sessions: readonly PortalScheduleSession[], timezone: string) {
  const days = Array.from({ length: 7 }, (_, day) => ({ date: addDays(start, day), items: [] as PortalScheduleSession[] }));
  const byDate = new Map(days.map(({ date, items }) => [date, items]));
  for (const session of sessions) byDate.get(localDate(new Date(session.startsAt), timezone))?.push(session);
  for (const { items } of days) items.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return days;
}

/** Keeps the class dialog open while a booking or cancellation request is running, so its result lands in the class that asked. */
function KeepOpen({ busy }: { busy: boolean }) {
  useDialogOperation(busy);
  return null;
}

function placesLeft(session: PortalScheduleSession) {
  return text('placesLeft', { count: formatCount(session.placesLeft ?? 0) });
}

function classBadge(action: SessionAction, session: PortalScheduleSession, whenLabel: Intl.DateTimeFormat) {
  switch (action.kind) {
    case 'cancelled': return { tone: 'destructive', label: text('sessionCancelled') } as const;
    case 'started': return { tone: 'muted', label: text('startedBadge') } as const;
    case 'cancel':
    case 'locked': return { tone: action.booking.status === 'booked' ? 'success' : 'warning', label: status(action.booking) } as const;
    case 'dropIn': return { tone: 'muted', label: text('dropIn') } as const;
    case 'opens': return { tone: 'muted', label: text('opensBadge', { when: whenLabel.format(action.at) }) } as const;
    case 'closed': return { tone: 'warning', label: text('fullClosed') } as const;
    case 'waitlist': return { tone: 'warning', label: text('full') } as const;
    case 'book': return { tone: 'muted', label: placesLeft(session) } as const;
  }
}

export function PortalSchedulePage({ client = portalClient, now = currentTime }: { client?: PortalClient; now?: () => Date }) {
  const bootstrap = useBootstrap(), cache = useQueryClient(), timezone = bootstrap.data?.gym.timezone ?? 'UTC';
  const { scope, context, members, memberId, member, choose } = usePortalMembers(client);
  const [week, setWeek] = useState(0), [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [selection, setSelection] = useState<{ id: string; weekStart: string; memberId: string }>();
  const cardPrefix = useId();
  const restoreFocusTo = useRef<string>(null);
  useEffect(() => {
    if (selection || restoreFocusTo.current === null) return;
    document.getElementById(restoreFocusTo.current)?.focus({ preventScroll: true });
    restoreFocusTo.current = null;
  }, [selection]);
  const [tick, setTick] = useState(0);
  const wide = useWideScreen();
  const current = now(), instant = current.getTime();
  const today = localDate(current, timezone);
  const range = weekRange(today, week, timezone);
  // The real week's end, whichever week is shown: the page's relative week moves when it passes.
  const weekEnd = week === 0 ? range.to : weekRange(today, 0, timezone).to;
  const schedule = useQuery({ queryKey: [...scope.key, 'schedule', range.from], enabled: scope.ready, queryFn: async () => scope.own(await scope.run(() => client.schedule(range.from, range.to))).data, staleTime: 0 });
  useEffect(() => {
    const refresh = () => setTick(value => value + 1);
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };
    // Roll the shown week over at Monday midnight, and refresh when booking opens or a class starts,
    // without polling the whole page. `instant` is the render's clock read; the timer below reads the
    // clock again so a rerender with the same data never clears and re-arms it.
    const boundaries = [Date.parse(weekEnd), ...(schedule.data ?? []).filter(session => session.status !== 'cancelled')
      .flatMap(session => [Date.parse(session.cancelBefore) + 1, Date.parse(session.bookingOpensAt), Date.parse(session.startsAt)])]
      .filter(at => at > instant);
    const nearest = Math.min(...boundaries);
    // A boundary can pass between rendering and this effect. Refresh immediately rather than skipping it.
    const timer = Number.isFinite(nearest) ? window.setTimeout(refresh, Math.min(2_147_483_647, Math.max(0, nearest - now().getTime()))) : undefined;
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [schedule.data, now, tick, range.from, weekEnd]);
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
  const timeRange = (session: PortalScheduleSession) => timeLabel.formatRange(new Date(session.startsAt), new Date(session.endsAt));
  const names = new Map(members.data?.map(row => [row.id, row.name]));
  const days = weekDays(range.start, schedule.data ?? [], timezone);
  const session = selection?.weekStart === range.start && selection.memberId === memberId && !schedule.isError
    ? days.flatMap(day => day.items).find(item => item.id === selection.id)
    : undefined;
  if (selection && !session) setSelection(undefined);
  if (!context.data || !members.data) return context.isPending || members.isPending || scope.settling ? <LoadingState />
    : <ErrorState message={text('error')} onRetry={() => { void context.refetch(); void members.refetch(); }} />;
  const actionFor = (item: PortalScheduleSession): SessionAction => member ? sessionAction(item, member.id, current) : { kind: 'started' };
  const action = session && actionFor(session);
  const busy = change.isPending && change.variables?.session.id === session?.id;
  const run = (kind: 'book' | 'cancel', booking?: MemberBooking) => session && context.data && member && !busy
    && change.mutate({ action: kind, session, context: context.data, member, ...(booking ? { booking } : {}) });
  const result = message && <Alert variant={message.tone === 'error' ? 'error' : 'info'} focusOnReveal>{message.text}</Alert>;
  function moveWeek(offset: number) {
    setSelection(undefined);
    setWeek(value => Math.max(0, value + offset));
  }
  const cardId = (id: string) => `${cardPrefix}-${id}`;
  function closeClass(id: string) {
    // Wait for the dialog to unmount so the current opener can receive focus.
    restoreFocusTo.current = cardId(id);
    setSelection(undefined);
  }
  return <Page className="max-w-3xl lg:max-w-6xl"><PortalRecovery moving={scope.moving}>
    <PageHeader title={text('title')} description={text('description')} />
    <MemberPicker label={text('member')} members={members.data} value={memberId} onChange={id => { setSelection(undefined); setMessage(undefined); choose(id); }} />
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Button variant="outline" disabled={week <= 0} onClick={() => moveWeek(-1)}>{text('previousWeek')}</Button>
      <p className="text-center text-sm font-medium sm:flex-1" aria-live="polite">{text('weekOf', { date: dateLabel.format(new Date(range.from)) })}</p>
      <Button variant="outline" onClick={() => moveWeek(1)}>{text('nextWeek')}</Button>
    </div>
    {!session && result}
    {schedule.isPending || (!schedule.data && scope.settling) ? <LoadingState label={text('loading')} />
      : schedule.isError ? <ErrorState message={text('error')} onRetry={() => void schedule.refetch()} />
        : !days.some(day => day.items.length) ? <EmptyState title={text('empty')} description={text('emptyDescription')} />
          : <WeekLayout days={days} today={today} wide={wide} hideEmptyDays
            agendaLabel={text('title')} todayLabel={t('schedule/schedule:today')} emptyDayLabel={text('noClassesDay')}
            formatDay={date => dateLabel.format(localMidnight(date, timezone))}
            itemKey={item => item.id} renderItem={item => {
              const badge = classBadge(actionFor(item), item, whenLabel), time = timeRange(item);
              return <button type="button" id={cardId(item.id)} aria-haspopup="dialog" data-name-wrap=""
                aria-label={text('openClass', { session: item.name, time, status: badge.label })}
                onClick={() => { setMessage(undefined); setSelection({ id: item.id, weekStart: range.start, memberId }); }}
                className="flex min-h-11 w-full flex-col items-start gap-1 rounded-lg border border-border bg-card p-2 text-left wrap-anywhere hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className={cn('text-sm font-semibold', item.status === 'cancelled' && 'line-through')}>{item.name}</span>{' '}
                <span className="order-first text-xs font-medium tabular-nums">{time}</span>{' '}
                <Badge tone={badge.tone} className="max-w-full wrap-anywhere">{badge.label}</Badge>
              </button>;
            }} />}
    {session && action && <Dialog title={session.name} closeLabel={text('closeDialog')} onClose={() => closeClass(session.id)}>
      <KeepOpen busy={change.isPending} />
      <div className="space-y-3">
        {result}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <p className="text-sm text-muted-foreground">{timeRange(session)}</p>
          <div className="flex flex-wrap gap-2">
            {session.status === 'cancelled' ? <Badge tone="destructive">{text('sessionCancelled')}</Badge>
              : session.capacity === null ? <Badge tone="muted">{text('dropIn')}</Badge>
                : session.placesLeft === 0 ? <Badge tone="warning">{text(instant > Date.parse(session.cancelBefore) ? 'fullClosed' : 'full')}</Badge>
                  : <Badge tone="muted">{placesLeft(session)}</Badge>}
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
      </div>
    </Dialog>}
  </PortalRecovery></Page>;
}
/** The registered portal page, with the production client. */
export function PortalScheduleView() { return <PortalSchedulePage />; }
