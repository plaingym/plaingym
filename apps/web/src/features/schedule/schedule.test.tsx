// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { sessionTimes } from './session.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import type { ClassSession } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { useBootstrap } from '../../app/context.js';
import type { ShellBootstrap } from '../../app/services.js';
import { createRegistries } from '../../lib/registries.js';
import { usePublishSessionCounts, useSessionChanged } from '../../lib/session-summary.js';
import { SchedulePage, SessionDetail, SessionForm, SessionPanels } from './page.js';
import { calendarDate, calendarInstant, localTime, shiftDate, weekStart } from './calendar.js';
vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('../../lib/api.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../../lib/api.js')>(), api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() } }));
const id = '00000000-0000-7000-8000-000000000001', programId = '00000000-0000-7000-8000-000000000002';
const options = { timezone: 'America/New_York', programs: [{ id: programId, name: 'Program A' }], coaches: [] };
const session: ClassSession = { id, name: 'Evening class', startsAt: '2026-03-02T23:00:00Z', endsAt: '2026-03-03T00:00:00Z',
  templateId: null, coachId: null, status: 'scheduled', capacity: null, notes: '<script>Keep plain</script>', kind: 'class', programIds: [programId], tagIds: [], revision: 4, createdAt: '2026-03-01T00:00:00Z' };
