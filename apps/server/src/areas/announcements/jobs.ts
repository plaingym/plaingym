// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { announcementSendJob, announcementService, type AnnouncementsService } from './send.js';
import { cancellationNotice, cancellationNoticeJob, type CancellationNotice } from './cancellation.js';

export function createAnnouncementJobs(read: () => AnnouncementsService = announcementService,
  cancellation: () => CancellationNotice = cancellationNotice): readonly JobRegistration[] {
  return [
    { id: announcementSendJob, lane: 'batch', async handler(payload, context) { await read().run(payload, context.gymId); } },
    { id: cancellationNoticeJob, async handler(payload, context) { await cancellation().run(payload, context.gymId); } },
  ];
}
export const jobs = createAnnouncementJobs();
