// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, useSyncExternalStore, type Key, type ReactNode } from 'react';
import { Badge } from '../../components/ui/table.js';
import { cn } from '../../lib/utils.js';

const wideQuery = '(min-width: 1024px)';
/** Whether the screen is at least `lg` wide, where seven columns fit beside the sidebar. Narrower screens (and environments without media queries) get the agenda. */
export function useWideScreen() {
  return useSyncExternalStore((notify) => {
    const query = typeof window.matchMedia === 'function' ? window.matchMedia(wideQuery) : null;
    query?.addEventListener('change', notify);
    return () => query?.removeEventListener('change', notify);
  }, () => typeof window.matchMedia === 'function' && window.matchMedia(wideQuery).matches, () => false);
}

export function dayLabel(date: string, style: 'long' | 'short' = 'long') {
  // Calendar dates carry no zone: format them at noon UTC so the label is the same everywhere.
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: style, month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
}

interface WeekLayoutProps<T> {
  days: readonly { date: string; items: readonly T[] }[];
  today: string;
  wide: boolean;
  renderItem: (item: T, compact: boolean) => ReactNode;
  itemKey: (item: T) => Key;
  agendaLabel: string;
  todayLabel: string;
  emptyDayLabel?: string | undefined;
  hideEmptyDays?: boolean;
  formatDay?: (date: string) => string;
  /** The wide layout's column heading; defaults to the browser-language short label. */
  formatShortDay?: (date: string) => string;
}

/** Display the same days as week columns or a day-by-day agenda. */
export function WeekLayout<T>({ days, today, wide, renderItem, itemKey, agendaLabel, todayLabel,
  emptyDayLabel, hideEmptyDays, formatDay = dayLabel, formatShortDay = date => dayLabel(date, 'short') }: WeekLayoutProps<T>) {
  const emptyDay = emptyDayLabel && <p className="text-sm text-muted-foreground">{emptyDayLabel}</p>;
  if (wide) return <div className="grid grid-cols-7 gap-2">{days.map(({ date, items }) => <section key={date} aria-label={formatDay(date)}
    className={cn('min-w-0 space-y-2 rounded-xl border border-border p-2', date === today && 'border-primary')}>
    <h2 className="text-sm font-semibold">{formatShortDay(date)}</h2>
    {items.length ? items.map(item => <Fragment key={itemKey(item)}>{renderItem(item, true)}</Fragment>) : emptyDay}
  </section>)}</div>;

  return <ol className="space-y-5" aria-label={agendaLabel}>
    {days.filter(({ items }) => !hideEmptyDays || items.length > 0).map(({ date, items }) => <li key={date}>
      <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">{formatDay(date)}{date === today && <Badge>{todayLabel}</Badge>}</h2>
      {items.length ? <ul className="space-y-2">{items.map(item => <li key={itemKey(item)}>{renderItem(item, false)}</li>)}</ul> : emptyDay}
    </li>)}
  </ol>;
}
