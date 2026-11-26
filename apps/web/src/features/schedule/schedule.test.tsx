// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { sessionTimes } from './session.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createWebRegistries, type StaffRole } from '@plaingym/shared';
import type { ClassSession, ClassTemplate } from '@plaingym/shared/contracts';
import type { ReactElement } from 'react';
import type { ScheduleOptions } from './session.js';
import { api } from '../../lib/api.js';
import { useBootstrap } from '../../app/context.js';
import type { ShellBootstrap } from '../../app/services.js';
import { createRegistries, type ExtensionView } from '../../lib/registries.js';
import { usePublishSessionCounts, useSessionChanged, useSessionCounts } from '../../lib/session-summary.js';
import { SchedulePage, SessionDetail, SessionForm, SessionPanels } from './page.js';
import { ClassEditor } from './editor.js';
import { calendarDate, calendarInstant, localTime, shiftDate, weekStart } from './calendar.js';
vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('../../lib/api.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../../lib/api.js')>(), api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() } }));
const id = '00000000-0000-7000-8000-000000000001', programId = '00000000-0000-7000-8000-000000000002';
const options = { timezone: 'America/New_York', programs: [{ id: programId, name: 'Program A' }], coaches: [] };
const session: ClassSession = { id, name: 'Evening class', startsAt: '2026-03-02T23:00:00Z', endsAt: '2026-03-03T00:00:00Z',
  cancelBefore: '2026-03-02T22:00:00Z',
  templateId: null, coachId: null, status: 'scheduled', capacity: null, notes: '<script>Keep plain</script>', kind: 'class', programIds: [programId], tagIds: [], revision: 4, createdAt: '2026-03-01T00:00:00Z' };
