// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StaffProfile } from '@plaingym/shared/contracts';
import { StaffManagement } from './management.js';
import { StaffRequestError, type StaffClient } from './client.js';
import { resizeStaffPhoto } from './photo.js';
vi.mock('./photo.js', () => ({ resizeStaffPhoto: vi.fn() }));

const profile: StaffProfile = { id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000002', memberId: null, displayName: 'Alex Coach', bio: 'Coach bio', rank: 'Level 2', photoKey: null, isPublic: false, revision: 7, createdAt: '2026-10-22T12:00:00Z' };
function services(): StaffClient {
  return { profiles: vi.fn().mockResolvedValue({ data: [profile], pagination: { limit: 25, offset: 0, total: 1 } }),
    people: vi.fn().mockResolvedValue({ data: [{ id: profile.userId!, displayName: 'Alex Coach', email: 'alex@example.test' }], total: 1 }),
    person: vi.fn().mockResolvedValue({ id: profile.userId!, displayName: 'Alex Coach', email: 'alex@example.test' }),
    roles: vi.fn().mockResolvedValue({ data: [{ id: 'coach-role', userId: profile.userId, displayName: 'Alex Coach', role: 'coach', revision: 2, createdAt: profile.createdAt }, { id: 'owner-role', userId: 'owner', displayName: 'Morgan Owner', role: 'owner', revision: 1, createdAt: profile.createdAt }], pagination: { limit: 25, offset: 0, total: 2 } }),
    createProfile: vi.fn().mockResolvedValue(profile), updateProfile: vi.fn().mockResolvedValue(profile),
    invite: vi.fn().mockResolvedValue({ delivery: 'print', staffRole: { id: 'new-role', userId: 'new-user', role: 'coach', revision: 1, createdAt: profile.createdAt }, invitationUrl: 'https://gym.example.test/staff-invitation#private-token' }),
    grantRole: vi.fn().mockResolvedValue(undefined), changeRole: vi.fn().mockResolvedValue(undefined), revokeRole: vi.fn().mockResolvedValue(undefined), resetPassword: vi.fn().mockResolvedValue(undefined), uploadPhoto: vi.fn().mockResolvedValue(profile) };
}
afterEach(cleanup);
it('names the owner independently of profile search and grants access by an explicit person selection at 360 px', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
  const service = services(), user = userEvent.setup();
  render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByText('Morgan Owner');
  expect(document.body.textContent).not.toContain(profile.userId);
  const grant = screen.getByRole('button', { name: 'Grant role' });
  expect((grant as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText('Find an account by name or email'), 'Alex Coach');
  await user.click(await screen.findByRole('button', { name: 'Alex Coach alex@example.test' }));
  await user.type(screen.getByLabelText('Find an account by name or email'), '{Enter}');
  expect(service.grantRole).not.toHaveBeenCalled();
  await user.click(grant);
  await waitFor(() => expect(service.grantRole).toHaveBeenCalledWith(profile.userId, 'coach'));
  expect(service.people).toHaveBeenCalledWith('account', 'Alex Coach', 0);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Grant role' }) as HTMLButtonElement).disabled).toBe(true));
  expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();
});
it('labels a profile link that no longer resolves instead of a placeholder', async () => {
  const service = services(), user = userEvent.setup();
  vi.mocked(service.person).mockResolvedValue(null);
  render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await user.click(await screen.findByRole('button', { name: 'Edit Alex Coach' }));
  expect(await within(screen.getByRole('dialog')).findByText(/Linked person unavailable/)).toBeDefined();
});
it('searches profile links by person and preserves an existing link until explicitly cleared', async () => {
  const service = services(), user = userEvent.setup();
  render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await user.click(await screen.findByRole('button', { name: 'Edit Alex Coach' }));
  const dialog = within(screen.getByRole('dialog'));
  await dialog.findByRole('button', { name: 'Clear selection' });
  await user.type(dialog.getByLabelText('Find a member to link (optional)'), 'Casey Phone');
  await waitFor(() => expect(service.people).toHaveBeenCalledWith('member', 'Casey Phone', 0));
  await user.click(dialog.getByRole('button', { name: 'Save profile' }));
  await waitFor(() => expect(service.updateProfile).toHaveBeenCalledWith(profile.id, expect.objectContaining({ userId: profile.userId, memberId: null })));
  await user.click(await screen.findByRole('button', { name: 'Edit Alex Coach' }));
  await user.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Clear selection' }));
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await waitFor(() => expect(service.updateProfile).toHaveBeenLastCalledWith(profile.id, expect.objectContaining({ userId: null })));
});
it('denies coaches without fetching staff data', () => {
  const service = services(); render(<StaffManagement roles={['coach']} passwordEnabled services={service}/>);
  expect(screen.getByRole('alert').textContent).toContain('Only owners and admins'); expect(service.profiles).not.toHaveBeenCalled();
});
it('shows and dismisses a printed invitation without persisting it', async () => {
  const service = services(), user = userEvent.setup(); render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit Alex Coach' }); await user.type(screen.getByLabelText('Email address'), 'coach@example.test');
  await user.click(screen.getByRole('button', { name: 'Invite staff' }));
  const field = await screen.findByLabelText('Invitation link') as HTMLInputElement;
  expect(field.value).toBe('https://gym.example.test/staff-invitation#private-token');
  expect(service.invite).toHaveBeenCalledWith({ email: 'coach@example.test', role: 'coach', delivery: 'print' });
  await user.click(screen.getByRole('button', { name: 'Dismiss link' })); expect(screen.queryByLabelText('Invitation link')).toBeNull();
});
it('keeps the send generation while retrying an emailed invitation and picks a new one to resend it', async () => {
  const service = services(), user = userEvent.setup(), staffRole = { id: 'new-role', userId: 'new-user', role: 'coach' as const, revision: 1, createdAt: profile.createdAt };
  vi.mocked(service.invite).mockRejectedValueOnce(new Error('Network')).mockResolvedValue({ delivery: 'email', staffRole });
  render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit Alex Coach' }); await user.type(screen.getByLabelText('Email address'), 'coach@example.test');
  await user.selectOptions(screen.getByLabelText('Delivery'), 'email');
  const generations = () => vi.mocked(service.invite).mock.calls.map(([input]) => input.delivery === 'email' ? input.sendGeneration : null);
  await user.click(screen.getByRole('button', { name: 'Invite staff' }));
  await waitFor(() => expect(generations()).toHaveLength(1));
  await user.click(await screen.findByRole('button', { name: 'Invite staff' }));
  await waitFor(() => expect(generations()).toHaveLength(2));
  expect(generations()[1]).toBe(generations()[0]);
  await user.selectOptions(screen.getByLabelText('Delivery'), 'email');
  await user.clear(screen.getByLabelText('Email address')); await user.type(screen.getByLabelText('Email address'), 'coach@example.test');
  await user.click(await screen.findByRole('button', { name: 'Invite staff' }));
  await waitFor(() => expect(generations()).toHaveLength(3));
  expect(generations()[2]).not.toBe(generations()[1]);
});
it('submits the profile revision and keeps a stale edit for review with a conflict message', async () => {
  const service = services(), user = userEvent.setup(); vi.mocked(service.updateProfile).mockRejectedValue(new StaffRequestError(409));
  render(<StaffManagement roles={['admin']} passwordEnabled services={service}/>); await screen.findByRole('button', { name: 'Edit Alex Coach' });
  await user.click(screen.getByRole('button', { name: 'Edit Alex Coach' })); const name = screen.getByLabelText('Display name');
  await user.clear(name); await user.type(name, 'Alex Updated'); await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('This record changed. Reload staff before saving again.');
  expect(service.updateProfile).toHaveBeenCalledWith(profile.id, expect.objectContaining({ revision: 7, displayName: 'Alex Updated', bio: 'Coach bio' }));
  expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Alex Updated');
});
it('requires confirmation before revocation and sends its revision', async () => {
  const service = services(), user = userEvent.setup(); render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit Alex Coach' }); await user.click(screen.getByRole('button', { name: 'Revoke access' }));
  expect(service.revokeRole).not.toHaveBeenCalled(); await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
  await waitFor(() => expect(service.revokeRole).toHaveBeenCalledWith('coach-role', 2));
});
it('uses the existing password reset endpoint and clears password input after failure', async () => {
  const service = services(), user = userEvent.setup(); vi.mocked(service.resetPassword).mockRejectedValue(new Error('private database details'));
  render(<StaffManagement roles={['admin']} passwordEnabled services={service}/>); await screen.findByRole('button', { name: 'Edit Alex Coach' });
  expect(screen.getAllByRole('button', { name: 'Reset password' })).toHaveLength(1);
  const password = screen.getByLabelText('New password'); await user.type(password, 'new-safe-password'); await user.click(screen.getByRole('button', { name: 'Reset password' }));
  await screen.findByText(/Unable to save or load staff/); expect((password as HTMLInputElement).value).toBe('');
  expect(service.resetPassword).toHaveBeenCalledWith(profile.userId, 'new-safe-password'); expect(document.body.textContent).not.toContain('private database details');
});
it('hides password resets when password login is disabled', async () => {
  render(<StaffManagement roles={['owner']} passwordEnabled={false} services={services()}/>); await screen.findByRole('button', { name: 'Edit Alex Coach' });
  expect(screen.queryByLabelText('New password')).toBeNull();
});
it('saves a profile before uploading its resized photo and retains the saved identity after upload failure', async () => {
  const service = services(), user = userEvent.setup(), photo = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
  vi.mocked(resizeStaffPhoto).mockResolvedValue(photo);
  vi.mocked(service.uploadPhoto).mockRejectedValueOnce(new StaffRequestError(503));
  render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit Alex Coach' }); await user.click(screen.getByRole('button', { name: 'Add profile' }));
  await user.type(screen.getByLabelText('Display name'), 'New coach');
  await user.upload(screen.getByLabelText('Profile photo'), photo);
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText(/Unable to save or load staff/);
  expect(service.createProfile).toHaveBeenCalledOnce();
  expect(vi.mocked(service.createProfile).mock.calls[0]![0]).not.toHaveProperty('photoKey');
  expect(service.uploadPhoto).toHaveBeenCalledWith(profile.id, profile.revision, photo);
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('Staff changes saved.');
  expect(service.createProfile).toHaveBeenCalledOnce();
  expect(service.updateProfile).toHaveBeenCalledWith(profile.id, expect.objectContaining({ revision: profile.revision }));
});
it('previews by profile ID and clears photos through a revisioned profile update', async () => {
  const service = services(), user = userEvent.setup();
  vi.mocked(service.profiles).mockResolvedValue({ data: [{ ...profile, photoKey: 'private/storage/key' }], pagination: { limit: 25, offset: 0, total: 1 } });
  render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit Alex Coach' }); await user.click(screen.getByRole('button', { name: 'Edit Alex Coach' }));
  expect(screen.getByRole('img').getAttribute('src')).toBe(`/api/staff/profiles/${profile.id}/photo`);
  await user.click(screen.getByLabelText('Remove photo')); await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await waitFor(() => expect(service.updateProfile).toHaveBeenCalledWith(profile.id, expect.objectContaining({ revision: 7, photoKey: null })));
});

it('reuses a lost invitation after remount and offers a deliberate resend when its outcome is uncertain', async () => {
  sessionStorage.clear();
  const service = services(), user = userEvent.setup(), staffRole = { id: 'new-role', userId: 'new-user', role: 'coach' as const, revision: 1, createdAt: profile.createdAt };
  vi.mocked(service.invite).mockRejectedValueOnce(new Error('Reply lost'))
    .mockResolvedValueOnce({ delivery: 'email', staffRole, outcome: 'unknown' }).mockResolvedValue({ delivery: 'email', staffRole });
  let view = render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  const fill = async () => {
    await screen.findByRole('button', { name: 'Edit Alex Coach' });
    await user.type(screen.getByLabelText('Email address'), 'reload@example.test');
    await user.selectOptions(screen.getByLabelText('Delivery'), 'email');
    await user.click(screen.getByRole('button', { name: 'Invite staff' }));
  };
  await fill(); await screen.findByText(/Unable to save or load staff/);
  view.unmount(); view = render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await fill();
  expect((await screen.findByRole('alert')).textContent).toContain('may have been delivered');
  const generations = () => vi.mocked(service.invite).mock.calls.map(([input]) => input.delivery === 'email' ? input.sendGeneration : null);
  expect(generations()[1]).toBe(generations()[0]);
  await user.click(screen.getByRole('button', { name: 'Send again' }));
  await waitFor(() => expect(generations()).toHaveLength(3));
  expect(generations()[2]).not.toBe(generations()[1]);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  view.unmount(); sessionStorage.clear();
});

it('shows a later failure after an uncertain invitation', async () => {
  sessionStorage.clear();
  const service = services(), user = userEvent.setup(), staffRole = { id: 'new-role', userId: 'new-user', role: 'coach' as const, revision: 1, createdAt: profile.createdAt };
  vi.mocked(service.invite).mockResolvedValue({ delivery: 'email', staffRole, outcome: 'unknown' });
  const view = render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit Alex Coach' });
  await user.type(screen.getByLabelText('Email address'), 'later@example.test');
  await user.selectOptions(screen.getByLabelText('Delivery'), 'email');
  await user.click(screen.getByRole('button', { name: 'Invite staff' }));
  expect((await screen.findByRole('alert')).textContent).toContain('may have been delivered');
  vi.mocked(service.profiles).mockRejectedValueOnce(new Error('Down'));
  await user.click(screen.getByRole('button', { name: 'Reload staff' }));
  await screen.findByText(/Unable to save or load staff/);
  expect(screen.queryByText(/may have been delivered/)).toBeNull();
  view.unmount(); sessionStorage.clear();
});
