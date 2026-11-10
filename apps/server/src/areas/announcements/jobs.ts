// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { announcementSendJob, announcementService, type AnnouncementsService } from './send.js';

export function createAnnouncementJobs(read: () => AnnouncementsService = announcementService): readonly JobRegistration[] {
  return [{ id: announcementSendJob, lane: 'batch', async handler(payload, context) { await read().run(payload, context.gymId); } }];
}
export const jobs = createAnnouncementJobs();
