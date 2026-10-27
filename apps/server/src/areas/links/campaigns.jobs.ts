// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { campaignPublishJob, campaignSendJob, campaignService, type CampaignsService } from './campaigns.js';

export function createCampaignJobs(read: () => CampaignsService = campaignService): readonly JobRegistration[] {
  return [
    { id: 'links.campaigns.scan', cron: '7 * * * *', async handler(_payload, context) { await read().scan(context.gymId); } },
    { id: campaignSendJob, async handler(payload, context) { await read().send(payload, context.gymId); } },
    { id: campaignPublishJob, async handler(payload, context) { await read().publish(payload, context.gymId); } },
  ];
}
export const jobs = createCampaignJobs();
