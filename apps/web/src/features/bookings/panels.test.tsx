// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookingRosterPanel, MemberBookingsPanel } from './panels.js';
import { registration } from './registrations.js';
import { ApiError } from '../../lib/api.js';
import { SessionCountsProvider, useSessionChanged, type SessionCounts } from '../../lib/session-summary.js';
import { memo, useState } from 'react';

const client = vi.hoisted(() => ({ roster: vi.fn(), list: vi.fn(), members: vi.fn(), member: vi.fn(), session: vi.fn(), sessions: vi.fn(), book: vi.fn(), cancel: vi.fn() }));
vi.mock('./client.js', () => ({ bookingClient: client }));
vi.mock('../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { timezone: 'America/New_York' } }, isPending: false, isError: false }) }));
const memberId = '00000000-0000-7000-8000-000000000001', sessionId = '00000000-0000-7000-8000-000000000002';
const booking = { id: 'booking', memberId, sessionId, status: 'booked', waitlistPosition: null, queueRank: null };
const member = { id: memberId, firstName: 'River', lastName: 'Lee' };
const session = { id: sessionId, name: 'Fundamentals', startsAt: '2026-11-02T18:00:00Z', capacity: 2 };
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.roster.mockResolvedValue({ data: [{ booking, attendance: { memberId } }], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 1 } });
  client.list.mockResolvedValue({ data: [booking], pagination: { total: 1 } });
  client.member.mockResolvedValue(member); client.members.mockResolvedValue([member]);
  client.session.mockResolvedValue(session); client.sessions.mockResolvedValue([session]);
  client.book.mockResolvedValue(booking); client.cancel.mockResolvedValue({ ...booking, status: 'cancelled' });
});
afterEach(cleanup);
describe('staff booking panels', () => {
  it('registers the enabled member tab and session panel with booking permissions', () => {
    expect(registration.memberTabs?.[0]).toMatchObject({ enabled: true, component: MemberBookingsPanel, permission: { kind: 'staff', capability: 'bookings.manage' } });
    expect(registration.sessionPanels?.[0]).toMatchObject({ enabled: true, component: BookingRosterPanel });
    expect(render(<><BookingRosterPanel/><MemberBookingsPanel/></>).container.textContent).toBe('');
  });
  it('distinguishes checked-in bookings, waitlisted members and walk-ins', async () => {
    client.roster.mockResolvedValue({ data: [
      { booking, attendance: { memberId } },
      { booking: { ...booking, id: 'waiting', memberId: 'waiting', status: 'waitlisted', queueRank: 1 }, attendance: null },
      { booking: null, attendance: { memberId: 'walk-in' } },
    ], pagination: { total: 3 } });
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Waitlisted — position 1');
    expect(screen.getByText('Walk-in')).toBeDefined();
    expect(screen.getAllByText('Checked in')).toHaveLength(2);
    expect(screen.getByText('Not checked in')).toBeDefined();
  });
  it('shows whole-session counts in the heading, publishes them, and refreshes them after a booking change', async () => {
    const counts = (booked: number, waitlisted: number, checkedIn: number) => ({ booked, waitlisted, checkedIn });
    const row = { booking, attendance: null };
    // The page holds one row of 51; the counts still describe the whole session.
    client.roster.mockResolvedValueOnce({ data: [row], pagination: { total: 51 }, counts: counts(4, 2, 3) })
      .mockResolvedValue({ data: [row], pagination: { total: 50 }, counts: counts(3, 1, 3) });
    const Probe = () => { const [seen, setSeen] = useState<SessionCounts | null>(null);
      return <><p data-testid="top">{seen ? `${seen.booked}/${seen.waitlisted}/${seen.checkedIn}` : 'none'}</p>
        <SessionCountsProvider publish={setSeen}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider></>; };
    const user = userEvent.setup(); render(<Probe/>);
    expect((await screen.findByTestId('roster-counts')).textContent).toBe('Booked 4 · 2 waitlisted · 3 checked in');
    await waitFor(() => expect(screen.getByTestId('top').textContent).toBe('4/2/3'));
    await user.click(screen.getByRole('button', { name: 'Cancel booking for River Lee' }));
    await waitFor(() => expect(screen.getByTestId('roster-counts').textContent).toBe('Booked 3 · 1 waitlisted · 3 checked in'));
    await waitFor(() => expect(screen.getByTestId('top').textContent).toBe('3/1/3'));
  });
  it('reloads the counts when the dialog reports a change, and drops them when a reload fails', async () => {
    const row = { booking, attendance: null }, publish = vi.fn();
    client.roster.mockResolvedValueOnce({ data: [row], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 0 } })
      .mockResolvedValueOnce({ data: [row], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 1 } })
      .mockRejectedValue(new Error('down'));
    const view = render(<SessionCountsProvider publish={publish} changed={0}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    expect((await screen.findByTestId('roster-counts')).textContent).toBe('Booked 1 · 0 waitlisted · 0 checked in');
    view.rerender(<SessionCountsProvider publish={publish} changed={1}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    // The list stays on screen while the counts reload.
    expect(screen.getByText('River Lee')).toBeDefined();
    await waitFor(() => expect(screen.getByTestId('roster-counts').textContent).toBe('Booked 1 · 0 waitlisted · 1 checked in'));
    expect(publish).toHaveBeenCalledWith({ booked: 1, waitlisted: 0, checkedIn: 1 });
    view.rerender(<SessionCountsProvider publish={publish} changed={2}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await waitFor(() => expect(screen.queryByTestId('roster-counts')).toBeNull());
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(null));
  });
  it('keeps an unread error, shows no loading state and looks up only new members on a reload the dialog asks for', async () => {
    const other = { ...booking, id: 'other', memberId: 'other-member' };
    const page = (rows: unknown[]) => ({ data: rows, pagination: { total: rows.length }, counts: { booked: rows.length, waitlisted: 0, checkedIn: 0 } });
    client.roster.mockResolvedValueOnce(page([{ booking, attendance: null }])).mockResolvedValueOnce(page([{ booking, attendance: null }, { booking: other, attendance: null }]));
    client.member.mockImplementation(async (id: string) => id === memberId ? member : { id, firstName: 'Sam', lastName: 'Ng' });
    client.cancel.mockRejectedValueOnce(new Error('down'));
    const tree = (changed: number) => <SessionCountsProvider publish={() => undefined} changed={changed}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>;
    const user = userEvent.setup(); const view = render(tree(0));
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    await screen.findByRole('alert');
    view.rerender(tree(1));
    await screen.findByText('Sam Ng');
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByText('Loading bookings…')).toBeNull();
    expect(client.member.mock.calls.map(call => call[0])).toEqual([memberId, 'other-member']);
  });
  it('keeps the provider value stable across renders', () => {
    // A memoized consumer re-renders only when the context value changes; the provider is rerendered with the same inputs.
    const publish = vi.fn(); let renders = 0;
    const Consumer = memo(function Consumer() { useSessionChanged(); renders++; return null; });
    const tree = <SessionCountsProvider publish={publish} changed={1}><Consumer/></SessionCountsProvider>;
    const view = render(tree);
    view.rerender(<SessionCountsProvider publish={publish} changed={1}><Consumer/></SessionCountsProvider>);
    expect(renders).toBe(1);
    view.rerender(<SessionCountsProvider publish={publish} changed={2}><Consumer/></SessionCountsProvider>);
    expect(renders).toBe(2);
  });
  it('refetches the counts when the window regains focus and on an interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<BookingRosterPanel sessionId={sessionId}/>);
      await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(1));
      act(() => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await waitFor(() => expect(client.roster.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(screen.queryByText('Loading bookings…')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('clears the published counts when the panel closes, and member tabs publish none', async () => {
    client.roster.mockResolvedValue({ data: [], pagination: { total: 0 }, counts: { booked: 1, waitlisted: 0, checkedIn: 0 } });
    const publish = vi.fn(); const view = render(<SessionCountsProvider publish={publish}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await waitFor(() => expect(publish).toHaveBeenCalledWith({ booked: 1, waitlisted: 0, checkedIn: 0 }));
    view.unmount(); expect(publish).toHaveBeenLastCalledWith(null);
    publish.mockClear();
    render(<SessionCountsProvider publish={publish}><MemberBookingsPanel memberId={memberId}/></SessionCountsProvider>);
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(screen.queryByTestId('roster-counts')).toBeNull(); expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ booked: expect.anything() }));
  });
  it('searches a member, books on their behalf and reports their waitlist rank', async () => {
    client.book.mockResolvedValue({ ...booking, status: 'waitlisted', queueRank: 3 });
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    await user.type(screen.getByLabelText('Member name'), 'River');
    await user.click(screen.getByRole('button', { name: 'Search members' }));
    await user.selectOptions(screen.getByLabelText('Member', { exact: true }), memberId);
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    await screen.findByText('Added to the waitlist at position 3.');
    expect(client.members).toHaveBeenCalledWith('River');
    expect(client.book).toHaveBeenCalledWith({ memberId, sessionId, allowWaitlist: true });
  });
  it('member tab selects classes by gym-local date and can decline the waitlist', async () => {
    const user = userEvent.setup(); render(<MemberBookingsPanel memberId={memberId}/>);
    await screen.findByRole('option', { name: /Fundamentals · Nov 2, 2026, 1:00 PM/ });
    await user.selectOptions(screen.getByLabelText('Class', { exact: true }), sessionId);
    await user.click(screen.getByLabelText('Join the waitlist if the class is full'));
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    await screen.findByText('Booking saved.');
    expect(client.book).toHaveBeenCalledWith({ memberId, sessionId, allowWaitlist: false });
    expect(client.sessions).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 'America/New_York');
  });
  it('rejects a late cancellation visibly, keeps the place, and permits retry', async () => {
    const user = userEvent.setup(); client.cancel.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    expect((await screen.findByRole('alert')).textContent).toContain('cancellation cutoff');
    expect(screen.getByText('Booked')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Cancel booking for River Lee' }));
    await screen.findByText('Booking cancelled.'); expect(client.cancel).toHaveBeenCalledTimes(2);
  });
  it('does not show server details, and refresh recovers from a failed list request', async () => {
    client.roster.mockRejectedValueOnce(new Error('private SQL details'));
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('private SQL');
    await user.click(screen.getByRole('button', { name: 'Refresh' })); await screen.findByText('River Lee');
  });
  it('paginates without losing the session scope and renders empty states', async () => {
    client.roster.mockResolvedValueOnce({ data: [{ booking, attendance: null }], pagination: { total: 51 } })
      .mockResolvedValue({ data: [], pagination: { total: 51 } });
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee'); await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(client.roster).toHaveBeenLastCalledWith(sessionId, 50));
    await screen.findByText('No bookings or check-ins yet');
  });
});