function bootstrap(roles: StaffRole[] = ['owner'], gymId = id, staffProfileId: string | null = null) {
  const data: ShellBootstrap = { gym: { id: gymId, name: 'Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: id, staffProfileId, displayName: 'Test User', roles, member: !roles.length }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], queryFn: async () => data, initialData: data }).getCurrentResult());
}
beforeEach(() => {
  bootstrap(); vi.setSystemTime(new Date('2026-03-02T15:00:00Z'));
  vi.mocked(api.GET).mockImplementation((path) => {
    const data = path === '/api/schedule/options' ? { data: options } : { data: path === '/api/schedule/sessions' ? [session] : [], pagination: { offset: 0, limit: 100, total: path === '/api/schedule/sessions' ? 1 : 0 } };
    return Promise.resolve({ data, response: new Response() } as Awaited<ReturnType<typeof api.GET>>);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
describe('schedule calendar and session detail', () => {
  function noticeRegistries() {
    const counts = { booked: 2, waitlisted: 1, checkedIn: 0 };
    const Panel = () => { usePublishSessionCounts(counts); return null; };
    return createRegistries([{ sessionPanels: [{ id: 'test.notice-counts', labelKey: 'schedule/schedule:bookings', enabled: true,
      permission: { kind: 'staff', capability: 'schedule.manage' }, component: Panel }] }]);
  }
  it.each(['owner', 'admin', 'coach'] as const)('offers %s an optional notice and submits its plain text note', async role => {
    bootstrap([role], id, programId);
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    const onSaved = vi.fn();
    render(<SessionDetail session={{ ...session, coachId: programId }} options={options} roles={[role]} enabledModules={[]} onSaved={onSaved} registries={noticeRegistries()}/>);
    const checkbox = screen.getByRole('checkbox', { name: 'Email the 3 booked and waitlisted members' });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText(/Optional cancellation note/)).toBeNull();
    fireEvent.click(checkbox);
    const note = screen.getByLabelText(/Optional cancellation note/);
    expect(note.getAttribute('maxlength')).toBe('1000');
    fireEvent.change(note, { target: { value: '<b>Closed</b>\nTomorrow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', { params: { path: { id } }, body: { revision: 4, notify: true, note: '<b>Closed</b>\nTomorrow' } });
  });
  it.each(['other_coach', 'unlinked_coach', 'front_desk'] as const)('hides the notice option from %s', kind => {
    const role = kind === 'front_desk' ? 'front_desk' : 'coach';
    bootstrap([role], id, kind === 'other_coach' ? id : null);
    render(<SessionDetail session={{ ...session, coachId: programId }} options={options} roles={[role]} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
    expect(screen.queryByRole('checkbox', { name: /Email the/ })).toBeNull();
  });
  it('keeps cancellation without email available and hides the option on an already cancelled session', async () => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    const view = render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', { params: { path: { id } }, body: { revision: 4 } }));
    view.rerender(<SessionDetail session={{ ...session, status: 'cancelled' }} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
    expect(screen.queryByRole('checkbox', { name: /Email the/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Cancel session' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('retains a selected email option while stale counts require a roster refresh', () => {
    let counts = { booked: 2, waitlisted: 1, checkedIn: 0, stale: false };
    const Panel = () => { usePublishSessionCounts(counts); return null; };
    const registries = createRegistries([{ sessionPanels: [{ id: 'test.stale-notice', labelKey: 'schedule/schedule:bookings', enabled: true,
      permission: { kind: 'staff', capability: 'schedule.manage' }, component: Panel }] }]);
    const detail = () => <SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={registries}/>;
    const view = render(detail());
    fireEvent.click(screen.getByRole('checkbox', { name: /Email the 3/ }));
    fireEvent.change(screen.getByLabelText(/Optional cancellation note/), { target: { value: 'Keep this note' } });
    counts = { ...counts, stale: true }; view.rerender(detail());
    expect((screen.getByRole('checkbox', { name: /Email the 3/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel session' }) as HTMLButtonElement).disabled).toBe(true);
    counts = { ...counts, stale: false }; view.rerender(detail());
    expect((screen.getByRole('button', { name: 'Cancel session' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText(/Optional cancellation note/) as HTMLTextAreaElement).value).toBe('Keep this note');
  });
  it('uses gym dates, calendar weeks and DST offsets independently of the browser', () => {
    expect(calendarDate(new Date('2026-03-02T02:00:00Z'), 'America/New_York')).toBe('2026-03-01');
    expect(weekStart('2026-03-08')).toBe('2026-03-02');
    expect(shiftDate('2026-03-02', 7)).toBe('2026-03-09');
    expect(calendarInstant('2026-03-02T00:00', 'America/New_York')).toBe('2026-03-02T05:00:00.000Z');
    expect(calendarInstant('2026-03-09T00:00', 'America/New_York')).toBe('2026-03-09T04:00:00.000Z');
    expect(() => calendarInstant('2026-03-08T02:30', 'America/New_York')).toThrow();
    expect(calendarInstant('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(localTime(new Date('2026-03-02T23:00:00Z'), 'America/New_York')).toBe('18:00');
    expect(sessionTimes(session, 'America/New_York')).toBe('6:00 PM–7:00 PM');
  });
  it('renders all permitted registered panels with the session ID, and honors modules and flags', () => {
    const seen: string[] = [];
    const component = ({ sessionId }: { sessionId?: string }) => { if (sessionId) seen.push(sessionId); return <p>Extension panel</p>; };
    const entry = { labelKey: 'schedule/schedule:notes', permission: { kind: 'staff' as const, capability: 'attendance.manage' as const }, enabled: true, component };
    const registries = createRegistries([{ sessionPanels: [
      { ...entry, id: 'test.one' }, { ...entry, id: 'test.two' }, { ...entry, id: 'test.disabled', enabled: false },
      { ...entry, id: 'test.module', moduleId: 'extra' }, { ...entry, id: 'test.owner', permission: { kind: 'staff', capability: 'staff.manage' } },
    ] }]);
    const view = render(<SessionPanels sessionId={id} roles={['coach']} registries={registries}/>);
    expect(screen.getAllByText('Extension panel')).toHaveLength(2); expect(seen).toEqual([id, id]);
    view.rerender(<SessionPanels sessionId={id} roles={['coach']} enabledModules={['extra']} registries={registries}/>);
    expect(screen.getAllByText('Extension panel')).toHaveLength(3);
  });
  it('shows the booking counts a session panel publishes beside the capacity, and clears them when the panel goes', () => {
    let counts: { booked: number; waitlisted: number; checkedIn: number; stale?: boolean } | null = { booked: 4, waitlisted: 2, checkedIn: 3 };
    const Panel = () => { usePublishSessionCounts(counts); return <p>Counting panel</p>; };
    const entry = { id: 'test.counts', labelKey: 'schedule/schedule:notes', permission: { kind: 'staff' as const, capability: 'attendance.manage' as const }, enabled: true, component: Panel };
    const registries = createRegistries([{ sessionPanels: [entry] }]);
    const detail = (capacity: number | null) => <SessionDetail session={{ ...session, capacity, notes: null }} options={options} roles={['coach']} enabledModules={[]} onSaved={vi.fn()} registries={registries}/>;
    const view = render(detail(5));
    expect(screen.getByTestId('session-counts').textContent).toBe('Booked 4 of 5 · 2 waitlisted · 3 checked in');
    view.rerender(detail(null));
    expect(screen.getByTestId('session-counts').textContent).toBe('Booked 4 · 2 waitlisted · 3 checked in');
    counts = { booked: 5, waitlisted: 0, checkedIn: 1, stale: true }; view.rerender(detail(5));
    expect(screen.getByTestId('session-counts').textContent).toBe('Booked 5 of 5 · 0 waitlisted · 1 checked in');
    expect(screen.getByText('These counts may be out of date. Refresh the roster to try again.')).toBeDefined();
    counts = { ...counts, stale: false }; view.rerender(detail(5));
    expect(screen.queryByText(/These counts may be out of date/)).toBeNull();
    view.unmount();
  });
  it('tells the panels a capacity save changed the bookings, but not a notes save', async () => {
    const changes: number[] = [];
    const Panel = () => { changes.push(useSessionChanged()); return <p>Watching panel</p>; };
    const entry = { id: 'test.watch', labelKey: 'schedule/schedule:notes', permission: { kind: 'staff' as const, capability: 'attendance.manage' as const }, enabled: true, component: Panel };
    const registries = createRegistries([{ sessionPanels: [entry] }]);
    vi.mocked(api.PATCH).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, capacity: 7 } } } as Awaited<ReturnType<typeof api.PATCH>>);
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={registries}/>);
    expect(Math.max(...changes)).toBe(0);
    fireEvent.change(screen.getByLabelText('Coach notes', { selector: 'textarea' }), { target: { value: 'Updated' } }); fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await waitFor(() => expect(api.PATCH).toHaveBeenCalledTimes(1)); expect(Math.max(...changes)).toBe(0);
    fireEvent.change(screen.getByLabelText('Capacity'), { target: { value: '7' } }); fireEvent.click(screen.getByRole('button', { name: 'Save capacity' }));
    await waitFor(() => expect(Math.max(...changes)).toBe(1));
  });
  it('shows no booking summary when no panel publishes counts', () => {
    render(<SessionDetail session={session} options={options} roles={['coach']} enabledModules={[]} onSaved={vi.fn()} registries={createRegistries()}/>);
    expect(screen.queryByTestId('session-counts')).toBeNull();
  });
  it('saves plain text notes with the displayed revision and hides schedule edits from front desk', async () => {
    const onSaved = vi.fn();
    vi.mocked(api.PATCH).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, notes: 'Updated' } } } as Awaited<ReturnType<typeof api.PATCH>>);
    render(<SessionDetail session={session} options={options} roles={['front_desk']} enabledModules={[]} onSaved={onSaved}/>);
    expect(screen.queryByRole('button', { name: 'Cancel session' })).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>Keep plain</script>', { selector: 'p' })).toBeDefined();
    fireEvent.change(screen.getByLabelText('Coach notes'), { target: { value: 'Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ notes: 'Updated', revision: 5 })));
    expect(api.PATCH).toHaveBeenCalledWith('/api/schedule/sessions/{id}/notes', expect.objectContaining({ body: { revision: 4, notes: 'Updated' } }));
  });
  it('leaves stale edits intact and shows a safe conflict message', async () => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(null, { status: 409 }) } as Awaited<ReturnType<typeof api.POST>>);
    const onSaved = vi.fn();
    render(<SessionDetail session={session} options={options} roles={['coach']} enabledModules={[]} onSaved={onSaved}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    // Registered session panels (such as attendance) render their own status messages.
    expect((await screen.findByText(/Reload/)).getAttribute('role')).toBe('status');
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', { params: { path: { id } }, body: { revision: 4 } });
  });
  it('loads a full gym week, opens session detail and retains the chosen week on reload', async () => {
    render(<SchedulePage/>);
    const button = await screen.findByRole('button', { name: /Evening class/ });
    fireEvent.click(button); expect(screen.getByRole('dialog', { name: 'Evening class' })).toBeDefined();
    expect(api.GET).toHaveBeenCalledWith('/api/schedule/sessions', expect.objectContaining({ params: { query: { from: '2026-03-02T05:00:00.000Z', until: '2026-03-09T04:00:00.000Z', limit: 100, offset: 0 } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect((screen.getByLabelText('Week of') as HTMLInputElement).value).toBe('2026-03-09'));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect((vi.mocked(api.GET).mock.calls as unknown as [string, unknown][]).filter(([path]) => path === '/api/schedule/options')).toHaveLength(2));
    expect((screen.getByLabelText('Week of') as HTMLInputElement).value).toBe('2026-03-09');
  });
  it('creates a weekly class with many-to-many program selection and the gym local start', async () => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: {} } as Awaited<ReturnType<typeof api.POST>>);
    render(<SchedulePage/>); fireEvent.click(await screen.findByRole('button', { name: 'New weekly class' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning class' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Program A' }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'open_mat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.POST).toHaveBeenCalledWith('/api/schedule/templates', { body: { name: 'Morning class', weekday: 1, localStartTime: '18:00', durationMinutes: 60, coachId: null, capacity: null, notes: null, kind: 'open_mat', programIds: [programId], tagIds: [] } }));
  });
  it('uses the same clock style for weekly-class summaries and sessions', async () => {
    const load = vi.mocked(api.GET).getMockImplementation()!;
    vi.mocked(api.GET).mockImplementation((...args) => args[0] === '/api/schedule/templates'
      ? Promise.resolve({ response: new Response(), data: { data: [{ id, name: 'Weekly evening class', weekday: 1, localStartTime: '18:00',
        durationMinutes: 60, coachId: null, capacity: null, notes: null, kind: 'class', programIds: [programId], tagIds: [], revision: 1,
        createdAt: session.createdAt }], pagination: { offset: 0, limit: 100, total: 1 } } } as Awaited<ReturnType<typeof api.GET>>)
      : load(...args));
    render(<SchedulePage/>);
    expect(await screen.findByText(/Monday 6:00 PM/)).toBeDefined();
    expect((await screen.findByRole('button', { name: /Evening class/ })).textContent).toContain('6:00 PM–7:00 PM');
  });
  it('fails closed for a member and never requests schedule data', () => {
    bootstrap([]); render(<SchedulePage/>);
    expect(screen.getByRole('alert').textContent).toContain('permission'); expect(api.GET).not.toHaveBeenCalled();
  });
  it('shows a safe load error and retries from the reload button', async () => {
    vi.mocked(api.GET).mockRejectedValueOnce(new Error('SQL password secret'));
    render(<SchedulePage/>);
    expect((await screen.findByRole('alert')).textContent).not.toContain('SQL password');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await screen.findByRole('button', { name: /Evening class/ });
  });
  it('moves a generated session with the full revision-checked update and keeps its other fields', async () => {
    const generated = { ...session, templateId: id, tagIds: [] };
    vi.mocked(api.PUT).mockResolvedValue({ response: new Response(), data: { data: { ...generated, startsAt: '2026-03-03T00:00:00.000Z', endsAt: '2026-03-03T01:00:00.000Z', revision: 5 } } } as Awaited<ReturnType<typeof api.PUT>>);
    const onSaved = vi.fn();
    render(<SessionForm session={generated} options={options} tags={[]} siblings={[generated]} onSaved={onSaved} onCancel={vi.fn()}/>);
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-03-02');
    expect((screen.getByLabelText('Start time') as HTMLInputElement).value).toBe('18:00');
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '19:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 })));
    expect(api.PUT).toHaveBeenCalledWith('/api/schedule/sessions/{id}', { params: { path: { id } }, body: {
      name: 'Evening class', startsAt: '2026-03-03T00:00:00.000Z', endsAt: '2026-03-03T01:00:00.000Z', coachId: null, capacity: null,
      notes: session.notes, kind: 'class', programIds: [programId], tagIds: [], revision: 4 } });
  });
  it('refuses a move onto another loaded occurrence of the same weekly class before saving', async () => {
    const generated = { ...session, templateId: id };
    const sibling = { ...generated, id: '00000000-0000-7000-8000-000000000009', startsAt: '2026-03-09T22:00:00Z', endsAt: '2026-03-09T23:00:00Z' };
    render(<SessionForm session={generated} options={options} tags={[]} siblings={[generated, sibling]} onSaved={vi.fn()} onCancel={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-09' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already starts at exactly this time');
    expect(api.PUT).not.toHaveBeenCalled();
  });
  it.each([
    ['session_start_taken', 'already starts at exactly this time'],
    ['conflict', 'changed or is in use'],
    ['unknown_conflict', 'changed or is in use'],
  ])('explains %s without inferring the cause from a second read', async (code, message) => {
    const generated = { ...session, templateId: id };
    vi.mocked(api.PUT).mockResolvedValue({ response: new Response(null, { status: 409 }), error: { error: { code } } } as Awaited<ReturnType<typeof api.PUT>>);
    render(<SessionForm session={generated} options={options} tags={[]} siblings={[generated]} onSaved={vi.fn()} onCancel={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-09' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(api.GET).not.toHaveBeenCalled();
  });
  it('rejects a start time skipped by daylight saving without calling the API', async () => {
    render(<SessionForm session={session} options={options} tags={[]} siblings={[]} onSaved={vi.fn()} onCancel={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-08' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '02:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    expect((await screen.findByRole('alert')).textContent).toContain('clocks change');
    expect(api.PUT).not.toHaveBeenCalled();
  });
  it('opens the edit form from session detail for schedule managers only', () => {
    const { rerender } = render(<SessionDetail session={session} options={options} roles={['front_desk']} enabledModules={[]} onSaved={vi.fn()}/>);
    expect(screen.queryByRole('button', { name: 'Edit or move session' })).toBeNull();
    rerender(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit or move session' }));
    expect(screen.getByRole('form', { name: 'Edit or move session' })).toBeDefined();
  });
});
