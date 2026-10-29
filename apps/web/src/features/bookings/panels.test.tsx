// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookingRosterPanel, MemberBookingsPanel } from './panels.js';
import { registration } from './registrations.js';
import { ApiError } from '../../lib/api.js';

const client = vi.hoisted(() => ({ roster: vi.fn(), list: vi.fn(), members: vi.fn(), member: vi.fn(), session: vi.fn(), sessions: vi.fn(), book: vi.fn(), cancel: vi.fn() }));
vi.mock('./client.js', () => ({ bookingClient: client }));
vi.mock('../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { timezone: 'America/New_York' } }, isPending: false, isError: false }) }));
const memberId = '00000000-0000-7000-8000-000000000001', sessionId = '00000000-0000-7000-8000-000000000002';
const booking = { id: 'booking', memberId, sessionId, status: 'booked', waitlistPosition: null, queueRank: null };
const member = { id: memberId, firstName: 'River', lastName: 'Lee' };
const session = { id: sessionId, name: 'Fundamentals', startsAt: '2026-11-02T18:00:00Z', capacity: 2 };
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.roster.mockResolvedValue({ data: [{ booking, attendance: { memberId } }], pagination: { total: 1 } });
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
