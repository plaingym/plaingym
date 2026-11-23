// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { answer, portalTestCache, storedFor, stubHouseholdLists } from '../household/test-cache.test-helper.js';
import type { PortalScheduleSession } from '@plaingym/shared/contracts';
import { ApiError } from '../../../lib/api.js';
import { breaksAnywhere } from '../../../components/ui/wrap.test-helper.js';
import { BookingConflictError, type PortalClient } from './client.js';
import { PortalSchedulePage, PortalScheduleView, sessionAction } from './page.js';
import { registration } from './registrations.js';
import { registration as checkin } from '../checkin/registrations.js';
import { registration as progress } from '../progress/registrations.js';

const bootstrapTimezone = vi.hoisted(() => ({ value: 'UTC' }));
vi.mock('../../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { id: 'gym', timezone: bootstrapTimezone.value }, session: { userId: 'user' } }, isPending: false, isError: false }) }));
const parent = '00000000-0000-7000-8000-000000000001', child = '00000000-0000-7000-8000-000000000002', id = '00000000-0000-7000-8000-000000000003';
const now = new Date('2026-10-29T16:00:00Z');
const session: PortalScheduleSession = { id, name: 'Fundamentals', startsAt: '2026-10-30T18:00:00.000Z', endsAt: '2026-10-30T19:00:00.000Z', coachId: null,
  capacity: 10, status: 'scheduled', revision: 1, bookingOpensAt: '2026-10-23T00:00:00.000Z', cancelBefore: '2026-10-30T17:00:00.000Z', placesLeft: 4, bookings: [] };
const booking = { id: 'booking', memberId: child, sessionId: id, createdAt: '2026-10-29T12:00:00.000Z', status: 'booked' as const, waitlistPosition: null, queueRank: null, cancelledAt: null };
const client = { context: vi.fn(), members: vi.fn(), schedule: vi.fn(), book: vi.fn(), cancel: vi.fn() };
const payer = { role: 'payer', memberId: parent };
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.context.mockResolvedValue(answer(payer));
  client.members.mockResolvedValue(answer([{ id: parent, name: 'Pat Parent' }, { id: child, name: 'Casey Parent' }]));
  client.schedule.mockResolvedValue(answer([session]));
  client.book.mockResolvedValue(booking);
  client.cancel.mockResolvedValue({ ...booking, status: 'cancelled', cancelledAt: now.toISOString() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function view(node: ReactNode) {
  const cache = portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={cache}>{node}</QueryClientProvider>), cache };
}
const page = () => view(<PortalSchedulePage client={client as unknown as PortalClient} now={() => now} />);
const cardName = (name: string) => ({ name: (label: string) => label.startsWith(name + ', ') });
const openClass = async (user: ReturnType<typeof userEvent.setup>, name = session.name) => {
  await user.click(await screen.findByRole('button', cardName(name)));
  return within(screen.getByRole('dialog', { name }));
};
function screenWidth(wide: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}

describe('portal schedule actions', () => {
  it('offers cancel only through the cutoff and booking only once the window opens', () => {
    const booked = { ...session, bookings: [booking] };
    expect(sessionAction(booked, child, new Date(session.cancelBefore)).kind).toBe('cancel');
    expect(sessionAction(booked, child, new Date(Date.parse(session.cancelBefore) + 1)).kind).toBe('locked');
    expect(sessionAction(booked, parent, now).kind).toBe('book');
    expect(sessionAction({ ...session, placesLeft: 0 }, parent, now).kind).toBe('waitlist');
    expect(sessionAction({ ...session, placesLeft: 0 }, parent, new Date(session.cancelBefore)).kind).toBe('waitlist');
    expect(sessionAction({ ...session, placesLeft: 0 }, parent, new Date(Date.parse(session.cancelBefore) + 1)).kind).toBe('closed');
    expect(sessionAction(session, parent, new Date(Date.parse(session.cancelBefore) + 1)).kind).toBe('book');
    expect(sessionAction(session, parent, new Date('2026-10-22T23:59:59Z'))).toMatchObject({ kind: 'opens' });
    expect(sessionAction({ ...session, capacity: null, placesLeft: null }, parent, now).kind).toBe('dropIn');
    expect(sessionAction({ ...session, status: 'cancelled' }, parent, now).kind).toBe('cancelled');
    expect(sessionAction(booked, child, new Date(session.startsAt)).kind).toBe('started');
  });
  it('registers the three enabled portal pages with member permissions', () => {
    expect(registration.portalNav?.[0]).toMatchObject({ enabled: true, href: '/portal/schedule', permission: { kind: 'member', capability: 'bookings.self' } });
    expect(registration.portalPages?.[0]).toMatchObject({ enabled: true, component: PortalScheduleView });
    expect(checkin.portalNav?.[0]).toMatchObject({ enabled: true, permission: { capability: 'checkin.manage' } });
    expect(progress.portalNav?.[0]).toMatchObject({ enabled: true, permission: { capability: 'progress.read' } });
  });
});
describe('portal schedule page', () => {
  it('shows seven day columns with today highlighted and one compact card per class', async () => {
    screenWidth(true);
    const fixtures: [Partial<PortalScheduleSession> & { name: string }, string][] = [
      [{ name: 'Bookable' }, 'Places left: 4'],
      [{ name: 'Full with a waitlist', placesLeft: 0 }, 'Full — waitlist open'],
      [{ name: 'Closed', placesLeft: 0, cancelBefore: '2026-10-29T15:00:00Z' }, 'Full'],
      [{ name: 'Booked', bookings: [{ ...booking, memberId: parent }] }, 'Booked'],
      [{ name: 'Waiting', bookings: [{ ...booking, memberId: parent, status: 'waitlisted', waitlistPosition: 2, queueRank: 2 }] }, 'Waitlist — position 2'],
      [{ name: 'Soon', bookingOpensAt: '2026-10-30T15:00:00Z' }, 'Opens Oct 30, 2026, 3:00 PM'],
      [{ name: 'In progress', startsAt: '2026-10-29T15:00:00Z', endsAt: '2026-10-29T17:00:00Z' }, 'Started'],
      [{ name: 'Called off', status: 'cancelled' }, 'Cancelled'],
      [{ name: 'Drop-in', capacity: null, placesLeft: null }, 'No booking needed'],
      [{ name: 'Past cutoff', cancelBefore: '2026-10-29T15:00:00Z', bookings: [{ ...booking, memberId: parent }] }, 'Booked'],
    ];
    client.schedule.mockResolvedValue(answer(fixtures.map(([overrides], index) => ({ ...session, id: String(index), ...overrides }))));
    page();
    const today = await screen.findByRole('region', { name: 'Thursday, October 29' });
    expect(today.classList.contains('border-primary')).toBe(true);
    expect(screen.getAllByRole('region')).toHaveLength(7);
    expect(screen.getAllByText('No classes')).toHaveLength(5);
    const cards = screen.getAllByRole('region').flatMap(day => within(day).queryAllByRole('button'));
    expect(cards).toHaveLength(fixtures.length);
    for (const [{ name }, badge] of fixtures) {
      const card = screen.getByRole('button', cardName(name));
      expect(card.getAttribute('aria-label')).toMatch(/\d:\d\d.*:/);
      expect(card.getAttribute('aria-label')?.endsWith(badge)).toBe(true);
      expect(card.querySelectorAll('.rounded-full')).toHaveLength(1);
      expect(card.querySelector('.rounded-full')?.textContent).toBe(badge);
    }
    expect(within(screen.getByRole('button', cardName('Called off'))).getByText('Called off').classList.contains('line-through')).toBe(true);
  });
  it('groups and sorts gym-local dates in the phone agenda, with classes opening in a dialog', async () => {
    screenWidth(false);
    bootstrapTimezone.value = 'America/New_York';
    try {
      client.schedule.mockResolvedValue(answer([
        { ...session, startsAt: '2026-10-30T02:00:00Z', endsAt: '2026-10-30T03:00:00Z' },
        { ...session, id: 'early', name: 'Earlier class', startsAt: '2026-10-29T20:00:00Z', endsAt: '2026-10-29T21:00:00Z' },
        { ...session, id: 'later', name: 'Later class', startsAt: '2026-10-31T02:00:00Z', endsAt: '2026-10-31T03:00:00Z' },
      ]));
      page();
      const agenda = await screen.findByRole('list', { name: 'Class schedule' });
      expect(within(agenda).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Thursday, October 29Today', 'Friday, October 30']);
      expect(within(agenda).getAllByRole('button').map(button => button.getAttribute('aria-label')?.split(', ')[0])).toEqual(['Earlier class', 'Fundamentals', 'Later class']);
      const dialog = await openClass(userEvent.setup());
      expect(dialog.getByRole('button', { name: 'Book Fundamentals for Pat Parent' })).toBeDefined();
    } finally { bootstrapTimezone.value = 'UTC'; }
  });
  it('rolls the shown week over at gym-local midnight without a focus event', async () => {
    vi.useFakeTimers();
    bootstrapTimezone.value = 'America/New_York';
    try {
      // Sunday 23:59 in the gym; the clocks fell back earlier that day.
      vi.setSystemTime(new Date('2026-11-02T04:59:00Z'));
      client.schedule.mockResolvedValue(answer([]));
      view(<PortalSchedulePage client={client as unknown as PortalClient} />);
      await act(() => vi.advanceTimersByTimeAsync(50));
      expect(screen.getByText('Week of Monday, October 26')).toBeDefined();
      expect(client.schedule).toHaveBeenLastCalledWith('2026-10-26T04:00:00.000Z', '2026-11-02T05:00:00.000Z');
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(screen.getByText('Week of Monday, November 2')).toBeDefined();
      expect(client.schedule).toHaveBeenLastCalledWith('2026-11-02T05:00:00.000Z', '2026-11-09T05:00:00.000Z');
    } finally { bootstrapTimezone.value = 'UTC'; vi.useRealTimers(); }
  });
  it('does not re-arm its timer when the same data renders again', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(window, 'setTimeout');
    try {
      vi.setSystemTime(now);
      const cache = portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false } } });
      const tree = () => <QueryClientProvider client={cache}><PortalSchedulePage client={client as unknown as PortalClient} /></QueryClientProvider>;
      const result = render(tree());
      await act(() => vi.advanceTimersByTimeAsync(50));
      expect(screen.getByText('Fundamentals')).toBeDefined();
      const calls = timeout.mock.calls.length;
      vi.setSystemTime(new Date(now.getTime() + 1_000));
      result.rerender(tree());
      expect(timeout).toHaveBeenCalledTimes(calls);
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
  it('schedules only the nearest boundary, advances to the next cutoff, and refreshes on focus', async () => {
    let instant = now;
    let crossDuringEffect = false;
    const readNow = () => {
      const result = instant;
      if (crossDuringEffect) { instant = new Date(instant.getTime() + 1); crossDuringEffect = false; }
      return result;
    };
    const firstCutoff = now.getTime() + 5_000, nextCutoff = now.getTime() + 10_000;
    client.schedule.mockResolvedValue(answer([
      { ...session, cancelBefore: new Date(firstCutoff).toISOString(), bookings: [{ ...booking, memberId: parent }] },
      { ...session, id: 'second', name: 'Advanced', cancelBefore: new Date(nextCutoff).toISOString(), bookings: [{ ...booking, memberId: parent }] },
      { ...session, id: 'cancelled', name: 'Cancelled class', status: 'cancelled', cancelBefore: new Date(now.getTime() + 1_000).toISOString() },
    ]));
    const timeout = vi.spyOn(window, 'setTimeout'), clear = vi.spyOn(window, 'clearTimeout'), interval = vi.spyOn(window, 'setInterval');
    try {
      const result = view(<PortalSchedulePage client={client as unknown as PortalClient} now={readNow}/>);
      const user = userEvent.setup();
      const dialog = await openClass(user);
      const timers = timeout.mock.calls.filter(([, delay]) => delay === 5_001);
      expect(timers).toHaveLength(1);
      expect(timeout.mock.calls.some(([, delay]) => delay === 10_001 || delay === 1_001)).toBe(false);
      expect(interval.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);
      // Render at the inclusive cutoff, then cross it before the effect reads the clock.
      instant = new Date(firstCutoff); crossDuringEffect = true;
      act(() => { (timers[0]![0] as () => void)(); });
      expect(dialog.getByRole('button', { name: /Cancel booking: Fundamentals/ })).toBeDefined();
      const catchup = timeout.mock.calls.filter(([, delay]) => delay === 0).at(-1);
      expect(catchup).toBeDefined();
      act(() => { (catchup![0] as () => void)(); });
      expect(timeout.mock.calls.filter(([, delay]) => delay === 5_000)).toHaveLength(1);
      expect(dialog.queryByRole('button', { name: /Cancel booking: Fundamentals/ })).toBeNull();
      expect(dialog.getByText(/cancellation cutoff has passed/)).toBeDefined();
      await user.click(dialog.getByRole('button', { name: 'Close' }));
      const advanced = await openClass(user, 'Advanced');
      expect(advanced.getByRole('button', { name: /Cancel booking: Advanced/ })).toBeDefined();
      instant = new Date(nextCutoff + 1);
      act(() => { window.dispatchEvent(new Event('focus')); });
      expect(advanced.queryByRole('button', { name: /Cancel booking: Advanced/ })).toBeNull();
      result.unmount();
      expect(clear).toHaveBeenCalled();
      const calls = timeout.mock.calls.length;
      act(() => { window.dispatchEvent(new Event('focus')); });
      expect(timeout).toHaveBeenCalledTimes(calls);
    } finally { timeout.mockRestore(); clear.mockRestore(); interval.mockRestore(); }
  });
  it('refreshes the cancellation cutoff only when the document becomes visible', async () => {
    vi.useFakeTimers();
    const cutoff = Date.parse(session.cancelBefore);
    let instant = new Date(cutoff - 5_000);
    client.schedule.mockResolvedValue(answer([{ ...session, bookings: [{ ...booking, memberId: parent }] }]));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const listen = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    try {
      const result = view(<PortalSchedulePage client={client as unknown as PortalClient} now={() => instant} />);
      await act(() => vi.advanceTimersByTimeAsync(50));
      fireEvent.click(screen.getByRole('button', cardName('Fundamentals')));
      const dialog = within(screen.getByRole('dialog', { name: 'Fundamentals' }));
      const cancelButton = { name: /Cancel booking: Fundamentals/ };
      expect(dialog.getByRole('button', cancelButton)).toBeDefined();

      instant = new Date(cutoff + 1);
      hidden.mockReturnValue(true);
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(dialog.getByRole('button', cancelButton)).toBeDefined();

      hidden.mockReturnValue(false);
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(dialog.queryByRole('button', cancelButton)).toBeNull();

      const registration = listen.mock.calls.filter(([event]) => event === 'visibilitychange').at(-1);
      expect(registration).toBeDefined();
      remove.mockClear();
      result.unmount();
      expect(remove).toHaveBeenCalledWith('visibilitychange', registration![1]);
    } finally {
      hidden.mockRestore();
      listen.mockRestore();
      remove.mockRestore();
      vi.useRealTimers();
    }
  });
  it('shows a full class without a waitlist action after the cutoff', async () => {
    client.schedule.mockResolvedValue(answer([{ ...session, placesLeft: 0 }]));
    view(<PortalSchedulePage client={client as unknown as PortalClient} now={() => new Date(Date.parse(session.cancelBefore) + 1)} />);
    const dialog = await openClass(userEvent.setup());
    expect(dialog.getByText('The waitlist is closed. The cancellation cutoff has passed.')).toBeDefined();
    expect(dialog.getByText('Full')).toBeDefined();
    expect(dialog.queryByText('Full — waitlist open')).toBeNull();
    expect(dialog.queryByRole('button', { name: /Join the waitlist/ })).toBeNull();
    expect(client.book).not.toHaveBeenCalled();
  });
  it('keeps places and both waitlist messages in English in a German browser', async () => {
    const NativeNumberFormat = Intl.NumberFormat;
    const numbers = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locale, options) {
      return new NativeNumberFormat(locale ?? 'de-DE', options);
    });
    try {
      const waiting = { ...booking, memberId: parent, status: 'waitlisted', queueRank: 2400 };
      client.schedule.mockResolvedValue(answer([{ ...session, placesLeft: 1200, bookings: [waiting] }, { ...session, id: 'full', name: 'Full class', placesLeft: 0 }]));
      client.book.mockResolvedValue({ ...waiting, queueRank: 3600 });
      const user = userEvent.setup();
      page();
      const waitingClass = await openClass(user);
      expect(waitingClass.getByText('Places left: 1,200')).toBeDefined();
      expect(waitingClass.getByText('Waitlist — position 2,400')).toBeDefined();
      await user.click(waitingClass.getByRole('button', { name: 'Close' }));
      const fullClass = await openClass(user, 'Full class');
      await user.click(fullClass.getByRole('button', { name: 'Join the waitlist: Full class for Pat Parent' }));
      expect(await fullClass.findByText('Pat Parent is on the waitlist at position 3,600.')).toBeDefined();
    } finally { numbers.mockRestore(); }
  });
  it('omits unknown waitlist positions in the booking and confirmation', async () => {
    const waiting = { ...booking, memberId: parent, status: 'waitlisted', queueRank: null };
    client.schedule.mockResolvedValue(answer([{ ...session, bookings: [waiting] }, { ...session, id: 'full', name: 'Full class', placesLeft: 0 }]));
    client.book.mockResolvedValue(waiting);
    const user = userEvent.setup();
    page();
    expect(await screen.findByText('Waitlist')).toBeDefined();
    expect(screen.queryByText(/position 0/)).toBeNull();
    const dialog = await openClass(user, 'Full class');
    await user.click(dialog.getByRole('button', { name: 'Join the waitlist: Full class for Pat Parent' }));
    expect(await dialog.findByText('Pat Parent is on the waitlist.')).toBeDefined();
  });
  it('a parent books a place for a child and sees the household places', async () => {
    const user = userEvent.setup(); page();
    const card = await screen.findByRole('button', cardName('Fundamentals'));
    expect(client.schedule).toHaveBeenCalledWith('2026-10-26T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
    expect(screen.getByText('Week of Monday, October 26')).toBeDefined();
    const picker = screen.getByLabelText('Booking for');
    await user.selectOptions(picker, child);
    const dialog = await openClass(user);
    client.schedule.mockResolvedValue(answer([{ ...session, placesLeft: 3, bookings: [booking] }]));
    await user.click(dialog.getByRole('button', { name: 'Book Fundamentals for Casey Parent' }));
    await dialog.findByText('Casey Parent is booked.');
    expect(client.book).toHaveBeenCalledTimes(1);
    expect(client.book).toHaveBeenCalledWith(payer, child, id, 'household');
    const places = await dialog.findByRole('list', { name: 'Household places' });
    expect(within(places).getByText('Casey Parent')).toBeDefined();
    expect(dialog.getByRole('button', { name: 'Cancel booking: Fundamentals for Casey Parent' })).toBeDefined();
    expect(within(card).getByText('Booked')).toBeDefined();
    await user.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('status').textContent).toBe('Casey Parent is booked.');
    await openClass(user);
    fireEvent.change(picker, { target: { value: parent } });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(card).getByText('Places left: 3')).toBeDefined();
  });
  it('keeps a booking result from showing inside another class dialog', async () => {
    client.schedule.mockResolvedValue(answer([session, { ...session, id: 'second', name: 'Advanced' }]));
    const user = userEvent.setup(); page();
    const first = await openClass(user);
    await user.click(first.getByRole('button', { name: 'Book Fundamentals for Pat Parent' }));
    await first.findByText('Pat Parent is booked.');
    await user.click(first.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('status').textContent).toBe('Pat Parent is booked.');
    const second = await openClass(user, 'Advanced');
    expect(second.queryByText('Pat Parent is booked.')).toBeNull();
  });
  it('lets class and member names with no break opportunity wrap instead of widening the page', async () => {
    const long = 'U'.padEnd(56, 'x'), longMember = 'M' + long;
    screenWidth(false);
    client.members.mockResolvedValue(answer([{ id: parent, name: 'Pat Parent' }, { id: child, name: longMember }]));
    client.schedule.mockResolvedValue(answer([{ ...session, name: long, bookings: [booking] }]));
    page();
    const cardName = await screen.findByText(long);
    const dialog = await openClass(userEvent.setup(), long);
    // Browser checks measure overflow at 360 px and on desktop.
    for (const element of [cardName, dialog.getByRole('heading', { name: long }), dialog.getByText(longMember)]) {
      expect(breaksAnywhere(element)).toBe(true);
    }
  });
  it('hides cancel after the cutoff and reports engine conflicts without server details', async () => {
    client.schedule.mockResolvedValue(answer([{ ...session, cancelBefore: '2026-10-29T15:00:00.000Z', bookings: [{ ...booking, memberId: parent }] },
      { ...session, id: 'second', name: 'Advanced', placesLeft: 0 }]));
    client.book.mockRejectedValue(new ApiError(409, 'request_failed'));
    const user = userEvent.setup(); page();
    const locked = await openClass(user);
    expect(locked.getByText(/cancellation cutoff has passed/)).toBeDefined();
    expect(locked.queryByRole('button', { name: /Cancel booking: Fundamentals/ })).toBeNull();
    await user.click(locked.getByRole('button', { name: 'Close' }));
    const advanced = await openClass(user, 'Advanced');
    await user.click(advanced.getByRole('button', { name: 'Join the waitlist: Advanced for Pat Parent' }));
    await advanced.findByText(/This change isn't available any more/);
  });
  it('an adult member has no picker and books only for themself', async () => {
    client.context.mockResolvedValue(answer({ role: 'member', memberId: child }));
    client.members.mockResolvedValue(answer([{ id: child, name: 'Casey Parent' }]));
    const user = userEvent.setup(); page();
    const dialog = await openClass(user);
    expect(screen.queryByLabelText('Booking for')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Book Fundamentals for Casey Parent' }));
    expect(client.book).toHaveBeenCalledWith({ role: 'member', memberId: child }, child, id, 'household');
  });
  it('moves between weeks without going into the past', async () => {
    const user = userEvent.setup(); page();
    const next = await screen.findByRole('button', { name: 'Next week' });
    await openClass(user);
    expect((screen.getByRole('button', { name: 'Previous week' }) as HTMLButtonElement).disabled).toBe(true);
    client.schedule.mockResolvedValue(answer([]));
    fireEvent.click(next);
    await screen.findByText('No classes this week');
    expect(client.schedule).toHaveBeenLastCalledWith('2026-11-02T00:00:00.000Z', '2026-11-09T00:00:00.000Z');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('closes the dialog when a refetch removes the class and keeps it closed when the class returns', async () => {
    const { cache } = page();
    await openClass(userEvent.setup());
    const reload = async (sessions: PortalScheduleSession[]) => {
      client.schedule.mockResolvedValue(answer(sessions));
      await act(async () => cache.invalidateQueries({ predicate: query => query.queryKey.includes('schedule') }));
    };
    await reload([{ ...session, startsAt: '2026-11-02T18:00:00Z', endsAt: '2026-11-02T19:00:00Z' }]);
    await screen.findByText('No classes this week');
    expect(screen.queryByRole('dialog')).toBeNull();
    await reload([session]);
    await screen.findByRole('button', cardName('Fundamentals'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('never shows a schedule answered for another household than the open one, and reads the household lists again', async () => {
    const reads = stubHouseholdLists(), cache = portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false } } });
    client.schedule.mockResolvedValue(answer([session], 'other'));
    render(<QueryClientProvider client={cache}><PortalSchedulePage client={client as unknown as PortalClient} now={() => now} /></QueryClientProvider>);
    await screen.findByText("We couldn't load the schedule. Please try again.");
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    expect(screen.queryByText('Fundamentals')).toBeNull();
    expect(storedFor(cache, 'gym', 'user', 'household')).toEqual(['act-for', 'context']);
  });
});

it('shows the translated credit refusal instead of the generic booking conflict', async () => {
  const message = 'You need an unexpired class credit or an active or trial membership to book or join the waitlist. Please contact the front desk.';
  client.book.mockRejectedValue(new BookingConflictError(message));
  const user = userEvent.setup(); page();
  const dialog = await openClass(user);
  await user.click(dialog.getByRole('button', { name: 'Book Fundamentals for Pat Parent' }));
  expect(await dialog.findByText(message)).toBeDefined();
  expect(screen.queryByText(/This change isn't available/)).toBeNull();
});
