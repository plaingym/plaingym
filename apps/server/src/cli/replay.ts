// SPDX-License-Identifier: AGPL-3.0-only
import type { Command } from './index.js';
import { AppError } from '@plaingym/shared';
import { z } from 'zod';
import type { WebhookInbox } from '../areas/billing/webhooks/inbox.js';

export function createReplayCommand(replay: WebhookInbox['replay']): Command {
  return { id: 'replay', description: 'Queue a saved Stripe webhook event again for its gym', async run(args, io) {
    if (args.length !== 3 || args[0] !== '--gym' || !z.uuid().safeParse(args[1]).success || !args[2]) {
      io.stderr('Usage: replay --gym <gym-id> <event-id>'); return 2;
    }
    try {
      const { jobId } = await replay(args[1]!, args[2]!);
      io.stdout('Webhook replay queued: ' + jobId); return 0;
    } catch (error) {
      io.stderr(error instanceof AppError ? error.message : 'Unable to queue webhook replay'); return 1;
    }
  } };
}
let configured: WebhookInbox['replay'] | undefined;
export function configureWebhookReplay(inbox: Pick<WebhookInbox, 'replay'>) { configured = inbox.replay; }
export const commands: readonly Command[] = [createReplayCommand(async (gymId, eventId) => {
  if (!configured) throw new AppError('unavailable', 'Webhook replay is not configured');
  return configured(gymId, eventId);
})];
