// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { createApiClient } from '../../lib/api.js';
import { staffProfileListResponseSchema, staffProfileResponseSchema, staffRoleListResponseSchema, inviteStaffResponseSchema,
  createStaffProfileRequestSchema, updateStaffProfileRequestSchema, inviteStaffRequestSchema, grantStaffRoleRequestSchema,
  staffAccountListResponseSchema, memberListResponseSchema, memberResponseSchema,
  type CreateStaffProfileRequest, type UpdateStaffProfileRequest, type InviteStaffRequest, type AssignableStaffRole } from '@plaingym/shared/contracts';
export class StaffRequestError extends Error {
  constructor(readonly status: number) { super('Staff request failed'); }
}
export type PersonKind = 'member' | 'account' | 'staff';
export interface PersonOption { id: string; displayName: string; email: string | null }
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
    async people(kind: PersonKind, search: string, offset: number): Promise<{ data: PersonOption[]; total: number }> {
      if (kind === 'member') {
        const page = parseResponse(memberListResponseSchema, check(await api.GET('/api/members', { params: { query: { limit: 25, offset, ...(search ? { search } : {}) } } })));
        return { data: page.data.map(row => ({ id: row.id, displayName: `${row.firstName} ${row.lastName}`, email: row.email })), total: page.pagination.total };
      }
      const page = parseResponse(staffAccountListResponseSchema, check(await api.GET('/api/staff/accounts', { params: { query: { limit: 25, offset, staffOnly: kind === 'staff' ? 'true' : 'false', ...(search ? { search } : {}) } } })));
      return { data: page.data, total: page.pagination.total };
    },
    async person(kind: PersonKind, id: string): Promise<PersonOption | null> {
      if (kind === 'member') {
        const { data } = parseResponse(memberResponseSchema, check(await api.GET('/api/members/{memberId}', { params: { path: { memberId: id } } })));
        return { id: data.id, displayName: `${data.firstName} ${data.lastName}`, email: data.email };
      }
      const page = parseResponse(staffAccountListResponseSchema, check(await api.GET('/api/staff/accounts', { params: { query: { userId: id, limit: 1, offset: 0, staffOnly: kind === 'staff' ? 'true' : 'false' } } })));
      return page.data[0] ?? null;
    },
    async uploadPhoto(id: string, revision: number, photo: File) {
      let binary = '';
      for (const byte of new Uint8Array(await photo.arrayBuffer())) binary += String.fromCharCode(byte);
      return parseResponse(staffProfileResponseSchema, check(await api.POST('/api/staff/profiles/{staffProfileId}/photo', {
        params: { path: { staffProfileId: id } }, body: { revision, contentType: photo.type as 'image/jpeg' | 'image/png' | 'image/webp', base64: btoa(binary) },
      }))).data;
    },
    async profiles(offset: number, search: string) { return parseResponse(staffProfileListResponseSchema, check(await api.GET('/api/staff/profiles', { params: { query: { limit: 25, offset, ...(search ? { search } : {}) } } }))); },
    async roles(offset: number) { return parseResponse(staffRoleListResponseSchema, check(await api.GET('/api/staff/roles', { params: { query: { limit: 25, offset } } }))); },
    async createProfile(input: CreateStaffProfileRequest) { return parseResponse(staffProfileResponseSchema, check(await api.POST('/api/staff/profiles', { body: defined(createStaffProfileRequestSchema.parse(input)) }))).data; },
    async updateProfile(id: string, input: UpdateStaffProfileRequest) { return parseResponse(staffProfileResponseSchema, check(await api.PATCH('/api/staff/profiles/{staffProfileId}', { params: { path: { staffProfileId: id } }, body: defined(updateStaffProfileRequestSchema.parse(input)) }))).data; },
    async invite(input: InviteStaffRequest) { return parseResponse(inviteStaffResponseSchema, check(await api.POST('/api/staff/invitations', { body: inviteStaffRequestSchema.parse(input) }))).data; },
    async grantRole(userId: string, role: AssignableStaffRole) { check(await api.POST('/api/staff/roles', { body: grantStaffRoleRequestSchema.parse({ userId, role }) })); },
    async changeRole(id: string, role: AssignableStaffRole, revision: number) { check(await api.PATCH('/api/staff/roles/{staffRoleId}', { params: { path: { staffRoleId: id } }, body: { role, revision } })); },
    async revokeRole(id: string, revision: number) { check(await api.DELETE('/api/staff/roles/{staffRoleId}', { params: { path: { staffRoleId: id } }, body: { revision } })); },
    async resetPassword(userId: string, newPassword: string) { check(await api.POST('/api/staff/users/{userId}/reset-password', { params: { path: { userId } }, body: { newPassword } })); },
  };
}
export type StaffClient = ReturnType<typeof createStaffClient>;
