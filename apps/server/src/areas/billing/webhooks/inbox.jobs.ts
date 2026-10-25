// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../../core/registry.js';
import { webhookDispatchJob, type WebhookInbox } from './inbox.js';

export function createWebhookInboxJobs(inbox: WebhookInbox): readonly JobRegistration[] {
  return [{ id: webhookDispatchJob, handler: (payload, context) => inbox.dispatch(payload, context) }];
}
let configured: WebhookInbox | undefined;
export function configureWebhookInboxJobs(inbox: WebhookInbox) { configured = inbox; }
export const jobs: readonly JobRegistration[] = [{ id: webhookDispatchJob, async handler(payload, context) {
  if (!configured) throw new Error('Webhook inbox jobs are not configured');
  await configured.dispatch(payload, context);
} }];
