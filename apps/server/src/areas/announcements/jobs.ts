// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { announcementSendJob, announcementService, type AnnouncementsService } from './send.js';
import { cancellationNotice, cancellationNoticeJob, type CancellationNotice } from './cancellation.js';
import { restoreNotice, restoreNoticeJob, type RestoreNotice } from './restored.js';
import { announcementSmsJob } from './send.sms.js';

export function createAnnouncementJobs(read: () => AnnouncementsService = announcementService,
  cancellation: () => CancellationNotice = cancellationNotice, restore: () => RestoreNotice = restoreNotice): readonly JobRegistration[] {
  return [
    { id: announcementSendJob, lane: 'batch', async handler(payload, context) { await read().run(payload, context.gymId); } },
    { id: announcementSmsJob, lane: 'batch', async handler(payload, context) { await read().runSms(payload, context.gymId); } },
    // Member notices about one session run in the notices lane: a slow mailer never holds the gym's waitlist
    // promotions, and the gym's announcement send in the batch lane doesn't hold the notices' lane.
    { id: cancellationNoticeJob, lane: 'notices', async handler(payload, context) { await cancellation().run(payload, context.gymId); } },
    { id: restoreNoticeJob, lane: 'notices', async handler(payload, context) { await restore().run(payload, context.gymId); } },
  ];
}
export const jobs = createAnnouncementJobs();
