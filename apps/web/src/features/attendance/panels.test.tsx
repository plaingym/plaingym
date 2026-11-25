// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallback, useEffect, useRef, useState } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttendanceRosterPanel, MemberAttendancePanel } from './panels.js';
import { ApiError } from '../../lib/api.js';
import { registration } from './registrations.js';
import { SessionCountsProvider, usePublishSessionCounts, useSessionChanged, type SessionCounts } from '../../lib/session-summary.js';
import { Dialog } from '../../components/ui/dialog.js';
const client = vi.hoisted(() => ({ members: vi.fn(), roster: vi.fn(), record: vi.fn(), undo: vi.fn(), totals: vi.fn(), labels: vi.fn(), visitExists: vi.fn() }));
vi.mock('./client.js', () => ({ attendanceClient: client }));
vi.mock('../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { timezone: 'America/New_York' } } }) }));
const memberId = '00000000-0000-7000-8000-000000000001';
const sessionId = '00000000-0000-7000-8000-000000000002';
const programId = '00000000-0000-7000-8000-000000000003';
const tagId = '00000000-0000-7000-8000-000000000004';
const walkInId = '00000000-0000-7000-8000-000000000005';

/** A small in-memory session roster: the server's eligible order is the order rows are kept in. */
type Row = { memberId: string; displayName: string; booking: { status: 'booked' | 'waitlisted'; queueRank: number | null } | null;
  attendance: { id: string; source: string } | null };
let rows: Row[] = [], total: number | null = null;
const booked = (id: string, displayName: string): Row => ({ memberId: id, displayName, booking: { status: 'booked', queueRank: null }, attendance: null });
const waitlisted = (id: string, displayName: string, queueRank: number): Row => ({ memberId: id, displayName, booking: { status: 'waitlisted', queueRank }, attendance: null });
function page() {
  return { data: rows.map(row => ({ displayName: row.displayName, booking: row.booking && { ...row.booking, memberId: row.memberId },
    attendance: row.attendance && { ...row.attendance, memberId: row.memberId } })),
  pagination: { total: total ?? rows.length }, counts: { booked: 0, waitlisted: 0, checkedIn: rows.filter(row => row.attendance).length } };
}
/** Records a coach visit at 6:05 PM in the gym's zone and puts it on the roster. */
async function recordVisit({ memberId: id }: { memberId: string }) {
  const attendance = { id: 'visit-' + id, source: 'coach', occurredAt: '2026-11-20T23:05:00.000Z' };
  const row = rows.find(entry => entry.memberId === id);
  if (row) row.attendance = attendance;
  else rows.push({ memberId: id, displayName: id === walkInId ? 'Sam Ng' : 'Unknown', booking: null, attendance });
  return { ...attendance, memberId: id };
}
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  rows = [booked(memberId, 'River Lee')]; total = null;
  client.roster.mockImplementation(async () => page());
  client.members.mockResolvedValue([{ id: walkInId, firstName: 'Sam', lastName: 'Ng' }]);
  client.record.mockImplementation(recordVisit);
  client.undo.mockImplementation(async (id: string) => {
    const row = rows.find(entry => entry.attendance?.id === id)!;
    row.attendance = null;
    rows = rows.filter(entry => entry.booking || entry.attendance);
    return { id, memberId: row.memberId, source: 'coach' };
  });
  client.totals.mockResolvedValue({ memberId, total: 1200, classes: 1200, openMat: 1200, byProgram: [{ programId, count: 1200 }], byTag: [{ tagId, count: 1200 }] });
  client.labels.mockResolvedValue({ programs: [{ id: programId, name: 'Fundamentals', active: true }], tags: [{ id: tagId, name: 'Practice' }] });
  client.visitExists.mockImplementation(async (id: string) => rows.some(entry => entry.attendance?.id === id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const listed = () => within(screen.getByRole('list')).getAllByRole('listitem').map(item => item.textContent);
describe('registered attendance panels', () => {
  it('explains that repeat open-mat check-ins reuse the gym-local day visit', async () => {
    render(<MemberAttendancePanel memberId={memberId}/>);
    expect(await screen.findByText(/Repeat check-ins on the same gym-local day return the existing visit/)).toBeDefined();
    expect(screen.queryByText(/Each submission records a separate visit/)).toBeNull();
  });
  it('lists the eligible session roster in order with waitlist places, and never the gym-wide member list', async () => {
    rows = [booked(memberId, 'River Lee'), waitlisted('w1', 'Ada One', 1), waitlisted('w2', 'Bo Two', 2)];
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    expect(listed()).toEqual([expect.stringContaining('River Lee'), expect.stringContaining('Ada OneWaitlisted · #1'), expect.stringContaining('Bo TwoWaitlisted · #2')]);
    expect(listed()[0]).not.toContain('Waitlisted');
    expect(client.roster).toHaveBeenCalledWith(sessionId, 0);
    expect(client.members).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Search members' })).toBeNull();
  });
  it('checks in a waitlisted member without changing their place, and refreshes the roster', async () => {
    rows = [booked(memberId, 'River Lee'), waitlisted('w1', 'Ada One', 1)];
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Check in Ada One' }));
    await screen.findByRole('button', { name: 'Ada One is checked in' });
    expect(client.record).toHaveBeenCalledWith({ memberId: 'w1', sessionId, programId: null });
    expect(client.roster).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Waitlisted · #1')).toBeDefined();
    expect(screen.getByText('1 checked in')).toBeDefined();
  });
  /**
   * Stands in for the session dialog and its bookings panel. Like the real panel, each successful bookings read (after a
   * booking change, and after a check-in the dialog hears of) publishes a new counts object; a failed read with nothing on
   * screen publishes nothing, and a failed read after a success marks the shown counts stale.
   */
  function bookingsDialog(firstReadFails = false) {
    let nextChangedOutcome: 'ok' | 'stale' | null = null;
    const dialog = {
      change: (_change: () => void, _outcome?: 'ok' | 'stale') => undefined as void,
      failNextChange: () => { nextChangedOutcome = 'stale'; },
    };
    const Bookings = () => {
      const changed = useSessionChanged(), [read, setRead] = useState({ seq: 0, outcome: firstReadFails ? 'failed' : 'ok' });
      const [counts, setCounts] = useState<SessionCounts | null>(null);
      const seenChanged = useRef(changed);
      dialog.change = (change, outcome = 'ok') => { change(); setRead(value => ({ seq: value.seq + 1, outcome })); };
      useEffect(() => {
        const fromChanged = changed !== seenChanged.current;
        seenChanged.current = changed;
        const outcome = fromChanged && nextChangedOutcome ? nextChangedOutcome : read.outcome;
        if (fromChanged) nextChangedOutcome = null;
        if (outcome === 'failed') return;
        if (outcome === 'stale') { setCounts(value => value && { ...value, stale: true }); return; }
        setCounts({ booked: rows.filter(row => row.booking?.status === 'booked').length, waitlisted: rows.filter(row => row.booking?.status === 'waitlisted').length,
          checkedIn: rows.filter(row => row.attendance).length });
      }, [read, changed]);
      usePublishSessionCounts(counts);
      return null;
    };
    const Session = () => {
      const [counts, setCounts] = useState<SessionCounts | null>(null), [changed, setChanged] = useState(0);
      const notify = useCallback(() => setChanged(value => value + 1), []);
      return <SessionCountsProvider publish={setCounts} counts={counts} changed={changed} notify={notify}><Bookings/><AttendanceRosterPanel sessionId={sessionId}/></SessionCountsProvider>;
    };
    return { dialog, Session };
  }
  /** Waits until the roster has made `expected` reads and has no load in progress, then a while longer: a loop would keep counting. */
  async function settledReads(expected: number) {
    await waitFor(() => {
      expect(client.roster).toHaveBeenCalledTimes(expected);
      expect(screen.queryByText('Loading attendance…')).toBeNull();
    });
    await act(() => new Promise(resolve => setTimeout(resolve, 200)));
    expect(client.roster).toHaveBeenCalledTimes(expected);
    return expected;
  }
  it('follows booking changes made in the same session dialog without a refresh', async () => {
    rows = [booked(memberId, 'River Lee'), waitlisted('w1', 'Ada One', 1), waitlisted('w2', 'Bo Two', 2)];
    const { dialog, Session } = bookingsDialog();
    const user = userEvent.setup(); render(<Session/>);
    await screen.findByText('River Lee');
    // The roster's own read, and one that follows the bookings panel's first read.
    let reads = await settledReads(2);
    // Each successful bookings read is followed by exactly one roster read.
    const after = async (change: () => void, shown: () => void) => {
      act(() => dialog.change(change));
      await waitFor(shown);
      reads = await settledReads(reads + 1);
    };
    // A staff booking for a new member.
    await after(() => rows.splice(1, 0, booked('b2', 'Cy Three')), () => expect(listed()).toEqual([expect.stringContaining('River Lee'),
      expect.stringContaining('Cy Three'), expect.stringContaining('Ada OneWaitlisted · #1'), expect.stringContaining('Bo TwoWaitlisted · #2')]));
    // One booked member replaces another: every count stays the same, the rows do not.
    await after(() => { rows[1] = booked('b3', 'Di Four'); }, () => expect(screen.getByText('Di Four')).toBeDefined());
    expect(screen.queryByText('Cy Three')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check in Cy Three' })).toBeNull();
    // A walk-in checked in at the kiosk leaves both booking counts alone.
    await after(() => rows.push({ memberId: 'k1', displayName: 'Kim Kiosk', booking: null, attendance: { id: 'visit-k1', source: 'kiosk' } }),
      () => expect(screen.getByRole('button', { name: 'Kim Kiosk is checked in' })).toBeDefined());
    // Cancelling the first waitlisted booking moves the next member up.
    await after(() => { rows = rows.filter(row => row.memberId !== 'w1'); rows.find(row => row.memberId === 'w2')!.booking!.queueRank = 1; },
      () => expect(screen.queryByText('Ada One')).toBeNull());
    expect(listed()[2]).toContain('Bo TwoWaitlisted · #1');
    // Raising the capacity promotes the last waitlisted member.
    await after(() => { rows.find(row => row.memberId === 'w2')!.booking = { status: 'booked', queueRank: null }; },
      () => expect(screen.queryByText(/Waitlisted/)).toBeNull());
    // A check-in: one roster read from its own refresh; the bookings reload it triggered does not cause a second one.
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    reads = await settledReads(reads + 1);
    // A bookings read that fails is not followed.
    act(() => dialog.change(() => rows.push(booked('b4', 'Eve Five')), 'stale'));
    await settledReads(reads);
    expect(screen.queryByText('Eve Five')).toBeNull();
    // Its next successful read is.
    await after(() => undefined, () => expect(screen.getByText('Eve Five')).toBeDefined());
  });
  it('follows a staff booking made after the bookings panel first failed to load', async () => {
    rows = [booked(memberId, 'River Lee')];
    const { dialog, Session } = bookingsDialog(true);
    render(<Session/>);
    await screen.findByText('River Lee');
    // Nothing was published, so nothing is followed.
    await settledReads(1);
    act(() => dialog.change(() => rows.push(booked('b2', 'Cy Three'))));
    await screen.findByRole('button', { name: 'Check in Cy Three' });
    await settledReads(2);
  });
  it('keeps the rows on screen when a failed check-in\'s roster reload also fails, and Refresh recovers', async () => {
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByRole('button', { name: 'Check in River Lee' });
    client.record.mockRejectedValueOnce(new Error('offline'));
    client.roster.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.getByText(/Please try again\./)).toBeDefined();
    expect(screen.getByText('The roster could not be loaded. Refresh attendance to try again.')).toBeDefined();
    expect(listed()).toEqual([expect.stringContaining('River Lee')]);
    expect(screen.getByRole('button', { name: 'Check in River Lee' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Refresh attendance' }));
    await waitFor(() => expect(screen.queryByText('The roster could not be loaded. Refresh attendance to try again.')).toBeNull());
    expect(listed()).toEqual([expect.stringContaining('River Lee')]);
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows no rows and the load alert when the first roster read fails, and Refresh recovers', async () => {
    client.roster.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('The roster could not be loaded. Refresh attendance to try again.');
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('River Lee')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh attendance' }));
    await screen.findByRole('button', { name: 'Check in River Lee' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('drops a refused walk-in from the picker by searching again', async () => {
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const picker = screen.getByRole<HTMLInputElement>('combobox', { name: 'Check in someone else' });
    await user.type(picker, 'Sam Ng');
    await screen.findByRole('option', { name: 'Sam Ng' });
    client.record.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    client.members.mockResolvedValueOnce([]);
    await user.click(screen.getByRole('option', { name: 'Sam Ng' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Please try again.');
    await user.click(picker);
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Sam Ng' })).toBeNull());
    await waitFor(() => expect(client.members).toHaveBeenCalledTimes(2));
    expect(client.members).toHaveBeenLastCalledWith('Sam Ng');
  });
  it('shows a new waitlist place after a refresh', async () => {
    rows = [waitlisted('w1', 'Ada One', 1), waitlisted('w2', 'Bo Two', 2)];
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Waitlisted · #2');
    rows = [waitlisted('w2', 'Bo Two', 1)];
    await user.click(screen.getByRole('button', { name: 'Refresh attendance' }));
    await waitFor(() => expect(screen.queryByText('Ada One')).toBeNull());
    expect(listed()).toEqual([expect.stringContaining('Bo TwoWaitlisted · #1')]);
  });
  it('checks in a walk-in chosen from the eligible picker, lists them, and undo removes them', async () => {
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const picker = screen.getByRole('combobox', { name: 'Check in someone else' });
    await user.type(picker, 'S');
    expect(client.members).not.toHaveBeenCalled(); // One letter is too short to search.
    await user.type(picker, 'am');
    await user.click(await screen.findByRole('option', { name: 'Sam Ng' }));
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    expect(client.members).toHaveBeenLastCalledWith('Sam');
    expect(client.record).toHaveBeenCalledTimes(1);
    expect(client.record).toHaveBeenCalledWith({ memberId: walkInId, sessionId, programId: null });
    expect(screen.getByText('Sam Ng is checked in.')).toBeDefined();
    expect((picker as HTMLInputElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Undo check-in for Sam Ng' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    await waitFor(() => expect(screen.queryByText('Sam Ng')).toBeNull());
    expect(client.undo).toHaveBeenCalledWith('visit-' + walkInId);
    expect(screen.getByRole('button', { name: 'Check in River Lee' })).toBeDefined();
  });
  it('keeps the selected walk-in available after a failed save and clears the draft after retry', async () => {
    client.record.mockRejectedValueOnce(new Error('Unavailable'));
    const close = vi.fn(), user = userEvent.setup();
    render(<Dialog title="Session" closeLabel="Close session" onClose={close}><AttendanceRosterPanel sessionId={sessionId}/></Dialog>);
    await screen.findByText('River Lee');
    const picker = screen.getByRole<HTMLInputElement>('combobox', { name: 'Check in someone else' });
    await user.type(picker, 'Sam');
    await user.click(await screen.findByRole('option', { name: 'Sam Ng' }));
    await screen.findByRole('alert');
    expect(picker.value).toBe('Sam Ng');
    await user.click(picker);
    await user.keyboard('{ArrowDown}');
    await user.click(await screen.findByRole('option', { name: 'Sam Ng' }));
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    expect(client.record).toHaveBeenCalledTimes(2);
    expect(picker.value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Close session' }));
    expect(close).toHaveBeenCalledOnce();
  });
  /** The roster in a session dialog whose bookings panel reads again on `reread()`, so the roster follows with a read of its own. */
  function countsDialog() {
    let reads = 0;
    const dialog = () => <SessionCountsProvider publish={vi.fn()} counts={{ booked: ++reads, waitlisted: 0, checkedIn: 0 }}>
      <AttendanceRosterPanel sessionId={sessionId}/>
    </SessionCountsProvider>;
    const view = render(dialog());
    return { reread: async () => {
      const before = client.roster.mock.calls.length;
      view.rerender(dialog());
      await waitFor(() => expect(client.roster.mock.calls.length).toBe(before + 1));
      await act(() => new Promise(resolve => setTimeout(resolve, 50)));
    } };
  }
  /** Each visit recorded from now on needs credits, except that the next visits take the given IDs and spend a credit. */
  const needingCredits = (spent: string[] = []) => client.record.mockImplementation(async (input: { memberId: string }) => {
    const attendance = await recordVisit(input), id = spent.shift();
    if (!id) return { ...attendance, needsCredits: true };
    rows.find(row => row.memberId === input.memberId)!.attendance!.id = id;
    return { ...attendance, id, needsCredits: false };
  });
  const chooseWalkIn = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByRole('combobox', { name: 'Check in someone else' }), 'Sam');
    await user.click(await screen.findByRole('option', { name: 'Sam Ng' }));
  };
  const banner = (message: string | RegExp) => screen.getByText(message).closest('[role="status"]')!.textContent;
  it('shows a past-tense acknowledgment and its credit warning for a walk-in on another page, and keeps it', async () => {
    rows = Array.from({ length: 50 }, (_, index) => booked('booked-' + index, 'Booked ' + index));
    client.roster.mockImplementation(async (_sessionId: string, offset: number) => {
      const result = page();
      return { ...result, data: result.data.slice(offset, offset + 50) };
    });
    needingCredits();
    const user = userEvent.setup(), { reread } = countsDialog();
    await screen.findByText('Booked 0');
    await chooseWalkIn(user);
    await screen.findByText('1 checked in');
    const acknowledged = /^Checked in Sam Ng at 6:05\sPM\.$/;
    await screen.findByText(acknowledged);
    expect(screen.queryByRole('button', { name: 'Sam Ng is checked in' })).toBeNull();
    expect(screen.queryByText('Sam Ng is checked in.')).toBeNull();
    expect(banner(acknowledged)).toContain('This member needs more credits.');
    // A later read of the same page doesn't clear it: the walk-in was never listed here.
    await reread();
    expect(banner(acknowledged)).toContain('This member needs more credits.');
    expect(screen.queryByText(/is checked in\./)).toBeNull();
  });
  it('clears a walk-in banner and its credit warning when another device undoes that attendance', async () => {
    needingCredits();
    const user = userEvent.setup(), { reread } = countsDialog();
    await screen.findByText('River Lee');
    await chooseWalkIn(user);
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    expect(banner('Sam Ng is checked in.')).toContain('This member needs more credits.');
    // Another coach undoes the walk-in.
    rows = rows.filter(row => row.memberId !== walkInId);
    await reread();
    await waitFor(() => expect(screen.queryByText('Sam Ng is checked in.')).toBeNull());
    expect(screen.queryByText(/Sam Ng/)).toBeNull();
    expect(screen.queryByText(/needs more credits/)).toBeNull();
    expect(screen.getByText('0 checked in')).toBeDefined();
  });
  it('gives a replacement visit for the same member only its own feedback', async () => {
    needingCredits();
    const user = userEvent.setup(), { reread } = countsDialog();
    // A check-in from the roster row warns in the row.
    await user.click(await screen.findByRole('button', { name: 'Check in River Lee' }));
    const row = () => screen.getAllByRole('listitem')[0]!;
    await within(row()).findByRole('button', { name: 'River Lee is checked in' });
    expect(within(row()).getByRole('status').textContent).toContain('This member needs more credits.');
    // Undone on another device, then River checks in again at the kiosk: a new attendance that spent a credit.
    rows[0]!.attendance = { id: 'kiosk-visit', source: 'kiosk' };
    await reread();
    await waitFor(() => expect(screen.queryByText(/needs more credits/)).toBeNull());
    expect(within(row()).getByRole('button', { name: 'River Lee is checked in' })).toBeDefined();
    // A walk-in that needed credits, undone elsewhere, then recorded again here with another ID that spent one.
    await chooseWalkIn(user);
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    expect(banner('Sam Ng is checked in.')).toContain('This member needs more credits.');
    rows = rows.filter(entry => entry.memberId !== walkInId);
    await reread();
    await waitFor(() => expect(screen.queryByText('Sam Ng is checked in.')).toBeNull());
    needingCredits(['visit-again']);
    await chooseWalkIn(user);
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    expect(banner('Sam Ng is checked in.')).not.toContain('needs more credits');
    expect(screen.queryByText(/needs more credits/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo check-in for Sam Ng' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    await waitFor(() => expect(client.undo).toHaveBeenLastCalledWith('visit-again'));
  });
  it.each([false, true])('clears the saved picker draft and respects another draft (%s)', async otherDraft => {
    const close = vi.fn(), user = userEvent.setup();
    render(<Dialog title="Session" closeLabel="Close session" onClose={close}>
      <input aria-label="Session notes"/><AttendanceRosterPanel sessionId={sessionId}/>
    </Dialog>);
    await screen.findByText('River Lee');
    if (otherDraft) await user.type(screen.getByLabelText('Session notes'), 'Keep this edit');
    await user.type(screen.getByRole('combobox', { name: 'Check in someone else' }), 'Sam');
    await user.click(await screen.findByRole('option', { name: 'Sam Ng' }));
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    await user.click(screen.getByRole('button', { name: 'Close session' }));
    if (otherDraft) {
      expect(await screen.findByRole('alert')).toBeDefined();
      expect(close).not.toHaveBeenCalled();
    } else expect(close).toHaveBeenCalledOnce();
  });
  it('shows a safe error when the walk-in lookup fails', async () => {
    client.members.mockRejectedValue(new Error('private lookup detail'));
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    await user.type(screen.getByRole('combobox', { name: 'Check in someone else' }), 'Sam');
    expect((await screen.findByRole('alert')).textContent).toContain('Members could not be searched');
    expect(document.body.textContent).not.toContain('private lookup detail');
    expect(client.record).not.toHaveBeenCalled();
  });
  it('explains an empty roster', async () => {
    rows = [];
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    expect(await screen.findByText('No one is booked yet')).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Check in someone else' })).toBeDefined();
  });
  it('confirms an undo, removes the checked state, and refreshes session counts', async () => {
    rows[0]!.attendance = { id: 'visit', source: 'kiosk' };
    const notify = vi.fn(), user = userEvent.setup();
    render(<SessionCountsProvider publish={vi.fn()} notify={notify}><AttendanceRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await user.click(await screen.findByRole('button', { name: 'Undo check-in for River Lee' }));
    expect(client.undo).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep check-in' }));
    expect(client.undo).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Undo check-in for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    await screen.findByRole('button', { name: 'Check in River Lee' });
    expect(client.undo).toHaveBeenCalledWith('visit'); expect(notify).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps a failed undo retryable and never offers undo for imported visits', async () => {
    rows[0]!.attendance = { id: 'visit', source: 'coach' };
    const undo = client.undo.getMockImplementation()!;
    client.undo.mockRejectedValueOnce(new Error('private database detail'));
    const user = userEvent.setup(), view = render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Undo check-in for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'River Lee is checked in' })).toBeDefined();
    expect(document.body.textContent).not.toContain('private database detail');
    await user.click(screen.getByRole('button', { name: 'Keep check-in' }));
    expect(screen.queryByRole('alert')).toBeNull();
    client.undo.mockImplementation(undo);
    await user.click(screen.getByRole('button', { name: 'Undo check-in for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    await screen.findByRole('button', { name: 'Check in River Lee' });
    view.unmount(); rows[0]!.attendance = { id: 'import', source: 'import' };
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    expect(screen.queryByRole('button', { name: 'Undo check-in for River Lee' })).toBeNull();
  });
  it('enables the staff member tab and session panel, and safely ignores missing extension IDs', () => {
    expect(registration.memberTabs?.[0]).toMatchObject({ enabled: true, component: MemberAttendancePanel,
      permission: { kind: 'staff', capability: 'attendance.manage' } });
    expect(registration.sessionPanels?.[0]).toMatchObject({ enabled: true, component: AttendanceRosterPanel });
    const view = render(<><MemberAttendancePanel/><AttendanceRosterPanel/></>);
    expect(view.container.textContent).toBe(''); expect(client.roster).not.toHaveBeenCalled(); expect(client.members).not.toHaveBeenCalled();
  });
  it('checks in a member once and displays previously checked-in members without another submission', async () => {
    const user = userEvent.setup(), view = render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Check in River Lee' }));
    const checked = await screen.findByRole('button', { name: 'River Lee is checked in' });
    expect((checked as HTMLButtonElement).disabled).toBe(true);
    // Disabled, but legible: a done check-in keeps full opacity in the success colors.
    expect(checked.className).toContain('text-success'); expect(checked.className).not.toContain('disabled:opacity-50');
    await user.click(checked);
    expect(client.record).toHaveBeenCalledTimes(1);
    expect(client.record).toHaveBeenCalledWith({ memberId, sessionId, programId: null });
    view.unmount();
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    expect((await screen.findByRole('button', { name: 'River Lee is checked in' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('tells the session dialog after a check-in so booking counts reload', async () => {
    const notify = vi.fn(), user = userEvent.setup();
    render(<SessionCountsProvider publish={vi.fn()} notify={notify}><AttendanceRosterPanel sessionId={sessionId}/></SessionCountsProvider>);
    await user.click(await screen.findByRole('button', { name: 'Check in River Lee' }));
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    expect(notify).toHaveBeenCalledTimes(1);
    client.record.mockRejectedValue(new Error('no')); rows.push(booked('other', 'Sam Ng'));
    await user.click(screen.getByRole('button', { name: 'Refresh attendance' })); await user.click(await screen.findByRole('button', { name: 'Check in Sam Ng' }));
    await waitFor(() => expect(client.record).toHaveBeenCalledTimes(2)); expect(notify).toHaveBeenCalledTimes(1);
  });
  it('pages the eligible roster without dropping the session scope', async () => {
    total = 51;
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(client.roster).toHaveBeenLastCalledWith(sessionId, 50));
  });
  it('shows no rows when the read of another page fails, instead of the previous page under the new pager', async () => {
    total = 51;
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    client.roster.mockRejectedValueOnce(new Error('Roster unavailable'));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The roster could not be loaded. Refresh attendance to try again.');
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('River Lee')).toBeNull();
  });
  it('keeps rows with a quiet stale note when a follow-up read fails, and clears it on the next success or Refresh', async () => {
    rows = [booked(memberId, 'River Lee')];
    const { dialog, Session } = bookingsDialog();
    const user = userEvent.setup(); render(<Session/>);
    await screen.findByText('River Lee');
    let reads = await settledReads(2);
    client.roster.mockRejectedValueOnce(new Error('offline'));
    act(() => dialog.change(() => rows.push(booked('b2', 'Cy Three'))));
    const staleNote = await screen.findByText('This roster may be out of date. Refresh attendance to try again.');
    expect(staleNote.getAttribute('role')).toBe('status');
    expect(listed()).toEqual([expect.stringContaining('River Lee')]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('The roster could not be loaded. Refresh attendance to try again.')).toBeNull();
    expect(document.activeElement?.getAttribute('role')).not.toBe('alert');
    reads = await settledReads(reads + 1);
    act(() => dialog.change(() => undefined));
    await screen.findByText('Cy Three');
    expect(screen.queryByText('This roster may be out of date. Refresh attendance to try again.')).toBeNull();
    reads = await settledReads(reads + 1);
    // Refresh attendance also clears the stale note.
    client.roster.mockRejectedValueOnce(new Error('offline'));
    act(() => dialog.change(() => undefined));
    await screen.findByText('This roster may be out of date. Refresh attendance to try again.');
    await user.click(screen.getByRole('button', { name: 'Refresh attendance' }));
    await waitFor(() => expect(screen.queryByText('This roster may be out of date. Refresh attendance to try again.')).toBeNull());
    await settledReads(reads + 2);
  });
  it('reads once per check-in and undo, and does not let a failed bookings read swallow the next follow-up', async () => {
    rows = [booked(memberId, 'River Lee')];
    const { dialog, Session } = bookingsDialog();
    const user = userEvent.setup(); render(<Session/>);
    await screen.findByText('River Lee');
    let reads = await settledReads(2);
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    reads = await settledReads(reads + 1);
    await user.click(screen.getByRole('button', { name: 'Undo check-in for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    await screen.findByRole('button', { name: 'Check in River Lee' });
    reads = await settledReads(reads + 1);
    // When the bookings read triggered by the check-in fails, the roster still reads once and follows the next real bookings read.
    dialog.failNextChange();
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    reads = await settledReads(reads + 1);
    act(() => dialog.change(() => rows.push(booked('b2', 'Cy Three'))));
    await screen.findByText('Cy Three');
    await settledReads(reads + 1);
  });
  it('hides the previous page rows while a page change loads, keeping the pager and count', async () => {
    rows = Array.from({ length: 51 }, (_, index) => booked('booked-' + index, 'Booked ' + index));
    let resolvePageTwo: (() => void) | null = null;
    client.roster.mockImplementation((_sessionId: string, offset: number) => {
      const result = { ...page(), data: page().data.slice(offset, offset + 50) };
      if (offset === 50) return new Promise<ReturnType<typeof page>>(resolve => { resolvePageTwo = () => resolve(result); });
      return Promise.resolve(result);
    });
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Booked 0');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(resolvePageTwo).not.toBeNull());
    expect(screen.queryByText('Booked 0')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('0 checked in')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDefined();
    act(() => { resolvePageTwo!(); });
    await screen.findByText('Booked 50');
    expect(listed()).toEqual([expect.stringContaining('Booked 50')]);
  });
  it('keeps credit-needing row check-in feedback when a concurrent booking pushes the member to another page', async () => {
    rows = Array.from({ length: 50 }, (_, index) => booked('booked-' + index, 'Booked ' + index));
    client.roster.mockImplementation(async (_sessionId: string, offset: number) => {
      const result = page();
      return { ...result, data: result.data.slice(offset, offset + 50) };
    });
    needingCredits();
    const user = userEvent.setup(), { reread } = countsDialog();
    await screen.findByText('Booked 49');
    await user.click(screen.getByRole('button', { name: 'Check in Booked 49' }));
    await screen.findByRole('button', { name: 'Booked 49 is checked in' });
    // A concurrent booking pushes Booked 49 onto page two; checkedIn stays 1.
    rows.unshift(booked('concurrent', 'New Booking'));
    await reread();
    const acknowledged = /^Checked in Booked 49 at 6:05\sPM\.$/;
    await screen.findByText(acknowledged);
    expect(banner(acknowledged)).toContain('This member needs more credits.');
    // If Booked 49 is later undone elsewhere (checkedIn drops to 0), the feedback clears.
    rows.find(entry => entry.memberId === 'booked-49')!.attendance = null;
    await reread();
    await waitFor(() => expect(screen.queryByText(acknowledged)).toBeNull());
    expect(screen.queryByText(/needs more credits/)).toBeNull();
  });
  it('keeps a listed walk-in feedback when pushed off page, and clears it when the checked-in count falls', async () => {
    needingCredits();
    const user = userEvent.setup(), { reread } = countsDialog();
    await screen.findByText('River Lee');
    await chooseWalkIn(user);
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    expect(banner('Sam Ng is checked in.')).toContain('This member needs more credits.');
    // On a single-page roster (total <= 50), a read lacking the walk-in clears the feedback even if the count stays 1.
    const singlePageTotal = page();
    client.roster.mockResolvedValueOnce({
      data: singlePageTotal.data.filter(entry => (entry.booking?.memberId ?? entry.attendance?.memberId) !== walkInId),
      pagination: { total: 2 },
      counts: { booked: 1, waitlisted: 0, checkedIn: 1 },
    });
    await reread();
    await waitFor(() => expect(screen.queryByText(/Sam Ng/)).toBeNull());
    expect(screen.queryByText(/needs more credits/)).toBeNull();
    // Re-record Sam Ng to test the multi-page steps: pushed off-page keeps neutral wording, and clears when undone.
    rows = rows.filter(entry => entry.memberId !== walkInId);
    await reread();
    await chooseWalkIn(user);
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    const withSam = page();
    client.roster.mockResolvedValueOnce({
      data: withSam.data.filter(entry => (entry.booking?.memberId ?? entry.attendance?.memberId) !== walkInId),
      pagination: { total: 51 },
      counts: { booked: 50, waitlisted: 0, checkedIn: 1 },
    });
    await reread();
    const multiPageLine = /^Checked in Sam Ng at 6:05\sPM\.$/;
    await screen.findByText(multiPageLine);
    expect(banner(multiPageLine)).toContain('This member needs more credits.');
    // With checkedIn one lower, the walk-in was undone elsewhere and the feedback clears.
    rows = rows.filter(entry => entry.memberId !== walkInId);
    await reread();
    await waitFor(() => expect(screen.queryByText(multiPageLine)).toBeNull());
    expect(screen.queryByText(/needs more credits/)).toBeNull();
  });
  it('keeps an undone booked row disabled until a reload succeeds, and drops a walk-in count and total when reload fails', async () => {
    rows[0]!.attendance = { id: 'visit', source: 'coach' };
    const user = userEvent.setup(), view = render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Undo check-in for River Lee' }));
    client.roster.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Refresh attendance to try again.');
    expect(screen.getByText('River Lee')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Check in River Lee' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('0 checked in')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Refresh attendance' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Check in River Lee' }) as HTMLButtonElement).disabled).toBe(false));
    view.unmount();

    rows = [
      { memberId: walkInId, displayName: 'Sam Ng', booking: null, attendance: { id: 'visit-sam', source: 'coach' } },
      ...Array.from({ length: 50 }, (_, index) => booked('booked-' + index, 'Booked ' + index)),
    ];
    client.roster.mockImplementation(async (_sessionId: string, offset: number) => ({ ...page(), data: page().data.slice(offset, offset + 50) }));
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByRole('button', { name: 'Undo check-in for Sam Ng' });
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Undo check-in for Sam Ng' }));
    client.roster.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Refresh attendance to try again.');
    expect(screen.queryByText('Sam Ng')).toBeNull();
    expect(screen.getByText('0 checked in')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });
  it('ignores a walk-in choice while another save is running without re-searching', async () => {
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const picker = screen.getByRole<HTMLInputElement>('combobox', { name: 'Check in someone else' });
    await user.type(picker, 'Sam Ng');
    const option = await screen.findByRole('option', { name: 'Sam Ng' });
    let resolveRecord!: (value: Awaited<ReturnType<typeof recordVisit>>) => void;
    client.record.mockImplementationOnce(() => new Promise(resolve => { resolveRecord = resolve; }));
    act(() => {
      screen.getByRole('button', { name: 'Check in River Lee' }).click();
      option.click();
    });
    await act(() => new Promise(resolve => setTimeout(resolve, 300)));
    expect(client.members).toHaveBeenCalledTimes(1);
    expect(client.record).toHaveBeenCalledTimes(1);
    expect(client.record).toHaveBeenCalledWith({ memberId, sessionId, programId: null });
    rows[0]!.attendance = { id: 'visit-' + memberId, source: 'coach' };
    await act(async () => { resolveRecord({ id: 'visit-' + memberId, source: 'coach', occurredAt: '2026-11-20T23:05:00.000Z', memberId }); });
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    await user.click(picker);
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'Sam Ng' })).toBeDefined();
    expect(client.members).toHaveBeenCalledTimes(1);
  });
  it('keeps off-page feedback on a replayed check-in and verifies before clearing on a lower count', async () => {
    rows = [
      ...Array.from({ length: 50 }, (_, index) => booked('booked-' + index, 'Booked ' + index)),
      { ...booked('other-1', 'Ada One'), attendance: { id: 'visit-other-1', source: 'kiosk' } },
      { ...booked('other-2', 'Bo Two'), attendance: { id: 'visit-other-2', source: 'kiosk' } },
      { ...booked(walkInId, 'Sam Ng'), attendance: { id: 'visit-sam', source: 'kiosk' } },
    ];
    client.roster.mockImplementation(async (_sessionId: string, offset: number) => ({ ...page(), data: page().data.slice(offset, offset + 50) }));
    client.record.mockResolvedValueOnce({ id: 'visit-sam', memberId: walkInId, source: 'kiosk', occurredAt: '2026-11-20T23:05:00.000Z', needsCredits: true });
    rows[50]!.attendance = null;
    rows[51]!.attendance = null;
    const user = userEvent.setup(), { reread } = countsDialog();
    await screen.findByText('Booked 0');
    await chooseWalkIn(user);
    const acknowledged = /^Checked in Sam Ng at 6:05\sPM\.$/;
    await screen.findByText(acknowledged);
    expect(banner(acknowledged)).toContain('This member needs more credits.');
    await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(1));

    // Another member checks in on page two (count 2), then is undone elsewhere (count 1) while Sam Ng still exists.
    rows[50]!.attendance = { id: 'visit-other-1', source: 'kiosk' };
    await reread();
    rows[50]!.attendance = null;
    client.visitExists.mockResolvedValueOnce(true);
    await reread();
    await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(2));
    expect(client.visitExists).toHaveBeenCalledWith('visit-sam', walkInId, sessionId);
    expect(banner(acknowledged)).toContain('This member needs more credits.');

    // A rejected verification check keeps the feedback.
    rows[50]!.attendance = { id: 'visit-other-1', source: 'kiosk' };
    await reread();
    rows[50]!.attendance = null;
    client.visitExists.mockRejectedValueOnce(new Error('offline'));
    await reread();
    await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(3));
    expect(banner(acknowledged)).toContain('This member needs more credits.');

    // Once Sam Ng is actually undone elsewhere, visitExists returns false and clears the feedback and warning.
    rows[52]!.attendance = null;
    await reread();
    await waitFor(() => expect(screen.queryByText(acknowledged)).toBeNull());
    expect(screen.queryByText(/needs more credits/)).toBeNull();
  });
  it('expires the own-change follow-up skip after 10 seconds when Bookings stays stale', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    rows = [booked(memberId, 'River Lee')];
    const { dialog, Session } = bookingsDialog();
    const user = userEvent.setup(); render(<Session/>);
    await screen.findByText('River Lee');
    let reads = await settledReads(2);
    dialog.failNextChange();
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    reads = await settledReads(reads + 1);
    act(() => dialog.change(() => undefined, 'stale'));
    await settledReads(reads);
    now += 11_000;
    act(() => dialog.change(() => rows.push(booked('b2', 'Cy Three'))));
    await screen.findByText('Cy Three');
    await settledReads(reads + 1);
  });
  it('shows the load-failed alert when a follow-up interrupts a pending Refresh and fails', async () => {
    rows = [booked(memberId, 'River Lee')];
    const { dialog, Session } = bookingsDialog();
    const user = userEvent.setup(); render(<Session/>);
    await screen.findByText('River Lee');
    await settledReads(2);
    client.roster.mockImplementationOnce(() => new Promise(() => undefined));
    await user.click(screen.getByRole('button', { name: 'Refresh attendance' }));
    client.roster.mockRejectedValueOnce(new Error('offline'));
    act(() => dialog.change(() => undefined));
    expect((await screen.findByRole('alert')).textContent).toContain('The roster could not be loaded. Refresh attendance to try again.');
    expect(screen.queryByText('This roster may be out of date. Refresh attendance to try again.')).toBeNull();
  });
  it('reads additional walk-in pages when the first page is full of listed members, and stops at one under 50', async () => {
    rows = Array.from({ length: 50 }, (_, index) => booked('m-' + index, 'Member ' + index));
    client.members.mockImplementation(async (_search: string, offset = 0) => offset === 0
      ? Array.from({ length: 50 }, (_, index) => ({ id: 'm-' + index, firstName: 'Member', lastName: String(index) }))
      : [{ id: walkInId, firstName: 'Sam', lastName: 'Ng' }]);
    const user = userEvent.setup(), view = render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Member 0');
    await user.type(screen.getByRole('combobox', { name: 'Check in someone else' }), 'Sam');
    expect(await screen.findByRole('option', { name: 'Sam Ng' })).toBeDefined();
    expect(client.members.mock.calls.map(([search, offset = 0]) => [search, offset])).toEqual([['Sam', 0], ['Sam', 50]]);
    view.unmount();

    client.members.mockReset();
    client.members.mockResolvedValueOnce([{ id: 'm-0', firstName: 'Member', lastName: '0' }, { id: walkInId, firstName: 'Sam', lastName: 'Ng' }]);
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Member 0');
    await user.type(screen.getByRole('combobox', { name: 'Check in someone else' }), 'Sam');
    expect(await screen.findByRole('option', { name: 'Sam Ng' })).toBeDefined();
    expect(client.members).toHaveBeenCalledTimes(1);
  });
  it('keeps the pager and checked-in count after a failed Next page and lets Previous page load page one', async () => {
    rows = Array.from({ length: 51 }, (_, index) => booked('booked-' + index, 'Booked ' + index));
    client.roster.mockImplementation(async (_sessionId: string, offset: number) => ({ ...page(), data: page().data.slice(offset, offset + 50) }));
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Booked 0');
    client.roster.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The roster could not be loaded. Refresh attendance to try again.');
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('Booked 0')).toBeNull();
    expect(screen.getByText('0 checked in')).toBeDefined();
    const prev = screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
    expect(prev.disabled).toBe(false);
    await user.click(prev);
    await screen.findByText('Booked 0');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('does not show the old page again when stepping back after a failed Next page and that read fails too', async () => {
    rows = Array.from({ length: 51 }, (_, index) => booked('booked-' + index, 'Booked ' + index));
    client.roster.mockImplementation(async (_sessionId: string, offset: number) => ({ ...page(), data: page().data.slice(offset, offset + 50) }));
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Booked 0');
    client.roster.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(client.roster).toHaveBeenLastCalledWith(sessionId, 0));
    await screen.findByRole('alert');
    expect(screen.queryByText('Booked 0')).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDefined();
  });
  it('leaves members already listed on the roster page out of walk-in suggestions', async () => {
    rows = [booked(memberId, 'River Lee'), { memberId: 'k1', displayName: 'Kim Kiosk', booking: null, attendance: { id: 'visit-k1', source: 'kiosk' } }];
    client.members.mockResolvedValue([
      { id: memberId, firstName: 'River', lastName: 'Lee' },
      { id: 'k1', firstName: 'Kim', lastName: 'Kiosk' },
      { id: walkInId, firstName: 'Sam', lastName: 'Ng' },
    ]);
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const picker = screen.getByRole('combobox', { name: 'Check in someone else' });
    await user.type(picker, 'am');
    expect(await screen.findByRole('option', { name: 'Sam Ng' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'River Lee' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Kim Kiosk' })).toBeNull();
  });
  it('removes stale actions when the refresh after undo fails and can reload the roster', async () => {
    rows[0]!.attendance = { id: 'visit', source: 'coach' };
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Undo check-in for River Lee' }));
    client.roster.mockRejectedValueOnce(new Error('Roster unavailable'));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Refresh attendance to try again.');
    expect(screen.queryByRole('button', { name: 'Undo check-in for River Lee' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh attendance' }));
    await screen.findByRole('button', { name: 'Check in River Lee' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows safe failures and allows a failed check-in to be retried', async () => {
    client.record.mockRejectedValueOnce(new Error('private SQL detail'));
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Check in River Lee' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Please try again');
    expect(document.body.textContent).not.toContain('private SQL detail');
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    expect(client.record).toHaveBeenCalledTimes(2);
  });
  it('reloads the roster after a refused check-in, so a member who left the eligible list drops off', async () => {
    // A member checked in before staff Cancelled them stays listed with their visit; one not yet checked in is refused.
    rows = [booked(memberId, 'River Lee'), booked('gone', 'Ada One'), { ...booked('kept', 'Bo Two'), attendance: { id: 'kept-visit', source: 'coach' } }];
    client.record.mockImplementationOnce(async () => {
      rows = rows.filter(row => row.memberId !== 'gone');
      throw new Error('Member is cancelled');
    });
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    expect(await screen.findByRole('button', { name: 'Undo check-in for Bo Two' })).toBeDefined();
    expect(client.roster).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Check in Ada One' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Please try again');
    await waitFor(() => expect(screen.queryByText('Ada One')).toBeNull());
    expect(client.roster).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toBeDefined();
    expect(listed()).toEqual([expect.stringContaining('River Lee'), expect.stringContaining('Bo Two')]);
    expect(screen.getByRole('button', { name: 'Undo check-in for Bo Two' })).toBeDefined();
  });
  it('keeps a failed undo visible when a booking change reloads the roster', async () => {
    rows[0]!.attendance = { id: 'visit', source: 'coach' };
    client.undo.mockRejectedValueOnce(new Error('Undo failed'));
    const publish = vi.fn(), user = userEvent.setup();
    const dialog = (booked: number) => <SessionCountsProvider publish={publish} counts={{ booked, waitlisted: 0, checkedIn: 1 }}>
      <AttendanceRosterPanel sessionId={sessionId}/>
    </SessionCountsProvider>;
    const view = render(dialog(1));
    await user.click(await screen.findByRole('button', { name: 'Undo check-in for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    const confirmation = within(screen.getByRole('dialog'));
    await confirmation.findByRole('alert');
    rows.push(booked('other', 'Sam Ng'));
    view.rerender(dialog(2));
    await screen.findByText('Sam Ng');
    expect(confirmation.getByRole('alert').textContent).toContain('Please try again');
  });
  it('renders program/tag totals and records an open-mat visit without a session', async () => {
    const user = userEvent.setup(); render(<MemberAttendancePanel memberId={memberId}/>);
    await screen.findByText('Total visits: 1,200');
    expect(screen.getByRole('rowheader', { name: 'Fundamentals' })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: 'Practice' })).toBeDefined();
    expect(screen.getAllByText('1,200')).toHaveLength(5);
    expect(screen.getByText('Classes attended: 1,200')).toBeDefined();
    await user.selectOptions(screen.getByLabelText('Program'), programId);
    await user.click(screen.getByRole('button', { name: 'Record open-mat visit' }));
    await screen.findByText('Open-mat visit recorded.');
    expect(client.record).toHaveBeenCalledWith({ memberId, sessionId: null, programId });
    await waitFor(() => expect(client.totals).toHaveBeenCalledTimes(2));
  });
  it('can record unclassified open mat, and clears prior member/session state when extension IDs change', async () => {
    const user = userEvent.setup(), view = render(<MemberAttendancePanel memberId={memberId}/>);
    await screen.findByText('Total visits: 1,200');
    await user.click(screen.getByRole('button', { name: 'Record open-mat visit' }));
    await screen.findByText('Open-mat visit recorded.');
    expect(client.record).toHaveBeenCalledWith({ memberId, sessionId: null, programId: null });
    client.totals.mockReturnValue(new Promise(() => undefined));
    view.rerender(<MemberAttendancePanel memberId="another-member"/>);
    expect(screen.queryByText('Total visits: 1,200')).toBeNull();
    expect(screen.queryByText('Open-mat visit recorded.')).toBeNull();
  });
});

it('warns the roster when staff checked in a pack holder without spending a credit', async () => {
  const record = client.record.getMockImplementation()!;
  client.record.mockImplementation(async (input: { memberId: string }) => ({ ...await record(input), needsCredits: true }));
  const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
  await user.click(await screen.findByRole('button', { name: 'Check in River Lee' }));
  const row = screen.getByRole('listitem');
  await within(row).findByRole('button', { name: 'River Lee is checked in' });
  expect(within(row).getByRole('status').textContent).toContain('This member needs more credits.');
  await user.click(screen.getByRole('button', { name: 'Undo check-in for River Lee' }));
  await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
  await screen.findByRole('button', { name: 'Check in River Lee' });
  expect(screen.queryByText(/needs more credits/)).toBeNull();
});

it('also warns for an open-mat credit override in the member tab', async () => {
  client.record.mockResolvedValue({ id: 'visit', memberId, source: 'coach', needsCredits: true });
  const user = userEvent.setup(); render(<MemberAttendancePanel memberId={memberId}/>);
  await screen.findByRole('option', { name: 'Fundamentals' });
  await user.click(screen.getByRole('button', { name: 'Record open-mat visit' }));
  expect(await screen.findByText('Checked in without spending a credit. This member needs more credits.')).toBeDefined();
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('coach roster recheck, undo read ordering, and busy walk-in notice', () => {
  it('rechecks off-page feedback on each count drop and ignores answers to older checks', async () => {
    const setupRoster = async () => {
      rows = [
        { ...booked('booked-0', 'Booked 0'), attendance: { id: 'visit-0', source: 'kiosk' } },
        { ...booked('booked-1', 'Booked 1'), attendance: { id: 'visit-1', source: 'kiosk' } },
        ...Array.from({ length: 48 }, (_, index) => booked('booked-' + (index + 2), 'Booked ' + (index + 2))),
      ];
      client.roster.mockImplementation(async (_sessionId: string, offset: number) => ({ ...page(), data: page().data.slice(offset, offset + 50) }));
      client.record.mockImplementation(async (input: { memberId: string }) => ({ ...await recordVisit(input), needsCredits: true }));
      client.visitExists.mockResolvedValueOnce(true);
      let reads = 0;
      const dialog = () => <SessionCountsProvider publish={vi.fn()} counts={{ booked: ++reads, waitlisted: 0, checkedIn: 0 }}>
        <AttendanceRosterPanel sessionId={sessionId}/>
      </SessionCountsProvider>;
      const view = render(dialog());
      const reread = async () => {
        const before = client.roster.mock.calls.length;
        view.rerender(dialog());
        await waitFor(() => expect(client.roster.mock.calls.length).toBe(before + 1));
        await act(() => new Promise(resolve => setTimeout(resolve, 50)));
      };
      const user = userEvent.setup();
      await screen.findByText('Booked 0');
      await user.type(screen.getByRole('combobox', { name: 'Check in someone else' }), 'Sam');
      await user.click(await screen.findByRole('option', { name: 'Sam Ng' }));
      const acknowledged = /^Checked in Sam Ng at 6:05\sPM\.$/;
      await screen.findByText(acknowledged);
      await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(1));
      await act(() => new Promise(resolve => setTimeout(resolve, 20)));
      expect(screen.getByText('3 checked in')).toBeDefined();
      return { view, reread, acknowledged };
    };

    // Run 1: count 2 starts call 1, count 1 starts call 2; call 1 true keeps it, call 2 false clears it.
    {
      const { view, reread, acknowledged } = await setupRoster();
      const call1 = deferred<boolean>(), call2 = deferred<boolean>();
      client.visitExists.mockReturnValueOnce(call1.promise).mockReturnValueOnce(call2.promise);
      rows[0]!.attendance = null;
      await reread();
      await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(2));
      rows[1]!.attendance = null;
      await reread();
      await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(3));
      await act(async () => { call1.resolve(true); });
      expect(screen.getByText(acknowledged)).toBeDefined();
      expect(screen.getByText(/needs more credits/)).toBeDefined();
      await act(async () => { call2.resolve(false); });
      await waitFor(() => expect(screen.queryByText(acknowledged)).toBeNull());
      expect(screen.queryByText(/needs more credits/)).toBeNull();
      view.unmount();
    }

    // Run 2: call 2 resolves true, then older call 1 resolves false: the feedback stays.
    {
      client.visitExists.mockReset();
      const { reread, acknowledged } = await setupRoster();
      const call1 = deferred<boolean>(), call2 = deferred<boolean>();
      client.visitExists.mockReturnValueOnce(call1.promise).mockReturnValueOnce(call2.promise);
      rows[0]!.attendance = null;
      await reread();
      await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(2));
      rows[1]!.attendance = null;
      await reread();
      await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(3));
      await act(async () => { call2.resolve(true); });
      expect(screen.getByText(acknowledged)).toBeDefined();
      await act(async () => { call1.resolve(false); });
      await act(() => new Promise(resolve => setTimeout(resolve, 20)));
      expect(screen.getByText(acknowledged)).toBeDefined();
      expect(screen.getByText(/needs more credits/)).toBeDefined();
    }
  });

  it('checks an off-page visit once on the first read when it lacks the visit even if the count did not drop', async () => {
    // Part A: 51-row roster, walk-in recorded and undone elsewhere before the first read, count unchanged.
    rows = Array.from({ length: 51 }, (_, index) => booked('booked-' + index, 'Booked ' + index));
    client.roster.mockImplementation(async (_sessionId: string, offset: number) => ({ ...page(), data: page().data.slice(offset, offset + 50) }));
    client.record.mockResolvedValueOnce({ id: 'visit-sam', memberId: walkInId, source: 'coach', occurredAt: '2026-11-20T23:05:00.000Z', needsCredits: true });
    client.visitExists.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    const view = render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('Booked 0');
    await user.type(screen.getByRole('combobox', { name: 'Check in someone else' }), 'Sam');
    await user.click(await screen.findByRole('option', { name: 'Sam Ng' }));
    const acknowledged = /^Checked in Sam Ng at 6:05\sPM\.$/;
    await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(acknowledged)).toBeNull());
    expect(screen.queryByText(/needs more credits/)).toBeNull();
    view.unmount();

    // Part B: replayed check-in already on page two; visitExists returns true, feedback stays, same-count reads make no further call.
    client.visitExists.mockReset();
    rows = [
      ...Array.from({ length: 50 }, (_, index) => booked('booked-' + index, 'Booked ' + index)),
      { ...booked(walkInId, 'Sam Ng'), attendance: { id: 'visit-sam', source: 'kiosk' } },
    ];
    client.record.mockResolvedValueOnce({ id: 'visit-sam', memberId: walkInId, source: 'kiosk', occurredAt: '2026-11-20T23:05:00.000Z', needsCredits: true });
    client.visitExists.mockResolvedValueOnce(true);
    let reads = 0;
    const dialog = () => <SessionCountsProvider publish={vi.fn()} counts={{ booked: ++reads, waitlisted: 0, checkedIn: 1 }}>
      <AttendanceRosterPanel sessionId={sessionId}/>
    </SessionCountsProvider>;
    const secondView = render(dialog());
    const reread = async () => {
      const before = client.roster.mock.calls.length;
      secondView.rerender(dialog());
      await waitFor(() => expect(client.roster.mock.calls.length).toBe(before + 1));
      await act(() => new Promise(resolve => setTimeout(resolve, 50)));
    };
    await screen.findByText('Booked 0');
    await user.type(screen.getByRole('combobox', { name: 'Check in someone else' }), 'Sam');
    await user.click(await screen.findByRole('option', { name: 'Sam Ng' }));
    await screen.findByText(acknowledged);
    await waitFor(() => expect(client.visitExists).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/needs more credits/)).toBeDefined();
    await reread();
    await reread();
    expect(client.visitExists).toHaveBeenCalledTimes(1);
    expect(screen.getByText(acknowledged)).toBeDefined();
    expect(screen.getByText(/needs more credits/)).toBeDefined();
  });

  it('ignores a quiet follow-up read started before an undo resolved when the undo refresh fails', async () => {
    rows = [{ ...booked(memberId, 'River Lee'), attendance: { id: 'visit', source: 'coach' } }];
    const staleRoster = page();
    const pendingFollowUp = deferred<ReturnType<typeof page>>();
    const pendingUndo = deferred<{ id: string; memberId: string; source: string }>();
    const Session = ({ counts }: { counts: SessionCounts | null }) => (
      <SessionCountsProvider publish={vi.fn()} counts={counts} changed={0} notify={vi.fn()}>
        <AttendanceRosterPanel sessionId={sessionId}/>
      </SessionCountsProvider>
    );
    const view = render(<Session counts={{ booked: 1, waitlisted: 0, checkedIn: 1 }}/>);
    await screen.findByRole('button', { name: 'Undo check-in for River Lee' });
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(1));

    // Trigger a quiet Bookings follow-up read that stays in flight while the coach confirms undo.
    client.roster.mockReturnValueOnce(pendingFollowUp.promise);
    view.rerender(<Session counts={{ booked: 1, waitlisted: 0, checkedIn: 1 }}/>);
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));

    client.undo.mockReturnValueOnce(pendingUndo.promise);
    client.roster.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Undo check-in for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));

    await act(async () => {
      pendingUndo.resolve({ id: 'visit', memberId, source: 'coach' });
      await Promise.resolve();
      pendingFollowUp.resolve(staleRoster);
    });

    expect((await screen.findByRole('alert')).textContent).toContain('Refresh attendance to try again.');
    expect(screen.getByText('River Lee')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Undo check-in for River Lee' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Check in River Lee' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('0 checked in')).toBeDefined();
  });

  it('shows a busy notice when a walk-in is chosen during another save, keeps the query, and clears when the save ends', async () => {
    rows = [booked(memberId, 'River Lee'), booked('b2', 'Bo Two')];
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    const picker = screen.getByRole<HTMLInputElement>('combobox', { name: 'Check in someone else' });
    await user.type(picker, 'Sam Ng');
    const option = await screen.findByRole('option', { name: 'Sam Ng' });

    const firstSave = deferred<Awaited<ReturnType<typeof recordVisit>>>();
    client.record.mockReturnValueOnce(firstSave.promise);
    act(() => {
      screen.getByRole('button', { name: 'Check in River Lee' }).click();
      option.click();
    });
    const busyNotice = 'Another change is still saving. Choose the member again once it finishes.';
    expect((await screen.findByText(busyNotice)).getAttribute('role')).toBe('status');
    expect(picker.value).toBe('Sam Ng');
    expect(client.members).toHaveBeenCalledTimes(1);

    rows[0]!.attendance = { id: 'visit-' + memberId, source: 'coach' };
    await act(async () => {
      firstSave.resolve({ id: 'visit-' + memberId, source: 'coach', occurredAt: '2026-11-20T23:05:00.000Z', memberId });
    });
    await screen.findByRole('button', { name: 'River Lee is checked in' });
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(screen.queryByText(busyNotice)).toBeNull();

    // Choosing while another save runs shows it again; a later successful choice clears the query and shows no notice.
    await user.click(picker);
    await user.keyboard('{ArrowDown}');
    const optionAgain = await screen.findByRole('option', { name: 'Sam Ng' });
    const secondSave = deferred<Awaited<ReturnType<typeof recordVisit>>>();
    client.record.mockReturnValueOnce(secondSave.promise);
    act(() => {
      screen.getByRole('button', { name: 'Check in Bo Two' }).click();
      optionAgain.click();
    });
    expect(await screen.findByText(busyNotice)).toBeDefined();
    rows[1]!.attendance = { id: 'visit-b2', source: 'coach' };
    await act(async () => {
      secondSave.resolve({ id: 'visit-b2', source: 'coach', occurredAt: '2026-11-20T23:05:00.000Z', memberId: 'b2' });
    });
    await screen.findByRole('button', { name: 'Bo Two is checked in' });
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(screen.queryByText(busyNotice)).toBeNull();
    await user.click(picker);
    await user.keyboard('{ArrowDown}');
    await user.click(screen.getByRole('option', { name: 'Sam Ng' }));
    await screen.findByRole('button', { name: 'Sam Ng is checked in' });
    expect(picker.value).toBe('');
    expect(screen.queryByText(busyNotice)).toBeNull();
  });

  it('shows the busy notice when a walk-in is chosen during an undo and clears when the undo ends', async () => {
    rows = [{ ...booked(memberId, 'River Lee'), attendance: { id: 'visit', source: 'coach' } }];
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByRole('button', { name: 'Undo check-in for River Lee' });
    const picker = screen.getByRole<HTMLInputElement>('combobox', { name: 'Check in someone else' });
    await user.type(picker, 'Sam Ng');
    const option = await screen.findByRole('option', { name: 'Sam Ng' });

    const pendingUndo = deferred<{ id: string; memberId: string; source: string }>();
    client.undo.mockReturnValueOnce(pendingUndo.promise);
    act(() => { screen.getByRole('button', { name: 'Undo check-in for River Lee' }).click(); });
    const confirmUndo = await screen.findByRole('button', { name: 'Undo check-in' });
    act(() => {
      confirmUndo.click();
      option.click();
    });

    const busyNotice = 'Another change is still saving. Choose the member again once it finishes.';
    expect((await screen.findByText(busyNotice)).getAttribute('role')).toBe('status');
    expect(picker.value).toBe('Sam Ng');

    rows[0]!.attendance = null;
    await act(async () => {
      pendingUndo.resolve({ id: 'visit', memberId, source: 'coach' });
    });
    await screen.findByRole('button', { name: 'Check in River Lee' });
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(screen.queryByText(busyNotice)).toBeNull();
  });

  it('ignores a failed quiet follow-up read started before an undo resolved', async () => {
    rows = [{ ...booked(memberId, 'River Lee'), attendance: { id: 'visit', source: 'coach' } }];
    const pendingFollowUp = deferred<ReturnType<typeof page>>();
    const pendingRefresh = deferred<ReturnType<typeof page>>();
    const pendingUndo = deferred<{ id: string; memberId: string; source: string }>();
    const Session = ({ counts }: { counts: SessionCounts | null }) => (
      <SessionCountsProvider publish={vi.fn()} counts={counts} changed={0} notify={vi.fn()}>
        <AttendanceRosterPanel sessionId={sessionId}/>
      </SessionCountsProvider>
    );
    const view = render(<Session counts={{ booked: 1, waitlisted: 0, checkedIn: 1 }}/>);
    await screen.findByRole('button', { name: 'Undo check-in for River Lee' });
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(1));

    client.roster.mockReturnValueOnce(pendingFollowUp.promise);
    view.rerender(<Session counts={{ booked: 1, waitlisted: 0, checkedIn: 1 }}/>);
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));

    client.undo.mockReturnValueOnce(pendingUndo.promise);
    client.roster.mockReturnValueOnce(pendingRefresh.promise);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Undo check-in for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));

    rows[0]!.attendance = null;
    await act(async () => {
      pendingUndo.resolve({ id: 'visit', memberId, source: 'coach' });
      await Promise.resolve();
      pendingFollowUp.reject(new Error('offline'));
      // A rejection reaches the old read's handler two ticks later; it must run before React replaces the read effect.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The refresh read is still pending, so nothing has had a chance to clear an error the old read raised.
    expect(client.roster).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/out of date/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      pendingRefresh.resolve(page());
    });
    expect((screen.getByRole('button', { name: 'Check in River Lee' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/out of date/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('0 checked in')).toBeDefined();
  });

  it.each(['succeeds', 'fails'])('ignores a quiet follow-up read that %s after a check-in resolved and applies the refresh read', async outcome => {
    // The old read also lists a member the screen doesn't, so applying it would show.
    rows = [booked(memberId, 'River Lee'), booked('b2', 'Bo Two')];
    const staleRoster = page();
    rows = [booked(memberId, 'River Lee')];
    const pendingFollowUp = deferred<ReturnType<typeof page>>();
    const pendingRecord = deferred<Awaited<ReturnType<typeof recordVisit>>>();
    const pendingRefresh = deferred<ReturnType<typeof page>>();
    const Session = ({ counts }: { counts: SessionCounts | null }) => (
      <SessionCountsProvider publish={vi.fn()} counts={counts} changed={0} notify={vi.fn()}>
        <AttendanceRosterPanel sessionId={sessionId}/>
      </SessionCountsProvider>
    );
    const view = render(<Session counts={{ booked: 1, waitlisted: 0, checkedIn: 0 }}/>);
    await screen.findByRole('button', { name: 'Check in River Lee' });
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(1));

    client.roster.mockReturnValueOnce(pendingFollowUp.promise);
    view.rerender(<Session counts={{ booked: 1, waitlisted: 0, checkedIn: 0 }}/>);
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));

    client.record.mockReturnValueOnce(pendingRecord.promise);
    client.roster.mockReturnValueOnce(pendingRefresh.promise);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));

    rows[0]!.attendance = { id: 'visit-' + memberId, source: 'coach' };
    await act(async () => {
      pendingRecord.resolve({ id: 'visit-' + memberId, source: 'coach', occurredAt: '2026-11-20T23:05:00.000Z', memberId });
      await Promise.resolve();
      if (outcome === 'succeeds') pendingFollowUp.resolve(staleRoster);
      else pendingFollowUp.reject(new Error('offline'));
      // The old read's handler (two ticks later for a rejection) must run before React replaces the read effect.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.roster).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Bo Two')).toBeNull();
    expect(screen.queryByText(/out of date/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'River Lee is checked in' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('1 checked in')).toBeDefined();
    await act(async () => {
      pendingRefresh.resolve(page());
    });
    const checkedBtn = await screen.findByRole('button', { name: 'River Lee is checked in' }) as HTMLButtonElement;
    expect(checkedBtn.disabled).toBe(true);
    expect(screen.getByText('1 checked in')).toBeDefined();
  });

  it('shows a row check-in and updated count at once when the follow-up reload fails, and allows undo', async () => {
    rows = [booked(memberId, 'River Lee')];
    const user = userEvent.setup();
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByRole('button', { name: 'Check in River Lee' });
    expect(screen.getByText('0 checked in')).toBeDefined();

    client.roster.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The roster could not be loaded. Refresh attendance to try again.');
    const checkedBtn = screen.getByRole('button', { name: 'River Lee is checked in' }) as HTMLButtonElement;
    expect(checkedBtn.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Undo check-in for River Lee' })).toBeDefined();
    expect(screen.getByText('1 checked in')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Undo check-in for River Lee' }));
    await user.click(screen.getByRole('button', { name: 'Undo check-in' }));
    expect(client.undo).toHaveBeenCalledWith('visit-' + memberId);
  });

  it('leaves a row and count unchanged when a replayed check-in resolves for a member already shown checked in', async () => {
    rows = [booked(memberId, 'River Lee')];
    const pendingFollowUp = deferred<ReturnType<typeof page>>();
    const pendingRecord = deferred<Awaited<ReturnType<typeof recordVisit>>>();
    const Session = ({ counts }: { counts: SessionCounts | null }) => (
      <SessionCountsProvider publish={vi.fn()} counts={counts} changed={0} notify={vi.fn()}>
        <AttendanceRosterPanel sessionId={sessionId}/>
      </SessionCountsProvider>
    );
    const view = render(<Session counts={{ booked: 1, waitlisted: 0, checkedIn: 0 }}/>);
    await screen.findByRole('button', { name: 'Check in River Lee' });
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(1));

    client.roster.mockReturnValueOnce(pendingFollowUp.promise);
    view.rerender(<Session counts={{ booked: 1, waitlisted: 0, checkedIn: 0 }}/>);
    await waitFor(() => expect(client.roster).toHaveBeenCalledTimes(2));

    client.record.mockReturnValueOnce(pendingRecord.promise);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check in River Lee' }));

    // A concurrent read before record resolves already shows River Lee checked in.
    rows[0]!.attendance = { id: 'visit-kiosk', source: 'kiosk' };
    await act(async () => {
      pendingFollowUp.resolve(page());
      await Promise.resolve();
    });
    expect(screen.getByText('1 checked in')).toBeDefined();

    client.roster.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      pendingRecord.resolve({ id: 'visit-kiosk', source: 'kiosk', occurredAt: '2026-11-20T23:05:00.000Z', memberId });
    });

    expect((await screen.findByRole('alert')).textContent).toContain('The roster could not be loaded. Refresh attendance to try again.');
    expect(screen.getByText('1 checked in')).toBeDefined();
    expect((screen.getByRole('button', { name: 'River Lee is checked in' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves listed rows and count unchanged for a walk-in when the follow-up reload fails, keeping the walk-in banner', async () => {
    rows = [booked(memberId, 'River Lee')];
    const user = userEvent.setup();
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByRole('button', { name: 'Check in River Lee' });
    expect(screen.getByText('0 checked in')).toBeDefined();

    const picker = screen.getByRole('combobox', { name: 'Check in someone else' });
    await user.type(picker, 'Sam');
    await screen.findByRole('option', { name: 'Sam Ng' });
    client.roster.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('option', { name: 'Sam Ng' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The roster could not be loaded. Refresh attendance to try again.');
    expect(screen.getByText('Sam Ng is checked in.')).toBeDefined();
    expect(listed()).toEqual([expect.stringContaining('River Lee')]);
    expect((screen.getByRole('button', { name: 'Check in River Lee' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('0 checked in')).toBeDefined();
  });
});
