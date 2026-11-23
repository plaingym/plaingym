// SPDX-License-Identifier: AGPL-3.0-only
import type { ClassSession } from '@plaingym/shared/contracts';
import { cn } from '../../lib/utils.js';
import { Badge } from '../../components/ui/table.js';
import { calendarDate, shiftDate } from './calendar.js';
import { sessionTimes, text, type ScheduleOptions } from './session.js';
import { WeekLayout } from './week-layout.js';

export { dayLabel, useWideScreen } from './week-layout.js';

interface ViewProps { week: string; today: string; sessions: readonly ClassSession[]; options: ScheduleOptions; onOpen: (session: ClassSession) => void }
function days({ week, sessions, options }: ViewProps) {
  return Array.from({ length: 7 }, (_, day) => shiftDate(week, day)).map((date) => ({ date,
    items: sessions.filter((session) => calendarDate(new Date(session.startsAt), options.timezone) === date)
      .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt)) }));
}
function SessionButton({ session, options, onOpen, compact = false }: { session: ClassSession; options: ScheduleOptions; onOpen: (session: ClassSession) => void; compact?: boolean }) {
  const coach = options.coaches.find((entry) => entry.id === session.coachId)?.name;
  const cancelled = session.status === 'cancelled';
  return <button type="button" data-name-wrap="" onClick={() => onOpen(session)}
    className={cn('flex min-h-11 w-full flex-col items-start gap-1 rounded-lg border border-border bg-card p-3 text-left wrap-anywhere hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      cancelled && 'bg-muted text-muted-foreground', compact && 'p-2')}>
    <span className={cn('font-medium tabular-nums', compact ? 'text-xs' : 'text-sm')}>{sessionTimes(session, options.timezone)}</span>
    <span className={cn('wrap-anywhere font-semibold', cancelled && 'line-through', compact && 'text-sm')}>{session.name}</span>
    {coach && !compact && <span className="text-sm text-muted-foreground">{coach}</span>}
    <span className="flex flex-wrap gap-1"><Badge tone={cancelled ? 'destructive' : 'muted'}>{text(session.status)}</Badge>
      {session.kind === 'open_mat' && <Badge tone="muted">{text('open_mat')}</Badge>}</span>
  </button>;
}
function ScheduleLayout({ wide, ...props }: ViewProps & { wide: boolean }) {
  return <WeekLayout days={days(props)} today={props.today} wide={wide}
    itemKey={session => session.id}
    renderItem={(session, compact) => <SessionButton session={session} options={props.options} onOpen={props.onOpen} compact={compact} />}
    agendaLabel={text('agenda')} todayLabel={text('today')} emptyDayLabel={wide ? undefined : text('noSessionsDay')} />;
}
/** The phone layout: one list of the week, day by day. */
export function AgendaView(props: ViewProps) {
  return <ScheduleLayout {...props} wide={false} />;
}
/** Seven columns, from `lg`. */
export function WeekView(props: ViewProps) {
  return <ScheduleLayout {...props} wide />;
}
