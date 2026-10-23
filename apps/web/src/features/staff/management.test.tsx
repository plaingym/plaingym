// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StaffProfile } from '@plaingym/shared/contracts';
import { StaffManagement } from './management.js';
import { StaffRequestError, type StaffClient } from './client.js';
import { resizeStaffPhoto } from './photo.js';
vi.mock('./photo.js', () => ({ resizeStaffPhoto: vi.fn() }));

const profile: StaffProfile = { id: '01900000-0000-7000-8000-000000000001', userId: '01900000-0000-7000-8000-000000000002', memberId: null, displayName: 'Alex Coach', bio: 'Coach bio', rank: 'Level 2', photoKey: null, isPublic: false, revision: 7, createdAt: '2026-10-22T12:00:00Z' };
function services(): StaffClient {
  return { profiles: vi.fn().mockResolvedValue({ data: [profile], pagination: { limit: 25, offset: 0, total: 1 } }),
    roles: vi.fn().mockResolvedValue({ data: [{ id: 'coach-role', userId: profile.userId, role: 'coach', revision: 2, createdAt: profile.createdAt }, { id: 'owner-role', userId: 'owner', role: 'owner', revision: 1, createdAt: profile.createdAt }], pagination: { limit: 25, offset: 0, total: 2 } }),
    createProfile: vi.fn().mockResolvedValue(profile), updateProfile: vi.fn().mockResolvedValue(profile),
    invite: vi.fn().mockResolvedValue({ delivery: 'print', staffRole: { id: 'new-role', userId: 'new-user', role: 'coach', revision: 1, createdAt: profile.createdAt }, invitationUrl: 'https://gym.example.test/staff-invitation#private-token' }),
    grantRole: vi.fn().mockResolvedValue(undefined), changeRole: vi.fn().mockResolvedValue(undefined), revokeRole: vi.fn().mockResolvedValue(undefined), resetPassword: vi.fn().mockResolvedValue(undefined), uploadPhoto: vi.fn().mockResolvedValue(profile) };
}
afterEach(cleanup);
it('denies coaches without fetching staff data', () => {
  const service = services(); render(<StaffManagement roles={['coach']} passwordEnabled services={service}/>);
  expect(screen.getByRole('alert').textContent).toContain('Only owners and admins'); expect(service.profiles).not.toHaveBeenCalled();
});
it('shows and dismisses a printed invitation without persisting it', async () => {
  const service = services(), user = userEvent.setup(); render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit' }); await user.type(screen.getByLabelText('Email address'), 'coach@example.test');
  await user.click(screen.getByRole('button', { name: 'Invite staff' }));
  const field = await screen.findByLabelText('Invitation link') as HTMLInputElement;
  expect(field.value).toBe('https://gym.example.test/staff-invitation#private-token');
  expect(service.invite).toHaveBeenCalledWith({ email: 'coach@example.test', role: 'coach', delivery: 'print' });
  await user.click(screen.getByRole('button', { name: 'Dismiss link' })); expect(screen.queryByLabelText('Invitation link')).toBeNull();
});
it('submits the profile revision and keeps a stale edit for review with a conflict message', async () => {
  const service = services(), user = userEvent.setup(); vi.mocked(service.updateProfile).mockRejectedValue(new StaffRequestError(409));
  render(<StaffManagement roles={['admin']} passwordEnabled services={service}/>); await screen.findByRole('button', { name: 'Edit' });
  await user.click(screen.getByRole('button', { name: 'Edit' })); const name = screen.getByLabelText('Display name');
  await user.clear(name); await user.type(name, 'Alex Updated'); await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('This record changed. Reload staff before saving again.');
  expect(service.updateProfile).toHaveBeenCalledWith(profile.id, expect.objectContaining({ revision: 7, displayName: 'Alex Updated', bio: 'Coach bio' }));
  expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Alex Updated');
});
it('requires confirmation before revocation and sends its revision', async () => {
  const service = services(), user = userEvent.setup(); render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit' }); await user.click(screen.getByRole('button', { name: 'Revoke access' }));
  expect(service.revokeRole).not.toHaveBeenCalled(); await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
  await waitFor(() => expect(service.revokeRole).toHaveBeenCalledWith('coach-role', 2));
});
it('uses the existing password reset endpoint and clears password input after failure', async () => {
  const service = services(), user = userEvent.setup(); vi.mocked(service.resetPassword).mockRejectedValue(new Error('private database details'));
  render(<StaffManagement roles={['admin']} passwordEnabled services={service}/>); await screen.findByRole('button', { name: 'Edit' });
  expect(screen.getAllByRole('button', { name: 'Reset password' })).toHaveLength(1);
  const password = screen.getByLabelText('New password'); await user.type(password, 'new-safe-password'); await user.click(screen.getByRole('button', { name: 'Reset password' }));
  await screen.findByText(/Unable to save or load staff/); expect((password as HTMLInputElement).value).toBe('');
  expect(service.resetPassword).toHaveBeenCalledWith(profile.userId, 'new-safe-password'); expect(document.body.textContent).not.toContain('private database details');
});
it('hides password resets when password login is disabled', async () => {
  render(<StaffManagement roles={['owner']} passwordEnabled={false} services={services()}/>); await screen.findByRole('button', { name: 'Edit' });
  expect(screen.queryByLabelText('New password')).toBeNull();
});
it('saves a profile before uploading its resized photo and retains the saved identity after upload failure', async () => {
  const service = services(), user = userEvent.setup(), photo = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
  vi.mocked(resizeStaffPhoto).mockResolvedValue(photo);
  vi.mocked(service.uploadPhoto).mockRejectedValueOnce(new StaffRequestError(503));
  render(<StaffManagement roles={['owner']} passwordEnabled services={service}/>);
  await screen.findByRole('button', { name: 'Edit' }); await user.click(screen.getByRole('button', { name: 'Add profile' }));
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
  await screen.findByRole('button', { name: 'Edit' }); await user.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('img').getAttribute('src')).toBe(`/api/staff/profiles/${profile.id}/photo`);
  await user.click(screen.getByLabelText('Remove photo')); await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await waitFor(() => expect(service.updateProfile).toHaveBeenCalledWith(profile.id, expect.objectContaining({ revision: 7, photoKey: null })));
});
