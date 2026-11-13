// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

vi.mock('../../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { id: 'gym', timezone: 'UTC' }, session: { userId: 'user' } }, isPending: false, isError: false }) }));
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function view(node: ReactNode) {
  const cache = portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={cache}>{node}</QueryClientProvider>);
}
const page = () => view(<PortalSchedulePage client={client as unknown as PortalClient} now={() => now} />);

describe('portal schedule actions', () => {
  it('offers cancel only through the cutoff and booking only once the window opens', () => {
    const booked = { ...session, bookings: [booking] };
    expect(sessionAction(booked, child, new Date(session.cancelBefore)).kind).toBe('cancel');
    expect(sessionAction(booked, child, new Date(Date.parse(session.cancelBefore) + 1)).kind).toBe('locked');
    expect(sessionAction(booked, parent, now).kind).toBe('book');
    expect(sessionAction({ ...session, placesLeft: 0 }, parent, now).kind).toBe('waitlist');
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
  it('a parent books a place for a child and sees the household places', async () => {
    const user = userEvent.setup(); page();
    await screen.findByText('Fundamentals');
    expect(client.schedule).toHaveBeenCalledWith('2026-10-29T00:00:00.000Z', '2026-11-05T00:00:00.000Z');
    await user.selectOptions(screen.getByLabelText('Booking for'), child);
    client.schedule.mockResolvedValue(answer([{ ...session, placesLeft: 3, bookings: [booking] }]));
    await user.click(screen.getByRole('button', { name: 'Book Fundamentals for Casey Parent' }));
    await screen.findByText('Casey Parent is booked.');
    expect(client.book).toHaveBeenCalledWith(payer, child, id, 'household');
    const places = await screen.findByRole('list', { name: 'Household places' });
    expect(within(places).getByText('Casey Parent')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancel booking: Fundamentals for Casey Parent' })).toBeDefined();
  });
  it('lets class and member names with no break opportunity wrap instead of widening the page', async () => {
    const long = 'U'.padEnd(56, 'x');
    client.members.mockResolvedValue(answer([{ id: parent, name: 'Pat Parent' }, { id: child, name: long }]));
    client.schedule.mockResolvedValue(answer([{ ...session, name: long + 'c', bookings: [booking] }]));
    page();
    // jsdom has no layout; the 360 px overflow itself is checked in the End-to-end suite (demo-join.spec.ts).
    for (const element of [await screen.findByText(long + 'c'), within(await screen.findByRole('list', { name: 'Household places' })).getByText(long)]) {
      expect(breaksAnywhere(element)).toBe(true);
    }
  });
  it('hides cancel after the cutoff and reports engine conflicts without server details', async () => {
    client.schedule.mockResolvedValue(answer([{ ...session, cancelBefore: '2026-10-29T15:00:00.000Z', bookings: [{ ...booking, memberId: parent }] },
      { ...session, id: 'second', name: 'Advanced', placesLeft: 0 }]));
    client.book.mockRejectedValue(new ApiError(409, 'request_failed'));
    const user = userEvent.setup(); page();
    await screen.findByText(/cancellation cutoff has passed/);
    expect(screen.queryByRole('button', { name: /Cancel booking: Fundamentals/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Join the waitlist: Advanced for Pat Parent' }));
    await screen.findByText(/This change isn't available any more/);
  });
  it('an adult member has no picker and books only for themself', async () => {
    client.context.mockResolvedValue(answer({ role: 'member', memberId: child }));
    client.members.mockResolvedValue(answer([{ id: child, name: 'Casey Parent' }]));
    const user = userEvent.setup(); page();
    await screen.findByText('Fundamentals');
    expect(screen.queryByLabelText('Booking for')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Book Fundamentals for Casey Parent' }));
    expect(client.book).toHaveBeenCalledWith({ role: 'member', memberId: child }, child, id, 'household');
  });
  it('moves between weeks without going into the past', async () => {
    const user = userEvent.setup(); page();
    await screen.findByText('Fundamentals');
    expect((screen.getByRole('button', { name: 'Previous week' }) as HTMLButtonElement).disabled).toBe(true);
    client.schedule.mockResolvedValue(answer([]));
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    await screen.findByText('No classes this week');
    expect(client.schedule).toHaveBeenLastCalledWith('2026-11-05T00:00:00.000Z', '2026-11-12T00:00:00.000Z');
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
  await user.click(await screen.findByRole('button', { name: 'Book Fundamentals for Pat Parent' }));
  expect(await screen.findByText(message)).toBeDefined();
  expect(screen.queryByText(/This change isn't available/)).toBeNull();
});
