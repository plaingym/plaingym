// SPDX-License-Identifier: AGPL-3.0-only
import { announcementsContracts, ranksContracts, staffContracts, type AnnouncementDraft, type AnnouncementSmsTest, type SendAnnouncement } from '@plaingym/shared/contracts';
import { api, checked } from '../../lib/api.js';
import { parseResponse } from '../../lib/response.js';

function draftBody<T extends AnnouncementDraft>(input: T) {
  const { sms, ...rest } = input;
  return { ...rest, ...(sms ? { sms } : {}) };
}
export const announcementClient = {
  async preview(input: AnnouncementDraft) {
    return parseResponse(announcementsContracts.preview.response,
      await checked(await api.POST('/api/announcements/preview', { body: draftBody(announcementsContracts.preview.body.parse(input)) }))).data;
  },
  async test(input: AnnouncementDraft) {
    return parseResponse(announcementsContracts.test.response,
      await checked(await api.POST('/api/announcements/test', { body: draftBody(announcementsContracts.test.body.parse(input)) }))).data;
  },
  async testSms(input: AnnouncementSmsTest) {
    return parseResponse(announcementsContracts.testSms.response,
      await checked(await api.POST('/api/announcements/test-sms', { body: announcementsContracts.testSms.body.parse(input) }))).data;
  },
  async send(input: SendAnnouncement) {
    return parseResponse(announcementsContracts.send.response,
      await checked(await api.POST('/api/announcements/send', { body: draftBody(announcementsContracts.send.body.parse(input)) }))).data;
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
