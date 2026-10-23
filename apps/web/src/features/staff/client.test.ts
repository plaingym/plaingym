// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { createStaffClient, StaffRequestError } from './client.js';
const NativeRequest = Request;
const profile = { id: '01900000-0000-7000-8000-000000000001', userId: null, memberId: null, displayName: 'Coach', bio: null, photoKey: null, rank: null, isPublic: false, revision: 2, createdAt: '2026-10-22T12:00:00Z' };
function browserRequests() {
  vi.stubGlobal('Request', class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, 'https://gym.example.test') : input, init);
    }
  });
}
afterEach(() => vi.unstubAllGlobals());
it('uses generated invitation and profile-photo routes with same-origin credentials and validated responses', async () => {
  browserRequests();
  const requests: Request[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    requests.push(request.clone());
    return Response.json(request.url.endsWith('/invitations') ? { data: { delivery: 'email', staffRole: { id: profile.id, userId: profile.id, role: 'coach', revision: 1, createdAt: profile.createdAt } } } : { data: profile });
  });
  const client = createStaffClient(fetcher);
  expect((await client.invite({ email: 'coach@example.test', role: 'coach', delivery: 'email' })).delivery).toBe('email');
  expect(await client.uploadPhoto(profile.id, 1, new File([new Uint8Array([255, 216, 255, 224])], 'photo.jpg', { type: 'image/jpeg' }))).toEqual(profile);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/api/staff/invitations', `/api/staff/profiles/${profile.id}/photo`]);
  expect(requests.every((request) => request.credentials === 'same-origin' && request.method === 'POST')).toBe(true);
  expect(await requests[1]!.json()).toEqual({ revision: 1, contentType: 'image/jpeg', base64: '/9j/4A==' });
});
it('reports generated-client errors without exposing server details', async () => {
  browserRequests();
  const client = createStaffClient(async () => Response.json({ error: 'private SQL details' }, { status: 409 }));
  await expect(client.invite({ email: 'coach@example.test', role: 'coach', delivery: 'print' })).rejects.toEqual(new StaffRequestError(409));
});
