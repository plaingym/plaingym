// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookingRosterPanel, MemberBookingsPanel } from './panels.js';
import { registration } from './registrations.js';
import { ApiError } from '../../lib/api.js';
import { Dialog } from '../../components/ui/dialog.js';
import { SessionCountsProvider, useSessionChanged, type SessionCounts } from '../../lib/session-summary.js';
import { memo, useState } from 'react';

const client = vi.hoisted(() => ({ roster: vi.fn(), list: vi.fn(), members: vi.fn(), session: vi.fn(), sessions: vi.fn(), book: vi.fn(), cancel: vi.fn() }));
vi.mock('./client.js', () => ({ bookingClient: client }));
vi.mock('../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { timezone: 'America/New_York' } }, isPending: false, isError: false }) }));
const memberId = '00000000-0000-7000-8000-000000000001', sessionId = '00000000-0000-7000-8000-000000000002';
const booking = { id: 'booking', memberId, sessionId, status: 'booked', waitlistPosition: null, queueRank: null };
const member = { id: memberId, firstName: 'River', lastName: 'Lee' };
const session = { id: sessionId, name: 'Fundamentals', startsAt: '2026-11-02T18:00:00Z', cancelBefore: '2026-11-02T17:00:00Z', capacity: 2 };
beforeEach(() => {
  vi.setSystemTime(new Date('2026-11-02T16:00:00Z'));
  for (const mock of Object.values(client)) mock.mockReset();
  client.roster.mockResolvedValue({ data: [{ displayName: 'River Lee', booking, attendance: { memberId } }], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 1 } });
  client.list.mockResolvedValue({ data: [booking], pagination: { total: 1 } });
  client.members.mockResolvedValue([member]);
  client.session.mockResolvedValue(session); client.sessions.mockResolvedValue([session]);
  client.book.mockResolvedValue(booking); client.cancel.mockResolvedValue({ ...booking, status: 'cancelled' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
/** The session roster's confirmation replaces the roster in place, so a session dialog never opens a second dialog. */
const confirmation = () => screen.findByRole('form', { name: 'Cancel this booking?' });
/** The session roster confirms first; tick the named notice boxes, type an optional note, then confirm. */
async function cancelFromRoster(user: ReturnType<typeof userEvent.setup>, boxes: readonly ('Email' | 'Text')[] = [], note = '') {
  await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
  const form = await confirmation();
  for (const box of boxes) await user.click(within(form).getByRole('checkbox', { name: box }));
  if (note) await user.type(within(form).getByLabelText('Note for the email (optional)'), note);
  await user.click(within(form).getByRole('button', { name: 'Cancel booking' }));
}
/** A refused roster cancellation shows its error in the confirmation; Keep booking returns to the roster with it. */
async function keepAfterRefusal(user: ReturnType<typeof userEvent.setup>) {
  const form = await confirmation();
  await within(form).findByRole('alert');
  await user.click(within(form).getByRole('button', { name: 'Keep booking' }));
  await screen.findByRole('alert');
}
describe('staff booking panels', () => {
  it.each(['roster', 'member'] as const)('closes an open %s waitlist form one millisecond after the exact cutoff', async kind => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(session.cancelBefore) - (kind === 'roster' ? 250 : 0)));
    try {
      await act(async () => { render(kind === 'roster' ? <BookingRosterPanel sessionId={sessionId}/> : <MemberBookingsPanel memberId={memberId}/>); });
      if (kind === 'roster') {
        const combo = screen.getByRole('combobox', { name: 'Member' });
        fireEvent.change(combo, { target: { value: 'River' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        fireEvent.keyDown(combo, { key: 'ArrowDown' });
        fireEvent.keyDown(combo, { key: 'Enter' });
      } else fireEvent.change(screen.getByLabelText('Class', { exact: true }), { target: { value: sessionId } });
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.queryByRole('checkbox')).toBeNull();
      await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Book a place' }).closest('form')!); });
      expect(client.book).toHaveBeenCalledWith({ memberId, sessionId, allowWaitlist: false });
    } finally { cleanup(); vi.useRealTimers(); }
  });
  it.each(['roster', 'member'] as const)('hides the %s waitlist option when loaded after the cutoff', async kind => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(session.cancelBefore) + 1);
    render(kind === 'roster' ? <BookingRosterPanel sessionId={sessionId}/> : <MemberBookingsPanel memberId={memberId}/>);
    if (kind === 'member') {
      await waitFor(() => expect(client.sessions).toHaveBeenCalled());
      await screen.findByRole('option', { name: /Fundamentals/ });
      fireEvent.change(screen.getByLabelText('Class', { exact: true }), { target: { value: sessionId } });
    } else { await screen.findByText('River Lee'); await waitFor(() => expect(client.session).toHaveBeenCalledWith(sessionId)); }
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('keeps the roster form bookable without a waitlist when the cutoff lookup fails', async () => {
    client.session.mockRejectedValue(new Error('offline'));
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee'); await waitFor(() => expect(client.session).toHaveBeenCalledWith(sessionId));
    fireEvent.change(screen.getByRole('combobox', { name: 'Member' }), { target: { value: 'River' } });
    fireEvent.click(await screen.findByRole('option', { name: 'River Lee' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Book a place' }).closest('form')!); });
    expect(client.book).toHaveBeenCalledWith({ memberId, sessionId, allowWaitlist: false });
  });
  it('loads a 50-person roster page with one request and no member lookups', async () => {
    client.roster.mockResolvedValue({ data: Array.from({ length: 50 }, (_, i) => ({
      displayName: `Member ${i}`, booking: { ...booking, id: `booking-${i}`, memberId: `member-${i}` }, attendance: null,
    })), pagination: { total: 50 }, counts: { booked: 50, waitlisted: 0, checkedIn: 0 } });
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Member 49');
    expect(client.roster).toHaveBeenCalledTimes(1);
    expect(client.session).toHaveBeenCalledOnce(); // The form reads the cutoff; roster rows need no lookups.
    for (const method of ['members', 'sessions', 'list'] as const) expect(client[method]).not.toHaveBeenCalled();
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
    expect((screen.getByRole('combobox', { name: 'Member' }) as HTMLInputElement).disabled).toBe(false);
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
    client.roster.mockResolvedValueOnce({ data: [row], pagination: { total: 51 }, counts: counts(1200, 2400, 3600) })
      .mockResolvedValue({ data: [row], pagination: { total: 50 }, counts: counts(3, 1, 3) });
    const Probe = () => { const [seen, setSeen] = useState<SessionCounts | null>(null);
      return <><p data-testid="top">{seen ? `${seen.booked}/${seen.waitlisted}/${seen.checkedIn}` : 'none'}</p>
        <SessionCountsProvider publish={setSeen}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider></>; };
    const user = userEvent.setup(); render(<Probe/>);
    expect((await screen.findByTestId('roster-counts')).textContent).toBe('Booked 1,200 · 2,400 waitlisted · 3,600 checked in');
    await waitFor(() => expect(screen.getByTestId('top').textContent).toBe('1200/2400/3600'));
    await cancelFromRoster(user);
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
    await cancelFromRoster(user);
    await keepAfterRefusal(user);
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
    await cancelFromRoster(user);
    await keepAfterRefusal(user);
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
    await screen.findByRole('button', { name: 'Cancel booking for River Lee' });
    client.roster.mockReturnValueOnce(new Promise(() => undefined));
    await cancelFromRoster(user);
    await screen.findByText('Booking cancelled.');
    expect(screen.queryByRole('button', { name: 'Cancel booking for River Lee' })).toBeNull();
    expect(screen.getByText('Loading bookings…')).toBeDefined();
  });
  it('clears an action error when a booking saves on the first page', async () => {
    client.cancel.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await cancelFromRoster(user);
    await keepAfterRefusal(user);
    await user.type(screen.getByRole('combobox', { name: 'Member' }), 'River');
    await user.click(await screen.findByRole('option', { name: 'River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    await screen.findByText('Booking saved.');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('keeps the member picker selection and waitlist choice while confirming another booking', async () => {
    const user = userEvent.setup();
    const nextMember = { id: '00000000-0000-7000-8000-000000000003', firstName: 'Alex', lastName: 'Kim' };
    client.members.mockResolvedValue([nextMember]);
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await user.type(await screen.findByRole('combobox', { name: 'Member' }), 'Alex');
    await user.click(await screen.findByRole('option', { name: 'Alex Kim' }));
    await user.click(screen.getByRole('checkbox', { name: /waitlist/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel booking for River Lee' }));
    const form = await confirmation();
    expect(screen.queryByRole('combobox', { name: 'Member' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Keep booking' }));
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    expect(client.book).toHaveBeenCalledWith({ memberId: nextMember.id, sessionId, allowWaitlist: false });
    expect(client.cancel).not.toHaveBeenCalled();
  });
  it('shows the empty state beside an unread action error', async () => {
    client.roster.mockResolvedValueOnce({ data: [{ displayName: 'River Lee', booking, attendance: null }], pagination: { total: 1 }, counts: { booked: 1, waitlisted: 0, checkedIn: 0 } })
      .mockResolvedValue({ data: [], pagination: { total: 0 }, counts: { booked: 0, waitlisted: 0, checkedIn: 0 } });
    client.cancel.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    const tree = (changed: number) => <SessionCountsProvider publish={() => undefined} changed={changed}><BookingRosterPanel sessionId={sessionId}/></SessionCountsProvider>;
    const user = userEvent.setup(), view = render(tree(0));
    await cancelFromRoster(user);
    await keepAfterRefusal(user);
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
    client.book.mockResolvedValue({ ...booking, status: 'waitlisted', queueRank: 1200 });
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    expect(screen.queryByRole('button', { name: 'Search members' })).toBeNull();
    await user.type(screen.getByRole('combobox', { name: 'Member' }), 'River');
    await user.click(await screen.findByRole('option', { name: 'River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    await screen.findByText('Added to the waitlist at position 1,200.');
    expect(client.members).toHaveBeenCalledWith('River');
    expect(client.book).toHaveBeenCalledWith({ memberId, sessionId, allowWaitlist: true });
  });
  it('finds a member in one field and books the ID chosen with the keyboard', async () => {
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const combo = screen.getByRole('combobox', { name: 'Member' });
    await user.type(combo, 'Ri');
    expect(await screen.findByRole('option', { name: 'River Lee' })).toBeDefined();
    expect(client.members).toHaveBeenLastCalledWith('Ri');
    await user.keyboard('{ArrowDown}{Enter}');
    expect((combo as HTMLInputElement).value).toBe('River Lee');
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    expect(client.book).toHaveBeenCalledWith({ memberId, sessionId, allowWaitlist: true });
  });
  it('looks up a trimmed query after 250 ms and only from two characters', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => { render(<BookingRosterPanel sessionId={sessionId}/>); });
      const combo = screen.getByRole('combobox', { name: 'Member' });
      fireEvent.change(combo, { target: { value: ' R ' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(client.members).not.toHaveBeenCalled();
      fireEvent.change(combo, { target: { value: '  River  ' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(249); });
      expect(client.members).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(client.members).toHaveBeenCalledWith('River');
    } finally { vi.useRealTimers(); }
  });
  it('ignores a superseded lookup so an older response cannot offer a member under newer text', async () => {
    const older = { ...member, id: 'older-member', firstName: 'River', lastName: 'Lee' };
    const newer = { ...member, id: 'newer-member', firstName: 'Lee', lastName: 'Park' };
    let replyOlder!: (rows: (typeof member)[]) => void, replyNewer!: (rows: (typeof member)[]) => void;
    client.members.mockImplementation((query: string) => new Promise(resolve => {
      if (query === 'Ri') replyOlder = resolve; else replyNewer = resolve;
    }));
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const combo = screen.getByRole('combobox', { name: 'Member' });
    await user.type(combo, 'Ri');
    await waitFor(() => expect(client.members).toHaveBeenCalledWith('Ri'));
    await user.clear(combo); await user.type(combo, 'Lee');
    await waitFor(() => expect(client.members).toHaveBeenCalledWith('Lee'));
    await act(async () => { replyNewer([newer]); });
    await screen.findByRole('option', { name: 'Lee Park' });
    await act(async () => { replyOlder([older]); });
    await waitFor(() => expect(screen.queryByRole('option', { name: 'River Lee' })).toBeNull());
    expect(screen.getAllByRole('option').map(row => row.textContent)).toEqual(['Lee Park']);
    await user.click(screen.getByRole('option', { name: 'Lee Park' }));
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    expect(client.book).toHaveBeenCalledWith({ memberId: 'newer-member', sessionId, allowWaitlist: true });
  });
  it('clears the chosen member when the text changes and disables booking until another is chosen', async () => {
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const combo = screen.getByRole('combobox', { name: 'Member' });
    await user.type(combo, 'River');
    await user.click(await screen.findByRole('option', { name: 'River Lee' }));
    expect((screen.getByRole('button', { name: 'Book a place' }) as HTMLButtonElement).disabled).toBe(false);
    await user.type(combo, 'x');
    expect(screen.queryByRole('option', { name: 'River Lee' })).toBeNull();
    expect((combo as HTMLInputElement).value).toBe('River Leex');
    expect((screen.getByRole('button', { name: 'Book a place' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(combo); await user.type(combo, 'River');
    await user.click(await screen.findByRole('option', { name: 'River Lee' }));
    expect((screen.getByRole('button', { name: 'Book a place' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows noMembers for a completed lookup with no rows', async () => {
    client.members.mockResolvedValue([]);
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    await user.type(screen.getByRole('combobox', { name: 'Member' }), 'Zed');
    await screen.findByText('No matching members');
    expect((screen.getByRole('button', { name: 'Book a place' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps the form and selected session when a member lookup fails', async () => {
    client.members.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([member]);
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const combo = screen.getByRole('combobox', { name: 'Member' });
    await user.type(combo, 'Ri');
    expect((await screen.findByRole('alert')).textContent).toContain('Could not update bookings');
    expect(screen.getByRole('combobox', { name: 'Member' })).toBeDefined();
    expect(client.session).toHaveBeenCalledWith(sessionId);
    await user.type(combo, 'v');
    await user.click(await screen.findByRole('option', { name: 'River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    expect(client.book).toHaveBeenCalledWith({ memberId, sessionId, allowWaitlist: true });
  });
  it('disables the member picker while a booking saves', async () => {
    let save!: (value: typeof booking) => void;
    client.book.mockReturnValue(new Promise(resolve => { save = resolve; }));
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const combo = screen.getByRole('combobox', { name: 'Member' });
    await user.type(combo, 'River');
    await user.click(await screen.findByRole('option', { name: 'River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Book a place' }));
    await waitFor(() => expect((combo as HTMLInputElement).disabled).toBe(true));
    await act(async () => { save(booking); });
    await waitFor(() => expect((combo as HTMLInputElement).disabled).toBe(false));
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
    expect(client.members).not.toHaveBeenCalled();
  });
  it('rejects a cancellation beside the kept choices and note, and retries them unchanged', async () => {
    const user = userEvent.setup(); client.cancel.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    render(<BookingRosterPanel sessionId={sessionId}/>);
    await cancelFromRoster(user, ['Email', 'Text'], 'Class moved');
    const form = await confirmation();
    expect((await within(form).findByRole('alert')).textContent).toContain('cancellation cutoff');
    for (const name of ['Email', 'Text']) expect((within(form).getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByLabelText('Note for the email (optional)') as HTMLTextAreaElement).value).toBe('Class moved');
    await user.click(within(form).getByRole('button', { name: 'Cancel booking' }));
    await screen.findByText('Booking cancelled.');
    expect(client.cancel.mock.calls).toEqual([['booking', { channels: ['email', 'sms'], note: 'Class moved' }], ['booking', { channels: ['email', 'sms'], note: 'Class moved' }]]);
    expect(screen.queryByRole('form', { name: 'Cancel this booking?' })).toBeNull();
  });
  it('keeps the confirmation inside the session dialog: Escape guards a draft and an untouched one closes only that dialog', async () => {
    const user = userEvent.setup(), close = vi.fn();
    render(<Dialog title="Class details" closeLabel="Close" onClose={close}><BookingRosterPanel sessionId={sessionId}/></Dialog>);
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    let form = await confirmation();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(within(form).getByRole('checkbox', { name: 'Email' }));
    await user.type(within(form).getByLabelText('Note for the email (optional)'), 'Class moved');
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(close).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    form = await confirmation();
    expect((within(form).getByLabelText('Note for the email (optional)') as HTMLTextAreaElement).value).toBe('Class moved');
    // Keep booking leaves the confirmation and drops its draft. Escape on an untouched one closes the one dialog, once.
    await user.click(within(form).getByRole('button', { name: 'Keep booking' }));
    expect(screen.queryByRole('form', { name: 'Cancel this booking?' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel booking for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Cancel booking for River Lee' }));
    await confirmation();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(close).toHaveBeenCalledOnce();
    expect(client.cancel).not.toHaveBeenCalled();
  });
  it.each([
    [[], undefined], [['Email'], { channels: ['email'] }], [['Text'], { channels: ['sms'] }], [['Email', 'Text'], { channels: ['email', 'sms'] }],
  ] as const)('confirms a roster cancellation with %j ticked', async (boxes, notice) => {
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    const form = await confirmation();
    expect(form.textContent).toContain('River Lee');
    for (const name of ['Email', 'Text']) expect((within(form).getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(false);
    expect(within(form).queryByLabelText('Note for the email (optional)')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.cancel).not.toHaveBeenCalled();
    cleanup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await cancelFromRoster(user, boxes);
    await screen.findByText('Booking cancelled.');
    expect(client.cancel).toHaveBeenCalledOnce();
    expect(client.cancel.mock.calls[0]).toEqual(notice ? ['booking', notice] : ['booking', undefined]);
    expect(screen.queryByRole('form', { name: 'Cancel this booking?' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Bookings and check-ins' }));
  });
  it('sends a note only with Email and only shows the note while Email is ticked', async () => {
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    const form = await confirmation();
    await user.click(within(form).getByRole('checkbox', { name: 'Email' }));
    await user.type(within(form).getByLabelText('Note for the email (optional)'), 'Class moved');
    await user.click(within(form).getByRole('checkbox', { name: 'Email' }));
    expect(within(form).queryByLabelText('Note for the email (optional)')).toBeNull();
    await user.click(within(form).getByRole('checkbox', { name: 'Text' }));
    await user.click(within(form).getByRole('button', { name: 'Cancel booking' }));
    await screen.findByText('Booking cancelled.');
    expect(client.cancel).toHaveBeenLastCalledWith('booking', { channels: ['sms'] });
    await cancelFromRoster(user, ['Email', 'Text'], 'See you Monday');
    await waitFor(() => expect(client.cancel).toHaveBeenCalledTimes(2));
    expect(client.cancel).toHaveBeenLastCalledWith('booking', { channels: ['email', 'sms'], note: 'See you Monday' });
  });
  it('sends nothing when the confirmation is dismissed, and the member tab cancels without asking', async () => {
    const user = userEvent.setup(); render(<BookingRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Cancel booking for River Lee' }));
    const form = await confirmation();
    await user.click(within(form).getByRole('checkbox', { name: 'Text' }));
    await user.click(within(form).getByRole('button', { name: 'Keep booking' }));
    expect(screen.queryByRole('form', { name: 'Cancel this booking?' })).toBeNull();
    expect(screen.getByText('Booked')).toBeDefined();
    expect(client.cancel).not.toHaveBeenCalled();
    cleanup(); render(<MemberBookingsPanel memberId={memberId}/>);
    await user.click(await screen.findByRole('button', { name: /^Cancel booking for Fundamentals/ }));
    await screen.findByText('Booking cancelled.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.cancel).toHaveBeenCalledWith('booking', undefined);
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
