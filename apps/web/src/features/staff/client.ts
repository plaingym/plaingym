// SPDX-License-Identifier: AGPL-3.0-only
import { createApiClient } from '../../lib/api.js';
import { staffProfileListResponseSchema, staffProfileResponseSchema, staffRoleListResponseSchema, inviteStaffResponseSchema,
  createStaffProfileRequestSchema, updateStaffProfileRequestSchema, inviteStaffRequestSchema, grantStaffRoleRequestSchema,
  type CreateStaffProfileRequest, type UpdateStaffProfileRequest, type InviteStaffRequest, type AssignableStaffRole } from '@plaingym/shared/contracts';
export class StaffRequestError extends Error {
  constructor(readonly status: number) { super('Staff request failed'); }
}
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
export function createStaffClient(fetcher: typeof fetch = fetch) {
  const api = createApiClient({ fetch: fetcher, credentials: 'same-origin' });
  function check<T>(result: { response: Response; data?: T }) {
    if (!result.response.ok) throw new StaffRequestError(result.response.status);
    return result.data;
  }
  return {
    async uploadPhoto(id: string, revision: number, photo: File) {
      let binary = '';
      for (const byte of new Uint8Array(await photo.arrayBuffer())) binary += String.fromCharCode(byte);
      return staffProfileResponseSchema.parse(check(await api.POST('/api/staff/profiles/{staffProfileId}/photo', {
        params: { path: { staffProfileId: id } }, body: { revision, contentType: photo.type as 'image/jpeg' | 'image/png' | 'image/webp', base64: btoa(binary) },
      }))).data;
    },
    async profiles(offset: number, search: string) { return staffProfileListResponseSchema.parse(check(await api.GET('/api/staff/profiles', { params: { query: { limit: 25, offset, ...(search ? { search } : {}) } } }))); },
    async roles(offset: number) { return staffRoleListResponseSchema.parse(check(await api.GET('/api/staff/roles', { params: { query: { limit: 25, offset } } }))); },
    async createProfile(input: CreateStaffProfileRequest) { return staffProfileResponseSchema.parse(check(await api.POST('/api/staff/profiles', { body: defined(createStaffProfileRequestSchema.parse(input)) }))).data; },
    async updateProfile(id: string, input: UpdateStaffProfileRequest) { return staffProfileResponseSchema.parse(check(await api.PATCH('/api/staff/profiles/{staffProfileId}', { params: { path: { staffProfileId: id } }, body: defined(updateStaffProfileRequestSchema.parse(input)) }))).data; },
    async invite(input: InviteStaffRequest) { return inviteStaffResponseSchema.parse(check(await api.POST('/api/staff/invitations', { body: inviteStaffRequestSchema.parse(input) }))).data; },
    async grantRole(userId: string, role: AssignableStaffRole) { check(await api.POST('/api/staff/roles', { body: grantStaffRoleRequestSchema.parse({ userId, role }) })); },
    async changeRole(id: string, role: AssignableStaffRole, revision: number) { check(await api.PATCH('/api/staff/roles/{staffRoleId}', { params: { path: { staffRoleId: id } }, body: { role, revision } })); },
    async revokeRole(id: string, revision: number) { check(await api.DELETE('/api/staff/roles/{staffRoleId}', { params: { path: { staffRoleId: id } }, body: { revision } })); },
    async resetPassword(userId: string, newPassword: string) { check(await api.POST('/api/staff/users/{userId}/reset-password', { params: { path: { userId } }, body: { newPassword } })); },
  };
}
export type StaffClient = ReturnType<typeof createStaffClient>;
