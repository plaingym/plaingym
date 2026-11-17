// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../../core/registry.js';
import type { WebhookInbox } from './inbox.js';
import { configuredWebhookInbox } from './inbox.jobs.js';

export const webhookRecoveryJob = 'billing.webhooks.recover';
export function createWebhookInboxRecoveryJobs(read: () => WebhookInbox | undefined = configuredWebhookInbox): readonly JobRegistration[] {
  return [{ id: webhookRecoveryJob, cron: '17 * * * *', async handler(_payload, context) {
    const inbox = read();
    if (!inbox) throw new Error('Webhook inbox recovery is not configured');
    await inbox.recoverFailed(context.gymId);
  } }];
}
export const jobs = createWebhookInboxRecoveryJobs();
