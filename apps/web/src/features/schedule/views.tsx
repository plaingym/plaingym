// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import type { ClassSession } from '@plaingym/shared/contracts';
import { cn } from '../../lib/utils.js';
import { Badge } from '../../components/ui/table.js';
import { calendarDate, shiftDate } from './calendar.js';
import { sessionTimes, text, type ScheduleOptions } from './session.js';

const wide = '(min-width: 1024px)';
/** Whether the screen is at least `lg` wide, where seven columns fit beside the sidebar. Narrower screens (and environments without media queries) get the agenda. */
export function useWideScreen() {
  return useSyncExternalStore((notify) => {
    const query = typeof window.matchMedia === 'function' ? window.matchMedia(wide) : null;
    query?.addEventListener('change', notify);
    return () => query?.removeEventListener('change', notify);
  }, () => typeof window.matchMedia === 'function' && window.matchMedia(wide).matches, () => false);
}
export function dayLabel(date: string, style: 'long' | 'short' = 'long') {
  // Calendar dates carry no zone: format them at noon UTC so the label is the same everywhere.
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: style, month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
}
interface ViewProps { week: string; today: string; sessions: readonly ClassSession[]; options: ScheduleOptions; onOpen: (session: ClassSession) => void }
function days({ week, sessions, options }: ViewProps) {
  return Array.from({ length: 7 }, (_, day) => shiftDate(week, day)).map((date) => ({ date,
    sessions: sessions.filter((session) => calendarDate(new Date(session.startsAt), options.timezone) === date)
      .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt)) }));
}
function SessionButton({ session, options, onOpen, compact = false }: { session: ClassSession; options: ScheduleOptions; onOpen: (session: ClassSession) => void; compact?: boolean }) {
  const coach = options.coaches.find((entry) => entry.id === session.coachId)?.name;
  const cancelled = session.status === 'cancelled';
  return <button type="button" onClick={() => onOpen(session)}
    className={cn('flex min-h-11 w-full flex-col items-start gap-1 rounded-lg border border-border bg-card p-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      cancelled && 'bg-muted text-muted-foreground', compact && 'p-2')}>
    <span className={cn('font-medium tabular-nums', compact ? 'text-xs' : 'text-sm')}>{sessionTimes(session, options.timezone)}</span>
    <span className={cn('break-words font-semibold', cancelled && 'line-through', compact && 'text-sm')}>{session.name}</span>
    {coach && !compact && <span className="text-sm text-muted-foreground">{coach}</span>}
    <span className="flex flex-wrap gap-1"><Badge tone={cancelled ? 'destructive' : 'muted'}>{text(session.status)}</Badge>
      {session.kind === 'open_mat' && <Badge tone="muted">{text('open_mat')}</Badge>}</span>
  </button>;
}
/** The phone layout: one list of the week, day by day. */
export function AgendaView(props: ViewProps) {
  return <ol className="space-y-5" aria-label={text('agenda')}>{days(props).map(({ date, sessions }) => <li key={date}>
    <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">{dayLabel(date)}{date === props.today && <Badge>{text('today')}</Badge>}</h2>
    {sessions.length ? <ul className="space-y-2">{sessions.map((session) => <li key={session.id}><SessionButton session={session} options={props.options} onOpen={props.onOpen}/></li>)}</ul>
      : <p className="text-sm text-muted-foreground">{text('noSessionsDay')}</p>}
  </li>)}</ol>;
}
/** Seven columns, from `lg`. */
export function WeekView(props: ViewProps) {
  return <div className="grid grid-cols-7 gap-2">{days(props).map(({ date, sessions }) => <section key={date} aria-label={dayLabel(date)}
    className={cn('min-w-0 space-y-2 rounded-xl border border-border p-2', date === props.today && 'border-primary')}>
    <h2 className="text-sm font-semibold">{dayLabel(date, 'short')}</h2>
    {sessions.map((session) => <SessionButton key={session.id} session={session} options={props.options} onOpen={props.onOpen} compact/>)}
  </section>)}</div>;
}
