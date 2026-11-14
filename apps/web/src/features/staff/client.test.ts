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
  expect((await client.invite({ email: 'coach@example.test', role: 'coach', delivery: 'email', sendGeneration: crypto.randomUUID() })).delivery).toBe('email');
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
it('searches gym accounts with staff-only filters and resolves a selected account by ID', async () => {
  browserRequests();
  const requests: URL[] = [], person = { id: profile.id, displayName: 'Alex Coach', email: 'alex@example.test' };
  const client = createStaffClient(async input => {
    const request = input as Request; requests.push(new URL(request.url));
    return Response.json({ data: [person], pagination: { limit: 25, offset: 25, total: 26 } });
  });
  expect(await client.people('staff', 'Alex Coach', 25)).toEqual({ data: [person], total: 26 });
  expect(requests[0]?.pathname).toBe('/api/staff/accounts');
  expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ limit: '25', offset: '25', staffOnly: 'true', search: 'Alex Coach' });
  expect(await client.person('account', profile.id)).toEqual(person);
  expect(requests[1]?.searchParams.get('userId')).toBe(profile.id);
  expect(requests[1]?.searchParams.get('staffOnly')).toBe('false');
});