const textHint = "Texts go to each member's own phone when they agreed to notices texts, otherwise to their household's billing phone when it agreed to them, and only while Member texts is on in Settings → Go-live.";
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
    expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', { params: { path: { id } }, body: { revision: 4, notify: true, channels: ['email'], note: '<b>Closed</b>\nTomorrow' } });
  });
  it.each([
    [['email'], ['email']],
    [['sms'], ['sms']],
    [['email', 'sms'], ['email', 'sms']],
    [['sms', 'email'], ['email', 'sms']],
  ] as const)('ticking %j sends channels %j, both boxes starting unticked', async (ticked, channels) => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    const onSaved = vi.fn();
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={onSaved} registries={noticeRegistries()}/>);
    const boxes = { email: screen.getByRole('checkbox', { name: 'Email the 3 booked and waitlisted members' }) as HTMLInputElement,
      sms: screen.getByRole('checkbox', { name: 'Text the 3 booked and waitlisted members' }) as HTMLInputElement };
    expect([boxes.email.checked, boxes.sms.checked]).toEqual([false, false]);
    expect(boxes.sms.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(boxes.sms.getAttribute('aria-describedby')!)?.textContent)
      .toBe(textHint);
    expect(screen.queryByLabelText(/Optional cancellation note/)).toBeNull();
    for (const channel of ticked) fireEvent.click(boxes[channel]);
    const hasEmail = (ticked as readonly string[]).includes('email');
    if (hasEmail) fireEvent.change(screen.getByLabelText(/Optional cancellation note \(email only/), { target: { value: 'Closed' } });
    else expect(screen.queryByLabelText(/Optional cancellation note/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', {
      params: { path: { id } }, body: { revision: 4, notify: true, channels, ...(hasEmail ? { note: 'Closed' } : {}) },
    });
  });
  it('keeps the cancellation note while Email is unticked and sends it only while Email is ticked', async () => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    const onSaved = vi.fn();
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={onSaved} registries={noticeRegistries()}/>);
    const email = screen.getByRole('checkbox', { name: /Email the 3/ }), sms = screen.getByRole('checkbox', { name: /Text the 3/ });
    fireEvent.click(sms); expect(screen.queryByLabelText(/Optional cancellation note/)).toBeNull();
    fireEvent.click(email);
    fireEvent.change(screen.getByLabelText(/Optional cancellation note/), { target: { value: 'Draft note' } });
    fireEvent.click(email); expect(screen.queryByLabelText(/Optional cancellation note/)).toBeNull();
    fireEvent.click(email);
    expect((screen.getByLabelText(/Optional cancellation note/) as HTMLTextAreaElement).value).toBe('Draft note');
    fireEvent.click(email); expect(screen.queryByLabelText(/Optional cancellation note/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', {
      params: { path: { id } }, body: { revision: 4, notify: true, channels: ['sms'] },
    });
  });
  it('sends the retained note after unticking and ticking Email again', async () => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    const onSaved = vi.fn();
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={onSaved} registries={noticeRegistries()}/>);
    const email = screen.getByRole('checkbox', { name: /Email the 3/ });
    fireEvent.click(email);
    fireEvent.change(screen.getByLabelText(/Optional cancellation note/), { target: { value: 'Draft note' } });
    fireEvent.click(email); expect(screen.queryByLabelText(/Optional cancellation note/)).toBeNull();
    fireEvent.click(email);
    expect((screen.getByLabelText(/Optional cancellation note/) as HTMLTextAreaElement).value).toBe('Draft note');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', {
      params: { path: { id } }, body: { revision: 4, notify: true, channels: ['email'], note: 'Draft note' },
    });
  });
  it('empties the cancellation note once the cancellation is saved, so a later cancel of the same session starts clean', async () => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    const onSaved = vi.fn();
    const view = render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={onSaved} registries={noticeRegistries()}/>);
    fireEvent.click(screen.getByRole('checkbox', { name: /Email the 3/ }));
    fireEvent.change(screen.getByLabelText(/Optional cancellation note/), { target: { value: 'Coach sick' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    view.rerender(<SessionDetail session={{ ...session, revision: 6 }} options={options} roles={['owner']} enabledModules={[]} onSaved={onSaved} registries={noticeRegistries()}/>);
    expect((await screen.findByLabelText(/Optional cancellation note/) as HTMLTextAreaElement).value).toBe('');
  });
  it('locks both boxes with their none texts when nobody is booked or waitlisted', async () => {
    const counts = { booked: 0, waitlisted: 0, checkedIn: 0 };
    const Panel = () => { usePublishSessionCounts(counts); return null; };
    const registries = createRegistries([{ sessionPanels: [{ id: 'test.empty-notice', labelKey: 'schedule/schedule:bookings', enabled: true,
      permission: { kind: 'staff', capability: 'schedule.manage' }, component: Panel }] }]);
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={registries}/>);
    for (const name of ['No booked or waitlisted members to email', 'No booked or waitlisted members to text']) {
      const box = screen.getByRole('checkbox', { name }) as HTMLInputElement;
      expect(box.disabled).toBe(true); expect(box.checked).toBe(false);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', { params: { path: { id } }, body: { revision: 4 } }));
  });
  it('names one member in the text option too', () => {
    const counts = { booked: 1, waitlisted: 0, checkedIn: 0 };
    const Panel = () => { usePublishSessionCounts(counts); return null; };
    const registries = createRegistries([{ sessionPanels: [{ id: 'test.one-notice', labelKey: 'schedule/schedule:bookings', enabled: true,
      permission: { kind: 'staff', capability: 'schedule.manage' }, component: Panel }] }]);
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={registries}/>);
    expect(screen.getByRole('checkbox', { name: 'Text the 1 booked or waitlisted member' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Email the 1 booked or waitlisted member' })).toBeTruthy();
  });
  it('explains an already-cancelled response and refreshes the stale session', async () => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(null, { status: 409 }),
      error: { error: { details: { reason: ['already_cancelled'] } } } } as Awaited<ReturnType<typeof api.POST>>);
    const cancelled = { ...session, status: 'cancelled' as const, revision: 5 };
    vi.mocked(api.GET).mockResolvedValue({ response: new Response(), data: { data: cancelled } } as Awaited<ReturnType<typeof api.GET>>);
    const onSaved = vi.fn();
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={onSaved} registries={noticeRegistries()}/>);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email the 3 booked and waitlisted members' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('This session is already cancelled. No cancellation notice was queued.'));
    expect(api.GET).toHaveBeenCalledWith('/api/schedule/sessions/{id}', { params: { path: { id } } });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(cancelled));
  });
  it.each(['2026-03-02T23:00:00Z', '2026-03-02T23:30:00Z', '2026-03-03T01:00:00Z'])('hides cancellation controls once started at %s', now => {
    vi.setSystemTime(new Date(now));
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
    expect(screen.queryByRole('button', { name: 'Cancel session' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /(Email|Text) the/ })).toBeNull();
  });
  it.each([
    ['nothing', 'This session has started and cannot be cancelled.'],
    ['Text the 3 booked and waitlisted members', 'This session has started and cannot be cancelled.'],
    ['Email the 3 booked and waitlisted members', 'This session has started and cannot be cancelled. Your cancellation note was not sent.'],
  ] as const)('shows the specific refusal when the server finds the session has started (ticked: %s)', async (ticked, expected) => {
    const onSaved = vi.fn();
    const response = Response.json({ error: { code: 'conflict', message: 'Server message', details: { reason: ['session_started'] } } }, { status: 409 });
    const error: unknown = await response.json(); // The typed API client consumes the body before returning.
    vi.mocked(api.POST).mockResolvedValue({ response, error } as Awaited<ReturnType<typeof api.POST>>);
    const registries = noticeRegistries();
    const view = render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={onSaved} registries={registries}/>);
    if (ticked !== 'nothing') fireEvent.click(screen.getByRole('checkbox', { name: ticked }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(expected));
    // The browser is still eight hours behind the server's start decision.
    expect(Date.now()).toBeLessThan(Date.parse(session.startsAt));
    expect(screen.queryByRole('button', { name: 'Cancel session' })).toBeNull();
    expect(screen.queryByLabelText(/Optional cancellation note/)).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    // Another staff member moves the session: the refusal was for the old start, so cancelling is offered again.
    view.rerender(<SessionDetail session={{ ...session, startsAt: '2026-03-09T23:00:00Z', endsAt: '2026-03-10T00:00:00Z', revision: 5 }} options={options} roles={['owner']} enabledModules={[]} onSaved={onSaved} registries={registries}/>);
    expect(screen.getByRole('button', { name: 'Cancel session' })).toBeTruthy();
  });
  it.each(['visibilitychange', 'focus'] as const)('hides the cancel form when the clock jumps past the start and %s', eventName => {
    const start = Date.parse(session.startsAt);
    vi.useFakeTimers(); vi.setSystemTime(new Date(start - 5_000));
    const timeout = vi.spyOn(window, 'setTimeout'), clearTimeout = vi.spyOn(window, 'clearTimeout');
    try {
      render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
      expect(screen.getByRole('button', { name: 'Cancel session' })).toBeDefined();
      const startTimer = timeout.mock.results[timeout.mock.calls.findIndex(([, delay]) => delay === 5_000)];
      expect(startTimer?.type).toBe('return');
      vi.setSystemTime(new Date(start + 1_000));
      act(() => {
        if (eventName === 'focus') window.dispatchEvent(new Event('focus'));
        else document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(screen.queryByRole('button', { name: 'Cancel session' })).toBeNull();
      expect(screen.getByText('This session has started and cannot be cancelled.')).toBeDefined();
      expect(clearTimeout).toHaveBeenCalledWith(startTimer?.value);
      expect(api.POST).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); clearTimeout.mockRestore(); }
  });
  it('tells nobody without the cancel form that a note was not sent when the start passes', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(session.startsAt) - 5_000));
    render(<SessionDetail session={session} options={options} roles={['front_desk']} enabledModules={[]} onSaved={vi.fn()} registries={createWebRegistries<ExtensionView>([])}/>);
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('uses one start timer and explains that an unsent note was not delivered when time passes', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(session.startsAt) - 5_000));
    const timeout = vi.spyOn(window, 'setTimeout'), interval = vi.spyOn(window, 'setInterval');
    try {
      const rendered = vi.fn();
      const counts = { booked: 1, waitlisted: 0, checkedIn: 0 };
      const Panel = () => { rendered(); usePublishSessionCounts(counts); return null; };
      const registries = createWebRegistries<ExtensionView>([{ sessionPanels: [{ id: 'timer-counts', labelKey: 'schedule/schedule:bookings', enabled: true,
        permission: { kind: 'staff', capability: 'schedule.manage' }, component: Panel }] }]);
      const view = render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={registries}/>);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Email the 1 booked or waitlisted member' }));
      fireEvent.change(screen.getByLabelText(/Optional cancellation note/), { target: { value: 'Please save this note' } });
      const renders = rendered.mock.calls.length;
      act(() => vi.advanceTimersByTime(1_000));
      act(() => { window.dispatchEvent(new Event('focus')); });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(screen.getByRole('button', { name: 'Cancel session' })).toBeDefined();
      expect(timeout.mock.calls.map(([, delay]) => delay)).toEqual([5_000]);
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(3_000));
      expect(rendered).toHaveBeenCalledTimes(renders);
      expect(interval).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.queryByRole('button', { name: 'Cancel session' })).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('Your cancellation note was not sent.');
      expect(api.POST).not.toHaveBeenCalled();
      view.unmount(); expect(vi.getTimerCount()).toBe(0);
    } finally { timeout.mockRestore(); interval.mockRestore(); }
  });
  it('schedules the remaining time when the capped start timeout fires before the session starts', () => {
    const cap = 2_147_483_647, remaining = 5_000;
    vi.useFakeTimers(); vi.setSystemTime(new Date(Date.parse(session.startsAt) - cap - remaining));
    const timeout = vi.spyOn(window, 'setTimeout');
    try {
      render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
      expect(timeout.mock.calls.map(([, delay]) => delay)).toEqual([cap]);
      act(() => vi.advanceTimersByTime(cap));
      expect(screen.getByRole('button', { name: 'Cancel session' })).toBeDefined();
      expect(timeout.mock.calls.map(([, delay]) => delay)).toEqual([cap, remaining]);
      act(() => vi.advanceTimersByTime(remaining));
      expect(screen.queryByRole('button', { name: 'Cancel session' })).toBeNull();
      expect(timeout.mock.calls.map(([, delay]) => delay)).toEqual([cap, remaining]);
      expect(api.POST).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });
  it('does not schedule a start timer for a started session', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(session.startsAt));
    render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={createWebRegistries<ExtensionView>([])}/>);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['other_coach', 'unlinked_coach', 'front_desk'] as const)('hides the notice option from %s', kind => {
    const role = kind === 'front_desk' ? 'front_desk' : 'coach';
    bootstrap([role], id, kind === 'other_coach' ? id : null);
    render(<SessionDetail session={{ ...session, coachId: programId }} options={options} roles={[role]} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
    expect(screen.queryByRole('checkbox', { name: /(Email|Text) the/ })).toBeNull();
  });
  it('keeps cancellation without email available and offers a restore instead on an already cancelled session', async () => {
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 5, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    const view = render(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/cancel', { params: { path: { id } }, body: { revision: 4 } }));
    view.rerender(<SessionDetail session={{ ...session, status: 'cancelled' }} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()} registries={noticeRegistries()}/>);
    expect(screen.queryByRole('checkbox', { name: /(Email|Text) the \d/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel session' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore class' })).toBeTruthy();
  });
  describe('restoring a cancelled class', () => {
    const cancelled = { ...session, status: 'cancelled' as const, coachId: programId };
    const restored = { ...cancelled, status: 'scheduled' as const, revision: 5 };
    const boxes = () => ({ email: screen.getByRole('checkbox', { name: 'Email the members whose places come back' }) as HTMLInputElement,
      sms: screen.getByRole('checkbox', { name: 'Text the members whose places come back' }) as HTMLInputElement });
    const detail = (roles: StaffRole[] = ['owner'], onSaved = vi.fn(), value: ClassSession = cancelled) =>
      <SessionDetail session={value} options={options} roles={roles} enabledModules={[]} onSaved={onSaved} registries={noticeRegistries()}/>;
    it('shows an owner the help, two unticked boxes with the text hint, and a Restore class button', () => {
      render(detail());
      expect(screen.getByText(/^Brings this class back and restores the places its cancellation cancelled/)).toBeTruthy();
      const { email, sms } = boxes();
      expect([email.checked, sms.checked]).toEqual([false, false]);
      expect(document.getElementById(sms.getAttribute('aria-describedby')!)?.textContent).toBe(textHint);
      expect(screen.getByRole('button', { name: 'Restore class' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Cancel session' })).toBeNull();
    });
    it.each([
      [[], { revision: 4 }],
      [['email'], { revision: 4, notify: true, channels: ['email'] }],
      [['sms'], { revision: 4, notify: true, channels: ['sms'] }],
      [['sms', 'email'], { revision: 4, notify: true, channels: ['email', 'sms'] }],
    ] as const)('ticking %j posts %j, then reports the restore and reloads the panels', async (ticked, body) => {
      vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: restored } } as Awaited<ReturnType<typeof api.POST>>);
      const onSaved = vi.fn();
      render(detail(['owner'], onSaved));
      for (const channel of ticked) fireEvent.click(boxes()[channel]);
      fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(restored));
      expect(api.POST).toHaveBeenCalledWith('/api/schedule/sessions/{id}/restore', { params: { path: { id } }, body });
      expect(screen.getByRole('status').textContent).toBe('Class restored. The places its cancellation cancelled are back.');
    });
    it.each([
      [0, false, 'Class restored. No places came back; members can book it again.'],
      [0, true, 'Class restored. No places came back, so no notice was sent; members can book it again.'],
      [2, false, 'Class restored. The places its cancellation cancelled are back.'],
      [2, true, 'Class restored. The places its cancellation cancelled are back.'],
      [undefined, false, 'Class restored. The places its cancellation cancelled are back.'],
    ] as const)('reports restoredBookings=%s (notify=%s) with the matching restore notice', async (restoredBookings, notify, expected) => {
      vi.mocked(api.POST).mockResolvedValue({
        response: new Response(),
        data: { data: restored, ...(restoredBookings === undefined ? {} : { restoredBookings }) },
      } as Awaited<ReturnType<typeof api.POST>>);
      const onSaved = vi.fn();
      render(detail(['owner'], onSaved));
      if (notify) fireEvent.click(boxes().email);
      fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(restored));
      expect(screen.getByRole('status').textContent).toBe(expected);
    });
    it('lets the session coach notify, and another coach restore without the boxes', () => {
      bootstrap(['coach'], id, programId);
      render(detail(['coach']));
      expect([boxes().email.checked, boxes().sms.checked]).toEqual([false, false]);
      cleanup(); bootstrap(['coach'], id, id);
      render(detail(['coach']));
      expect(screen.getByRole('button', { name: 'Restore class' })).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: /places come back/ })).toBeNull();
    });
    it('shows front desk no restore form', () => {
      bootstrap(['front_desk']);
      render(detail(['front_desk']));
      expect(screen.queryByRole('button', { name: 'Restore class' })).toBeNull();
      expect(screen.queryByText(/^Brings this class back/)).toBeNull();
    });
    it('takes the restore form away and explains why when a cancelled session reaches its start, without a cancel note', () => {
      const start = Date.parse(cancelled.startsAt);
      vi.useFakeTimers(); vi.setSystemTime(new Date(start - 60_000));
      render(detail());
      expect(screen.getByRole('button', { name: 'Restore class' })).toBeTruthy();
      act(() => vi.advanceTimersByTime(61_000));
      expect(screen.queryByRole('button', { name: 'Restore class' })).toBeNull();
      expect(screen.queryByRole('checkbox', { name: /places come back/ })).toBeNull();
      expect(screen.getByText("This session has started and can't be restored.").getAttribute('role')).toBe('status');
      expect(screen.queryByText(/This session has started and cannot be cancelled/)).toBeNull();
      expect(screen.queryByText(/Your cancellation note was not sent/)).toBeNull();
      cleanup();
      vi.setSystemTime(new Date(start - 60_000));
      bootstrap(['front_desk']);
      render(<SessionDetail session={cancelled} options={options} roles={['front_desk']} enabledModules={[]} onSaved={vi.fn()} registries={createWebRegistries<ExtensionView>([])}/>);
      act(() => vi.advanceTimersByTime(61_000));
      expect(screen.queryByRole('status')).toBeNull();
    });
    it.each(['2026-03-02T23:00:00Z', '2026-03-03T01:00:00Z'])('shows no restore form for a cancelled session started at %s', now => {
      vi.setSystemTime(new Date(now));
      render(detail());
      expect(screen.queryByRole('button', { name: 'Restore class' })).toBeNull();
      expect(screen.queryByRole('checkbox', { name: /places come back/ })).toBeNull();
    });
    it('explains a session that started before the restore and hides the form', async () => {
      vi.mocked(api.POST).mockResolvedValue({ response: new Response(null, { status: 409 }),
        error: { error: { details: { reason: ['session_started'] } } } } as Awaited<ReturnType<typeof api.POST>>);
      const onSaved = vi.fn();
      render(detail(['owner'], onSaved));
      fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe("This session has started and can't be restored."));
      expect(screen.queryByRole('button', { name: 'Restore class' })).toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
    });
    it('explains a session that is no longer cancelled and refreshes it', async () => {
      vi.mocked(api.POST).mockResolvedValue({ response: new Response(null, { status: 409 }),
        error: { error: { details: { reason: ['not_cancelled'] } } } } as Awaited<ReturnType<typeof api.POST>>);
      vi.mocked(api.GET).mockResolvedValue({ response: new Response(), data: { data: restored } } as Awaited<ReturnType<typeof api.GET>>);
      const onSaved = vi.fn();
      render(detail(['owner'], onSaved));
      fireEvent.click(boxes().email);
      fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe("This session isn't cancelled any more. No notice was queued."));
      expect(api.GET).toHaveBeenCalledWith('/api/schedule/sessions/{id}', { params: { path: { id } } });
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(restored));
    });
    it('shows the conflict message for a stale revision', async () => {
      vi.mocked(api.POST).mockResolvedValue({ response: new Response(null, { status: 409 }),
        error: { error: { code: 'conflict' } } } as Awaited<ReturnType<typeof api.POST>>);
      render(detail());
      fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('This record changed or is in use. Reload before trying again.'));
    });
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
    let counts: { booked: number; waitlisted: number; checkedIn: number; stale?: boolean } | null = { booked: 1200, waitlisted: 2400, checkedIn: 3600 };
    const Panel = () => { usePublishSessionCounts(counts); return <p>Counting panel</p>; };
    // Another panel in the dialog reads what the counting panel published.
    const Reader = () => { const seen = useSessionCounts(); return <p data-testid="read-counts">{seen ? `${seen.booked}|${seen.waitlisted}|${seen.checkedIn}` : 'none'}</p>; };
    const entry = { id: 'test.counts', labelKey: 'schedule/schedule:notes', permission: { kind: 'staff' as const, capability: 'attendance.manage' as const }, enabled: true, component: Panel };
    const reader = { ...entry, id: 'test.reader', component: Reader };
    const registries = createRegistries([{ sessionPanels: [entry, reader] }]);
    const detail = (capacity: number | null) => <SessionDetail session={{ ...session, capacity, notes: null }} options={options} roles={['coach']} enabledModules={[]} onSaved={vi.fn()} registries={registries}/>;
    const view = render(detail(4800));
    expect(screen.getByTestId('session-counts').textContent).toBe('Booked 1,200 of 4,800 · 2,400 waitlisted · 3,600 checked in');
    expect(screen.getByTestId('read-counts').textContent).toBe('1200|2400|3600');
    view.rerender(detail(null));
    expect(screen.getByTestId('session-counts').textContent).toBe('Booked 1,200 · 2,400 waitlisted · 3,600 checked in');
    counts = { booked: 5, waitlisted: 0, checkedIn: 1, stale: true }; view.rerender(detail(5));
    expect(screen.getByTestId('session-counts').textContent).toBe('Booked 5 of 5 · 0 waitlisted · 1 checked in');
    expect(screen.getByText('These counts may be out of date. Refresh the roster to try again.')).toBeDefined();
    counts = { ...counts, stale: false }; view.rerender(detail(5));
    expect(screen.queryByText(/These counts may be out of date/)).toBeNull();
    view.unmount();
  });
  it('tells the panels a capacity save or a cancellation changed the bookings, but not a notes save', async () => {
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
    vi.mocked(api.POST).mockResolvedValue({ response: new Response(), data: { data: { ...session, revision: 6, capacity: 7, status: 'cancelled' } } } as Awaited<ReturnType<typeof api.POST>>);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    await waitFor(() => expect(Math.max(...changes)).toBe(2));
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
  it('asks before discarding class editor edits through Close and keeps them when staying', () => {
    const onClose = vi.fn();
    render(<ClassEditor options={options} tags={[]} onSaved={vi.fn()} onClose={onClose}/>);
    const dialog = screen.getByRole('dialog'), form = within(dialog);
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Changed class' } });
    fireEvent.click(form.getByRole('button', { name: 'Close' }));
    expect(form.getByText('Discard your unsaved changes?')).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(form.getByRole('button', { name: 'Keep editing' }));
    expect((form.getByLabelText('Name') as HTMLInputElement).value).toBe('Changed class');
    expect(screen.getByRole('dialog')).toBe(dialog);
  });
  it('closes an unedited class editor at once through Close', () => {
    const onClose = vi.fn();
    render(<ClassEditor options={options} tags={[]} onSaved={vi.fn()} onClose={onClose}/>);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText('Discard your unsaved changes?')).toBeNull();
  });
  it('opens the edit form from session detail for schedule managers only', () => {
    const { rerender } = render(<SessionDetail session={session} options={options} roles={['front_desk']} enabledModules={[]} onSaved={vi.fn()}/>);
    expect(screen.queryByRole('button', { name: 'Edit or move session' })).toBeNull();
    rerender(<SessionDetail session={session} options={options} roles={['owner']} enabledModules={[]} onSaved={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit or move session' }));
    expect(screen.getByRole('form', { name: 'Edit or move session' })).toBeDefined();
  });
});
describe('weekly class capacity and the coach hint', () => {
  const template: ClassTemplate = { id, name: 'Evening class', weekday: 1, localStartTime: '18:00', durationMinutes: 60, coachId: null, capacity: null,
    notes: null, kind: 'class', revision: 3, createdAt: '2026-03-01T00:00:00Z', programIds: [programId], tagIds: [] };
  const capacityHelp = 'Changing it also updates upcoming sessions of this class that still have its old capacity. Sessions with their own capacity keep it. A cancelled date with more members booked than a lowered capacity keeps its own capacity.';
  const coachesHelpPending = 'Coaches come from staff profiles.';
  const coachesHelp = 'Coaches come from staff profiles. Add one in Staff → Staff profiles, and link it to a login to coach from your own account.';
  const coachesHelpAsk = 'Coaches come from staff profiles. Ask an owner or admin to add one.';
  it('explains on an existing weekly class only that a capacity change reaches its upcoming sessions', () => {
    render(<ClassEditor template={template} options={options} tags={[]} onSaved={vi.fn()} onClose={vi.fn()}/>);
    const help = screen.getByText(capacityHelp);
    expect(screen.getByLabelText('Capacity').getAttribute('aria-describedby')).toBe(help.id);
    cleanup(); render(<ClassEditor options={options} tags={[]} onSaved={vi.fn()} onClose={vi.fn()}/>);
    expect(screen.queryByText(capacityHelp)).toBeNull();
    expect(screen.getByLabelText('Capacity').hasAttribute('aria-describedby')).toBe(false);
    cleanup(); render(<ClassEditor standalone options={options} tags={[]} onSaved={vi.fn()} onClose={vi.fn()}/>);
    expect(screen.queryByText(capacityHelp)).toBeNull();
  });
  it('explains a template capacity below a session\'s booked count and keeps the dialog open', async () => {
    const onClose = vi.fn(), onSaved = vi.fn();
    vi.mocked(api.PUT).mockResolvedValue({ response: new Response(null, { status: 409 }),
      error: { error: { code: 'conflict', message: 'Below booked', details: { reason: ['capacityBelowBooked'] } } } } as Awaited<ReturnType<typeof api.PUT>>);
    render(<ClassEditor template={template} options={options} tags={[]} onSaved={onSaved} onClose={onClose}/>);
    fireEvent.change(screen.getByLabelText('Capacity'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('An upcoming session of this class has more booked members than that capacity. Choose a higher capacity, or change that session on its own.');
    expect(api.PUT).toHaveBeenCalledWith('/api/schedule/templates/{id}', expect.objectContaining({ body: expect.objectContaining({ capacity: 3, revision: 3 }) }));
    expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect((screen.getByLabelText('Capacity') as HTMLInputElement).value).toBe('3');
  });
  it('names the blocking session in the gym timezone when the 409 includes startsAt', async () => {
    const onClose = vi.fn(), onSaved = vi.fn();
    vi.mocked(api.PUT).mockResolvedValue({ response: new Response(null, { status: 409 }),
      error: { error: { code: 'conflict', message: 'Below booked', details: { reason: ['capacityBelowBooked'], startsAt: ['2026-03-06T23:30:00.000Z'] } } } } as Awaited<ReturnType<typeof api.PUT>>);
    render(<ClassEditor template={template} options={options} tags={[]} onSaved={onSaved} onClose={onClose}/>);
    fireEvent.change(screen.getByLabelText('Capacity'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The session on Mar 6, 2026, 6:30 PM has more booked members than that capacity. Choose a higher capacity, or change that session on its own.');
    expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeDefined();
  });
  it('keeps the general conflict message for any other refused template save', async () => {
    vi.mocked(api.PUT).mockResolvedValue({ response: new Response(null, { status: 409 }),
      error: { error: { code: 'conflict', message: 'Changed', details: { reason: ['revision_conflict'] } } } } as Awaited<ReturnType<typeof api.PUT>>);
    render(<ClassEditor template={template} options={options} tags={[]} onSaved={vi.fn()} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).not.toMatch(/booked members/);
  });
  const coachSelects: [string, (coaches: ScheduleOptions['coaches'], roles: StaffRole[]) => ReactElement][] = [
    ['weekly class editor', coaches => <ClassEditor template={template} options={{ ...options, coaches }} tags={[]} onSaved={vi.fn()} onClose={vi.fn()}/>],
    ['session coach swap', (coaches, roles) => <SessionDetail session={session} options={{ ...options, coaches }} roles={roles} enabledModules={[]} onSaved={vi.fn()}/>],
    ['session edit form', coaches => <SessionForm session={session} options={{ ...options, coaches }} tags={[]} siblings={[]} onSaved={vi.fn()} onCancel={vi.fn()}/>],
  ];
  it.each(coachSelects)('explains where coaches come from under the %s, with a Staff link for owners and admins', (_name, view) => {
    vi.mocked(useBootstrap).mockReturnValue({ data: undefined, isPending: true } as ReturnType<typeof useBootstrap>);
    render(view([], ['owner']));
    const pendingHint = screen.getByText(coachesHelpPending);
    expect(screen.getAllByLabelText('Coach').find(element => element.tagName === 'SELECT')!.getAttribute('aria-describedby')).toBe(pendingHint.parentElement!.id);
    expect(screen.queryByRole('link', { name: 'Open Staff' })).toBeNull();
    expect(screen.queryByText(coachesHelp)).toBeNull();
    expect(screen.queryByText(coachesHelpAsk)).toBeNull();
    cleanup();
    vi.mocked(useBootstrap).mockReturnValue({ data: undefined, isPending: false, isError: true } as ReturnType<typeof useBootstrap>);
    render(view([], ['owner']));
    const failedHint = screen.getByText(coachesHelpPending);
    expect(screen.getAllByLabelText('Coach').find(element => element.tagName === 'SELECT')!.getAttribute('aria-describedby')).toBe(failedHint.parentElement!.id);
    expect(screen.queryByText(coachesHelpAsk)).toBeNull();
    expect(screen.queryByText(coachesHelp)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open Staff' })).toBeNull();
    cleanup();
    for (const role of ['owner', 'admin'] as const) {
      bootstrap([role]); render(view([], [role]));
      const hint = screen.getByText(coachesHelp);
      const select = screen.getAllByLabelText('Coach').find(element => element.tagName === 'SELECT')!;
      expect(select.getAttribute('aria-describedby')).toBe(hint.parentElement!.id);
      const link = screen.getByRole('link', { name: 'Open Staff' });
      expect(link.getAttribute('href')).toBe('/admin/staff');
      // A new tab keeps the open form's unsaved input.
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.className).toMatch(/min-h-11/);
      cleanup();
    }
    bootstrap(['coach']); render(view([], ['coach']));
    expect(screen.getByText(coachesHelpAsk)).toBeDefined();
    expect(screen.queryByText(coachesHelp)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open Staff' })).toBeNull();
    cleanup(); bootstrap(['owner']); render(view([{ id: programId, name: 'A coach' }], ['owner']));
    expect(screen.queryByText(coachesHelpPending)).toBeNull();
    expect(screen.queryByText(coachesHelp)).toBeNull();
    expect(screen.queryByText(coachesHelpAsk)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open Staff' })).toBeNull();
    expect(screen.getAllByLabelText('Coach').find(element => element.tagName === 'SELECT')!.hasAttribute('aria-describedby')).toBe(false);
  });
});
