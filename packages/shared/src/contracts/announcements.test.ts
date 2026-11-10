// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { canStaff, staffRoles } from '../permissions.js';
import { announcementDraftSchema, announcementsContracts, sendAnnouncementSchema } from './announcements.js';

const draft = { subject: 'Closed Monday', body: 'See you Tuesday.' };
it('defaults the audience and enforces plain subject and body limits', () => {
  expect(announcementDraftSchema.parse(draft).audience).toEqual({ statuses: ['active', 'trial', 'frozen'], programIds: [] });
  for (const change of [{ subject: '' }, { subject: 'x'.repeat(151) }, { subject: 'a\r\nb' }, { body: '' }, { body: 'x'.repeat(10001) },
    { audience: { statuses: ['cancelled'] } }, { audience: { statuses: [] } }, { audience: { programIds: ['bad'] } }, { to: 'other@example.test' }])
    expect(announcementDraftSchema.safeParse({ ...draft, ...change }).success).toBe(false);
  expect(announcementDraftSchema.safeParse({ subject: 'x'.repeat(150), body: 'x'.repeat(10000) }).success).toBe(true);
});
it('requires explicit confirmation and a stable send generation', () => {
  expect(sendAnnouncementSchema.safeParse(draft).success).toBe(false);
  expect(sendAnnouncementSchema.safeParse({ ...draft, confirm: false, sendGeneration: '01900000-0000-7000-8000-000000000001' }).success).toBe(false);
  expect(sendAnnouncementSchema.safeParse({ ...draft, confirm: true, sendGeneration: '01900000-0000-7000-8000-000000000001' }).success).toBe(true);
});
it('gates every announcement endpoint to owners and admins', () => {
  for (const contract of Object.values(announcementsContracts)) expect(contract.permission).toEqual({ kind: 'staff', capability: 'announcements.send' });
  expect(staffRoles.filter(role => canStaff([role], 'announcements.send'))).toEqual(['owner', 'admin']);
});
