// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { campaignPublishJob, campaignSendJob, campaignService, type CampaignsService } from './campaigns.js';

export const campaignScanJob = 'links.campaigns.scan';
/**
 * The scan and the bulk sends it and publication queue (up to a campaign's 2,000 recipients) run in the jobs batch
 * lane, so the gym's webhooks and notices never wait behind them.
 */
export const campaignBatchJobs = [campaignScanJob, campaignPublishJob, campaignSendJob] as const;
export function createCampaignJobs(read: () => CampaignsService = campaignService): readonly JobRegistration[] {
  return [
    { id: campaignScanJob, cron: '7 * * * *', async handler(_payload, context) { await read().scan(context.gymId); } },
    { id: campaignSendJob, async handler(payload, context) { await read().send(payload, context.gymId); } },
    { id: campaignPublishJob, async handler(payload, context) { await read().publish(payload, context.gymId); } },
  ];
}
export const jobs = createCampaignJobs();
