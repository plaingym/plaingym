// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { campaignPublishJob, campaignSendJob, campaignService, type CampaignsService } from './campaigns.js';

export const campaignScanJob = 'links.campaigns.scan';
export function createCampaignJobs(read: () => CampaignsService = campaignService): readonly JobRegistration[] {
  // The scan and the bulk sends it and publication queue (up to a campaign's 2,000 recipients) run in the jobs batch
  // lane, so the gym's webhooks and notices never wait behind them.
  return [
    { id: campaignScanJob, cron: '7 * * * *', lane: 'batch', async handler(_payload, context) { await read().scan(context.gymId); } },
    { id: campaignSendJob, lane: 'batch', async handler(payload, context) { await read().send(payload, context.gymId); } },
    { id: campaignPublishJob, lane: 'batch', async handler(payload, context) { await read().publish(payload, context.gymId); } },
  ];
}
export const jobs = createCampaignJobs();
