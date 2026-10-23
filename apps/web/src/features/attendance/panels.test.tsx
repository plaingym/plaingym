// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttendanceRosterPanel, MemberAttendancePanel } from './panels.js';
import { registration } from './registrations.js';
const client = vi.hoisted(() => ({ members: vi.fn(), checkedIn: vi.fn(), record: vi.fn(), totals: vi.fn(), labels: vi.fn() }));
vi.mock('./client.js', () => ({ attendanceClient: client }));
const memberId = '00000000-0000-7000-8000-000000000001';
const sessionId = '00000000-0000-7000-8000-000000000002';
const programId = '00000000-0000-7000-8000-000000000003';
const tagId = '00000000-0000-7000-8000-000000000004';
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.members.mockResolvedValue({ data: [{ id: memberId, firstName: 'River', lastName: 'Lee' }], total: 1 });
  client.checkedIn.mockResolvedValue([]);
  client.record.mockResolvedValue({ id: 'visit', memberId });
  client.totals.mockResolvedValue({ memberId, total: 3, classes: 2, openMat: 1, byProgram: [{ programId, count: 3 }], byTag: [{ tagId, count: 2 }] });
  client.labels.mockResolvedValue({ programs: [{ id: programId, name: 'Fundamentals', active: true }], tags: [{ id: tagId, name: 'Practice' }] });
});
afterEach(cleanup);
describe('registered attendance panels', () => {
  it('enables the staff member tab and session panel, and safely ignores missing extension IDs', () => {
    expect(registration.memberTabs?.[0]).toMatchObject({ enabled: true, component: MemberAttendancePanel,
      permission: { kind: 'staff', capability: 'attendance.manage' } });
    expect(registration.sessionPanels?.[0]).toMatchObject({ enabled: true, component: AttendanceRosterPanel });
    const view = render(<><MemberAttendancePanel/><AttendanceRosterPanel/></>);
    expect(view.container.textContent).toBe(''); expect(client.members).not.toHaveBeenCalled();
  });
  it('checks in a member once and displays previously checked-in members without another submission', async () => {
    const user = userEvent.setup(), view = render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await user.click(await screen.findByRole('button', { name: 'Check in River Lee' }));
    const checked = await screen.findByRole('button', { name: 'River Lee is checked in' });
    expect((checked as HTMLButtonElement).disabled).toBe(true);
    await user.click(checked);
    expect(client.record).toHaveBeenCalledTimes(1);
    expect(client.record).toHaveBeenCalledWith({ memberId, sessionId, programId: null });
    view.unmount(); client.checkedIn.mockResolvedValue([{ memberId }]);
    render(<AttendanceRosterPanel sessionId={sessionId}/>);
    expect((await screen.findByRole('button', { name: 'River Lee is checked in' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('searches and paginates the roster without dropping the session scope', async () => {
    client.members.mockResolvedValue({ data: [{ id: memberId, firstName: 'River', lastName: 'Lee' }], total: 51 });
    const user = userEvent.setup(); render(<AttendanceRosterPanel sessionId={sessionId}/>);
    await screen.findByText('River Lee');
    await user.type(screen.getByLabelText('Member name'), 'River');
    await user.click(screen.getByRole('button', { name: 'Search members' }));
    await waitFor(() => expect(client.members).toHaveBeenLastCalledWith('River', 0));
    await screen.findByText('River Lee');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(client.members).toHaveBeenLastCalledWith('River', 50));
    expect(client.checkedIn).toHaveBeenLastCalledWith(sessionId);
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
  it('renders program/tag totals and records an open-mat visit without a session', async () => {
    const user = userEvent.setup(); render(<MemberAttendancePanel memberId={memberId}/>);
    await screen.findByText('Total visits: 3');
    expect(screen.getByRole('rowheader', { name: 'Fundamentals' })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: 'Practice' })).toBeDefined();
    await user.selectOptions(screen.getByLabelText('Program'), programId);
    await user.click(screen.getByRole('button', { name: 'Record open-mat visit' }));
    await screen.findByText('Open-mat visit recorded.');
    expect(client.record).toHaveBeenCalledWith({ memberId, sessionId: null, programId });
    await waitFor(() => expect(client.totals).toHaveBeenCalledTimes(2));
  });
  it('can record unclassified open mat, and clears prior member/session state when extension IDs change', async () => {
    const user = userEvent.setup(), view = render(<MemberAttendancePanel memberId={memberId}/>);
    await screen.findByText('Total visits: 3');
    await user.click(screen.getByRole('button', { name: 'Record open-mat visit' }));
    await screen.findByText('Open-mat visit recorded.');
    expect(client.record).toHaveBeenCalledWith({ memberId, sessionId: null, programId: null });
    client.totals.mockReturnValue(new Promise(() => undefined));
    view.rerender(<MemberAttendancePanel memberId="another-member"/>);
    expect(screen.queryByText('Total visits: 3')).toBeNull();
    expect(screen.queryByText('Open-mat visit recorded.')).toBeNull();
  });
});
