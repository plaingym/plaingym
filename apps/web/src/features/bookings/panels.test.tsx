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

const client = vi.hoisted(() => ({ roster: vi.fn(), list: vi.fn(), members: vi.fn(), session: vi.fn(), sessions: vi.fn(), book: vi.fn(), cancel: vi.fn() }));
vi.mock('./client.js', () => ({ bookingClient: client }));
vi.mock('../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { timezone: 'America/New_York' } }, isPending: false, isError: false }) }));
const memberId = '00000000-0000-7000-8000-000000000001', sessionId = '00000000-0000-7000-8000-000000000002';
const booking = { id: 'booking', memberId, sessionId, status: 'booked', waitlistPosition: null, queueRank: null };
const member = { id: memberId, firstName: 'River', lastName: 'Lee' };
const session = { id: sessionId, name: 'Fundamentals', startsAt: '2026-11-02T18:00:00Z', capacity: 2 };
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.roster.mockResolvedValue({ data: [{ displayName: 'River Lee', booking, attendance: { memberId } }], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 1 } });
  client.list.mockResolvedValue({ data: [booking], pagination: { total: 1 } });
  client.members.mockResolvedValue([member]);
  client.session.mockResolvedValue(session); client.sessions.mockResolvedValue([session]);
  client.book.mockResolvedValue(booking); client.cancel.mockResolvedValue({ ...booking, status: 'cancelled' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('staff booking panels', () => {
  it('loads a 50-person roster page with one request and no member lookups', async () => {
    client.roster.mockResolvedValue({ data: Array.from({ length: 50 }, (_, i) => ({
      displayName: `Member ${i}`, booking: { ...booking, id: `booking-${i}`, memberId: `member-${i}` }, attendance: null,
    })), pagination: { total: 50 }, counts: { booked: 50, waitlisted: 0, checkedIn: 0 } });
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Member 49');
    expect(client.roster).toHaveBeenCalledTimes(1);
    for (const method of ['members', 'session', 'sessions', 'list'] as const) expect(client[method]).not.toHaveBeenCalled();
  });
  it('retains stale rows and counts during and after a failed manual Refresh', async () => {
    const publish = vi.fn(), user = userEvent.setup();
    render(<SessionCountsProvider publish={publish}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await screen.findByText('River Lee');
    client.roster.mockRejectedValue(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('alert');
    let reject!: (error: Error) => void;
    client.roster.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByText('River Lee')).toBeDefined();
    expect(screen.getByTestId('roster-counts')).toBeDefined();
    expect(screen.queryByText('Loading bookings…')).toBeNull();
    await act(async () => { reject(new Error('still offline')); });
    expect(screen.getByText('River Lee')).toBeDefined();
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith({ booked: 1, waitlisted: 0, checkedIn: 1, stale: true }));
  });
  it('keeps the previous page and enabled form when a quiet step back fails', async () => {
    const counts = { booked: 51, waitlisted: 0, checkedIn: 0 };
    client.roster.mockResolvedValue({ data: [{ displayName: 'River Lee', booking, attendance: null }], pagination: { total: 51 }, counts });
    const publish = vi.fn(), tree = (changed: number) => <SessionCountsProvider publish={publish} changed={changed}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>;
    const user = userEvent.setup(), view = render(tree(0));
    await screen.findByText('River Lee');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('River Lee');
    let reject!: (error: Error) => void;
    client.roster.mockResolvedValueOnce({ data: [], pagination: { total: 50 }, counts: { ...counts, booked: 50 } })
      .mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    view.rerender(tree(1));
    await waitFor(() => expect(client.roster).toHaveBeenLastCalledWith(sessionId, 0));
    expect(screen.getByText('River Lee')).toBeDefined();
    expect(screen.queryByText('No bookings or check-ins yet')).toBeNull();
    expect((screen.getByLabelText('Member name') as HTMLInputElement).disabled).toBe(false);
    await act(async () => { reject(new Error('offline')); });
    expect(screen.getByText('River Lee')).toBeDefined();
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith({ ...counts, stale: true }));
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
    client.roster.mockResolvedValue({ data: [{ displayName: 'First page', booking, attendance: null }], pagination: { total: 50 }, counts: { ...counts, booked: 50 } });
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByText('First page');
    expect(client.roster).toHaveBeenLastCalledWith(sessionId, 0);
    expect(screen.queryByText('River Lee')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull();
  });
  it('shows loading again when the pager retries a page that failed to load', async () => {
    const counts = { booked: 51, waitlisted: 0, checkedIn: 0 };
    client.roster.mockResolvedValue({ data: [{ displayName: 'River Lee', booking, attendance: null }], pagination: { total: 51 }, counts });
    const user = userEvent.setup();
    render(<SessionCountsProvider publish={vi.fn()} changed={0}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await screen.findByText('River Lee');
    client.roster.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('River Lee')).toBeNull();
    let resolve!: (value: unknown) => void;
    client.roster.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(client.roster).toHaveBeenLastCalledWith(sessionId, 50);
    expect(screen.getByText('Loading bookings…')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { resolve({ data: [{ displayName: 'Second page', booking, attendance: null }], pagination: { total: 51 }, counts }); });
    await screen.findByText('Second page');
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('coalesces visibility and focus events on a single tab return', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { await Promise.resolve(); });
    expect(client.roster).toHaveBeenCalledTimes(2);
  });
  it('registers the enabled member tab and session panel with booking permissions', () => {
    expect(registration.memberTabs?.[0]).toMatchObject({ enabled: true, component: MemberBookingsPanel, permission: { kind: 'staff', capability: 'bookings.manage' } });
    expect(registration.sessionPanels?.[0]).toMatchObject({ enabled: true, component: BookingRosterPanel });
    expect(render(<><BookingRosterPanel/><MemberBookingsPanel/></>).container.textContent).toBe('');
  });
  it('distinguishes checked-in bookings, waitlisted members and walk-ins', async () => {
    client.roster.mockResolvedValue({ data: [
      { displayName: 'River Lee', booking, attendance: { memberId } },
      { displayName: 'River Lee', booking: { ...booking, id: 'waiting', memberId: 'waiting', status: 'waitlisted', queueRank: 1 }, attendance: null },
      { displayName: 'Walk In', booking: null, attendance: { memberId: 'walk-in' } },
    ], pagination: { total: 3 } });
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Waitlisted — position 1');
    expect(screen.getByText('Walk-in')).toBeDefined();
    expect(screen.getAllByText('Checked in')).toHaveLength(2);
    expect(screen.getByText('Not checked in')).toBeDefined();
  });
  it('shows whole-session counts in the heading, publishes them, and refreshes them after a booking change', async () => {
    const counts = (booked: number, waitlisted: number, checkedIn: number) => ({ booked, waitlisted, checkedIn });
    const row = { displayName: 'River Lee', booking, attendance: null };
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
  it('keeps rows and published counts stale after a quiet failure and clears the load error on recovery', async () => {
    const row = { displayName: 'River Lee', booking, attendance: null }, publish = vi.fn();
    client.roster.mockResolvedValueOnce({ data: [row], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 0 } })
      .mockResolvedValueOnce({ data: [row], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 1 } })
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ data: [], pagination: { total: 0 }, counts: { booked: 0, waitlisted: 0, checkedIn: 0 } });
    const view = render(<SessionCountsProvider publish={publish} changed={0}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    expect((await screen.findByTestId('roster-counts')).textContent).toBe('Booked 1 · 0 waitlisted · 0 checked in');
    view.rerender(<SessionCountsProvider publish={publish} changed={1}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    // The list stays on screen while the counts reload.
    expect(screen.getByText('River Lee')).toBeDefined();
    await waitFor(() => expect(screen.getByTestId('roster-counts').textContent).toBe('Booked 1 · 0 waitlisted · 1 checked in'));
    await waitFor(() => expect(publish).toHaveBeenCalledWith({ booked: 1, waitlisted: 0, checkedIn: 1, stale: false }));
    view.rerender(<SessionCountsProvider publish={publish} changed={2}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await screen.findByRole('alert');
    expect(screen.getByText('River Lee')).toBeDefined();
    expect(screen.getByText('These bookings and counts may be out of date. Refresh to try again.')).toBeDefined();
    expect(screen.getByTestId('roster-counts').textContent).toBe('Booked 1 · 0 waitlisted · 1 checked in');
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith({ booked: 1, waitlisted: 0, checkedIn: 1, stale: true }));
    view.rerender(<SessionCountsProvider publish={publish} changed={3}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await screen.findByText('No bookings or check-ins yet');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/may be out of date/)).toBeNull();
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith({ booked: 0, waitlisted: 0, checkedIn: 0, stale: false }));
  });
  it('keeps an unread error and uses current server names on a quiet reload', async () => {
    const other = { ...booking, id: 'other', memberId: 'other-member' };
    const page = (rows: unknown[]) => ({ data: rows, pagination: { total: rows.length }, counts: { booked: rows.length, waitlisted: 0, checkedIn: 0 } });
    client.roster.mockResolvedValueOnce(page([{ displayName: 'River Lee', booking, attendance: null }])).mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(page([{ displayName: 'River Lee', booking, attendance: null }, { displayName: 'Sam Ng', booking: other, attendance: null }]));
    client.cancel.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    const tree = (changed: number) => <SessionCountsProvider publish={() => undefined} changed={changed}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>;
    const user = userEvent.setup(); const view = render(tree(0));
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    await screen.findByRole('alert');
    view.rerender(tree(1));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    view.rerender(tree(2));
    await screen.findByText('Sam Ng');
    expect(screen.getByRole('alert').textContent).toContain('cancellation cutoff');
    expect(screen.queryByText('Loading bookings…')).toBeNull();
  });
  it('clears an action error on a manual Refresh', async () => {
    client.cancel.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));
    await screen.findByText('River Lee');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows progress when Refresh has nothing to keep, and allows one Refresh at a time', async () => {
    client.roster.mockRejectedValueOnce(new Error('down'));
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByRole('alert');
    const page = { data: [{ displayName: 'River Lee', booking, attendance: null }], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 0 } };
    let resolve!: (value: typeof page) => void;
    client.roster.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByText('Loading bookings…')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { resolve(page); });
    await screen.findByText('River Lee');
    client.roster.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('River Lee')).toBeDefined();
    await act(async () => { resolve(page); });
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('starts over after a cancellation, so the cancelled row is not left actionable', async () => {
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    const cancel = await screen.findByRole('button', { name: 'Cancel booking for River Lee' });
    client.roster.mockReturnValueOnce(new Promise(() => undefined));
    await user.click(cancel);
    await screen.findByText('Booking cancelled.');
    expect(screen.queryByRole('button', { name: 'Cancel booking for River Lee' })).toBeNull();
    expect(screen.getByText('Loading bookings…')).toBeDefined();
  });
  it('clears an action error when a booking saves on the first page', async () => {
    client.cancel.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    await screen.findByRole('alert');
    await user.type(screen.getByLabelText('Member name'), 'River');
    await user.click(screen.getByRole('button', { name: 'Search members' }));
    await user.selectOptions(screen.getByLabelText('Member', { exact: true }), memberId);
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    await screen.findByText('Booking saved.');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('shows the empty state beside an unread action error', async () => {
    client.roster.mockResolvedValueOnce({ data: [{ displayName: 'River Lee', booking, attendance: null }], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 0 } })
      .mockResolvedValue({ data: [], pagination: { total: 0 }, counts: { booked: 0, waitlisted: 0, checkedIn: 0 } });
    client.cancel.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    const tree = (changed: number) => <SessionCountsProvider publish={() => undefined} changed={changed}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>;
    const user = userEvent.setup(), view = render(tree(0));
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    await screen.findByRole('alert');
    view.rerender(tree(1));
    await screen.findByText('No bookings or check-ins yet');
    expect(screen.getByRole('alert').textContent).toContain('cancellation cutoff');
  });
  it('marks a quiet failure stale only when it kept something to show', async () => {
    const tree = (changed: number) => <SessionCountsProvider publish={() => undefined} changed={changed}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>;
    client.roster.mockRejectedValue(new Error('down'));
    const view = render(tree(0));
    await screen.findByRole('alert');
    view.rerender(tree(1));
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByText(/may be out of date/)).toBeNull();
    view.unmount();
    client.roster.mockReset();
    client.roster.mockResolvedValueOnce({ data: [], pagination: { total: 0 }, counts: { booked: 0, waitlisted: 0, checkedIn: 0 } }).mockRejectedValue(new Error('down'));
    const next = render(tree(0));
    await screen.findByText('No bookings or check-ins yet');
    next.rerender(tree(1));
    await screen.findByText(/may be out of date/);
    expect(screen.getByTestId('roster-counts').textContent).toBe('Booked 0 · 0 waitlisted · 0 checked in');
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
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
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
  it('skips polling and focus while hidden, refreshes on becoming visible, and removes its listeners', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = render(<BookingRosterPanel sessionId={sessionId}/>);
      await screen.findByText('River Lee');
      hidden.mockReturnValue(true);
      act(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
      expect(client.roster).toHaveBeenCalledTimes(1);
      hidden.mockReturnValue(false);
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));
      view.unmount();
      act(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
      expect(client.roster).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it.each([0, 50, 51])('returns to the last page when a quiet refresh shrinks the roster to %i entries', async total => {
    const page = (count: number, empty = false) => ({ data: empty ? [] : [{ displayName: 'River Lee', booking, attendance: null }], pagination: { total: count }, counts: { booked: count, waitlisted: 0, checkedIn: 0 } });
    client.roster.mockResolvedValue(page(101));
    const publish = vi.fn(), tree = (changed: number) => <SessionCountsProvider publish={publish} changed={changed}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>;
    const user = userEvent.setup(), view = render(tree(0));
    await screen.findByText('River Lee');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('River Lee');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('River Lee');
    expect(client.roster).toHaveBeenLastCalledWith(sessionId, 100);
    client.roster.mockResolvedValueOnce(page(total, true)).mockResolvedValue(page(total, total === 0));
    view.rerender(tree(1));
    await waitFor(() => expect(client.roster).toHaveBeenLastCalledWith(sessionId, total > 50 ? 50 : 0));
    if (total === 0) await screen.findByText('No bookings or check-ins yet');
    else await screen.findByText('River Lee');
  });
  it('shows updated server names on manual Refresh', async () => {
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    client.roster.mockResolvedValue({ data: [{ displayName: 'Renamed Lee', booking, attendance: null }], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 0 } });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Renamed Lee');
    expect(screen.queryByText('River Lee')).toBeNull();
  });
  it('clears the published counts when the panel closes, and member tabs publish none', async () => {
    client.roster.mockResolvedValue({ data: [], pagination: { total: 0 }, counts: { booked: 1, waitlisted: 0, checkedIn: 0 } });
    const publish = vi.fn(); const view = render(<SessionCountsProvider publish={publish}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await waitFor(() => expect(publish).toHaveBeenCalledWith({ booked: 1, waitlisted: 0, checkedIn: 0, stale: false }));
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
    client.roster.mockResolvedValueOnce({ data: [{ displayName: 'River Lee', booking, attendance: null }], pagination: { total: 51 } })
      .mockResolvedValue({ data: [], pagination: { total: 51 } });
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee'); await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(client.roster).toHaveBeenLastCalledWith(sessionId, 50));
    await screen.findByText('No bookings or check-ins yet');
  });
});
