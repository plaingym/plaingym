// SPDX-License-Identifier: AGPL-3.0-only
import { announcementsContracts, ranksContracts, staffContracts, type AnnouncementDraft, type SendAnnouncement } from '@plaingym/shared/contracts';
import { api, ApiError } from '../../lib/api.js';
import { parseResponse } from '../../lib/response.js';

async function checked<T>(result: { response: Response; data?: T; error?: unknown }): Promise<T> {
  if (!result.response.ok || result.data === undefined) {
    // The typed client has already consumed the response body. Read its parsed error.
    const body = result.error;
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
    const reason = details && typeof details === 'object' && 'reason' in details ? details.reason : undefined;
    throw new ApiError(result.response.status, 'request_failed',
      Array.isArray(reason) && reason.every(value => typeof value === 'string') ? reason : []);
  }
  return result.data;
}
export const announcementClient = {
  async preview(input: AnnouncementDraft) {
    return parseResponse(announcementsContracts.preview.response,
      await checked(await api.POST('/api/announcements/preview', { body: announcementsContracts.preview.body.parse(input) }))).data;
  },
  async test(input: AnnouncementDraft) {
    return parseResponse(announcementsContracts.test.response,
      await checked(await api.POST('/api/announcements/test', { body: announcementsContracts.test.body.parse(input) }))).data;
  },
  async send(input: SendAnnouncement) {
    return parseResponse(announcementsContracts.send.response,
      await checked(await api.POST('/api/announcements/send', { body: announcementsContracts.send.body.parse(input) }))).data;
  },
  async list(offset = 0) {
    return parseResponse(announcementsContracts.list.response,
      await checked(await api.GET('/api/announcements', { params: { query: { limit: 20, offset } } })));
  },
  async programs() {
    const result = [];
    for (let offset = 0; ; ) {
      const page = parseResponse(ranksContracts.listPrograms.response,
        await checked(await api.GET('/api/programs', { params: { query: { limit: 100, offset } } })));
      result.push(...page.data); offset += page.data.length;
      if (offset >= page.pagination.total) return result;
      if (!page.data.length) throw new Error('Incomplete program list');
    }
  },
  async senders() {
    const result = [];
    for (let offset = 0; ; ) {
      const page = parseResponse(staffContracts.listProfiles.response,
        await checked(await api.GET('/api/staff/profiles', { params: { query: { limit: 100, offset } } })));
      result.push(...page.data); offset += page.data.length;
      if (offset >= page.pagination.total) return result;
      if (!page.data.length) throw new Error('Incomplete staff list');
    }
  },
};
export type AnnouncementClient = typeof announcementClient;
export type Announcement = Awaited<ReturnType<AnnouncementClient['send']>>;
