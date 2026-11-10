// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { announcementClient } from './api.js';
import { api, ApiError } from '../../lib/api.js';

afterEach(() => vi.restoreAllMocks());
const id = '01900000-0000-7000-8000-000000000001';
const draft = { subject: ' Schedule ', body: ' Classes resume. ', audience: { statuses: ['active' as const], programIds: [] } };
const announcement = { id, createdBy: id, subject: 'Schedule', body: 'Classes resume.', audience: draft.audience,
  recipientCount: 3, status: 'sending' as const, createdAt: '2026-11-10T00:00:00Z', completedAt: null, sent: 0, failed: 0, skipped: 0 };

it('sends validated preview, test and confirmed drafts through their typed endpoints', async () => {
  const post = vi.spyOn(api, 'POST');
  post.mockResolvedValueOnce({ response: new Response('{}'), data: { data: { recipientCount: 3, future: true }, future: true } } as never);
  expect(await announcementClient.preview(draft)).toEqual({ recipientCount: 3 });
  expect(post).toHaveBeenLastCalledWith('/api/announcements/preview', { body: { ...draft, subject: 'Schedule', body: 'Classes resume.' } });
  post.mockResolvedValueOnce({ response: new Response('{}'), data: { data: { sent: true } } });
  expect(await announcementClient.test(draft)).toEqual({ sent: true });
  expect(post).toHaveBeenLastCalledWith('/api/announcements/test', expect.anything());
  post.mockResolvedValueOnce({ response: new Response('{}'), data: { data: announcement } });
  expect(await announcementClient.send({ ...draft, sendGeneration: id, confirm: true })).toEqual(announcement);
  expect(post).toHaveBeenLastCalledWith('/api/announcements/send', { body: { ...draft, subject: 'Schedule', body: 'Classes resume.', sendGeneration: id, confirm: true } });
});

it.each(['disabled', 'no_smtp'])('preserves structured %s reasons without exposing server messages', async reason => {
  const response = Response.json({ error: { code: 'conflict', message: 'private detail', details: { reason: [reason] } } }, { status: 409 });
  vi.spyOn(api, 'POST').mockResolvedValue({ response, error: await response.json() });
  await expect(announcementClient.preview(draft)).rejects.toEqual(new ApiError(409, 'request_failed', [reason]));
});

it('rejects malformed success answers and invalid drafts before sending', async () => {
  const post = vi.spyOn(api, 'POST').mockResolvedValue({ response: new Response('{}'), data: { data: { recipientCount: -1 } } });
  await expect(announcementClient.preview(draft)).rejects.toThrow();
  post.mockClear();
  await expect(announcementClient.preview({ ...draft, subject: 'bad\nsubject' })).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
});

it('paginates history and preserves server ordering', async () => {
  const get = vi.spyOn(api, 'GET').mockResolvedValue({ response: new Response('{}'), data: { data: [announcement], pagination: { total: 21, offset: 20, limit: 20 } } });
  expect((await announcementClient.list(20)).data).toEqual([announcement]);
  expect(get).toHaveBeenCalledWith('/api/announcements', { params: { query: { limit: 20, offset: 20 } } });
});

it('loads every program page for audience filtering and every staff page for sender names', async () => {
  const program = { id, gymId: id, name: 'Adults', rankSystemId: null, active: true, revision: 1, createdAt: announcement.createdAt };
  const profile = { id, userId: id, memberId: null, displayName: 'Jo Owner', bio: null, photoKey: null, rank: null, isPublic: false, revision: 1, createdAt: announcement.createdAt };
  const get = vi.spyOn(api, 'GET');
  for (const [method, path, item] of [[announcementClient.programs, '/api/programs', program], [announcementClient.senders, '/api/staff/profiles', profile]] as const) {
    get.mockResolvedValueOnce({ response: new Response('{}'), data: { data: [item], pagination: { offset: 0, limit: 100, total: 2 } } } as never)
      .mockResolvedValueOnce({ response: new Response('{}'), data: { data: [item], pagination: { offset: 1, limit: 100, total: 2 } } } as never);
    expect(await method()).toEqual([item, item]);
    expect(get).toHaveBeenLastCalledWith(path, { params: { query: { offset: 1, limit: 100 } } });
  }
});

it('rejects incomplete filter pages instead of presenting partial choices', async () => {
  vi.spyOn(api, 'GET').mockResolvedValue({ response: new Response('{}'), data: { data: [], pagination: { offset: 0, limit: 100, total: 1 } } });
  await expect(announcementClient.programs()).rejects.toThrow('Incomplete program list');
  await expect(announcementClient.senders()).rejects.toThrow('Incomplete staff list');
});
