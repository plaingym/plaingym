// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { dayLabel, WeekLayout } from './week-layout.js';

afterEach(cleanup);

const props = {
  days: [
    { date: '2026-11-16', items: ['Morning class', 'Evening class'] },
    { date: '2026-11-17', items: [] },
    { date: '2026-11-18', items: ['Open training'] },
  ],
  today: '2026-11-18',
  renderItem: (item: string, compact: boolean) => <button type="button">{item} {compact ? 'compact' : 'regular'}</button>,
  itemKey: (item: string) => item,
  agendaLabel: 'Classes by day',
  todayLabel: 'Today',
  emptyDayLabel: 'No classes',
};

it('renders labelled week columns with compact items, the empty day and the current day highlight', () => {
  render(<WeekLayout {...props} wide />);
  const [monday, tuesday, wednesday] = screen.getAllByRole('region');
  expect(screen.getAllByRole('region')).toHaveLength(3);
  expect(monday!.getAttribute('aria-label')).toBe('Monday, Nov 16');
  expect(within(monday!).getByRole('heading', { name: 'Mon, Nov 16' })).toBeDefined();
  expect(within(monday!).getAllByRole('button').map(button => button.textContent)).toEqual(['Morning class compact', 'Evening class compact']);
  expect(within(tuesday!).getByText('No classes')).toBeDefined();
  expect(wednesday!.classList.contains('border-primary')).toBe(true);
  expect(within(wednesday!).getByRole('button', { name: 'Open training compact' })).toBeDefined();
});

it('renders the agenda, with the option to hide empty days', () => {
  const view = render(<WeekLayout {...props} wide={false} />);
  const agenda = screen.getByRole('list', { name: 'Classes by day' });
  expect(agenda.children).toHaveLength(3);
  const today = within(agenda).getByRole('heading', { name: /Wednesday, Nov 18/ });
  expect(within(today).getByText('Today')).toBeDefined();
  expect(within(agenda).getByText('No classes')).toBeDefined();
  expect(within(agenda).getAllByRole('button').map(button => button.textContent)).toEqual(['Morning class regular', 'Evening class regular', 'Open training regular']);

  view.rerender(<WeekLayout {...props} wide={false} hideEmptyDays />);
  expect(agenda.children).toHaveLength(2);
  expect(within(agenda).queryByRole('heading', { name: 'Tuesday, Nov 17' })).toBeNull();
  expect(within(agenda).queryByText('No classes')).toBeNull();
});

it('formats day labels in the fixed English locale', () => {
  expect(dayLabel('2026-11-16')).toBe('Monday, Nov 16');
  expect(dayLabel('2026-11-16', 'short')).toBe('Mon, Nov 16');
});
