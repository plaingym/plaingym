// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator } from '@plaingym/shared';
import type { WebhookHealthQuery } from '../../core/interfaces/webhook-health.js';
import messages from '../../../../../locales/en/health/stripe.json' with { type: 'json' };
import { healthProvider } from './status.js';

const t = createTranslator({ 'health/stripe': messages });
export function createStripeHealthProvider(options: {
  webhooks: WebhookHealthQuery;
  configured: (gymId: string) => Promise<boolean>;
}) {
  return healthProvider('stripe_webhooks', async context => {
    const checkedAt = context.clock.now().toISOString();
    if (!await options.configured(context.gymId)) return { id: 'stripe_webhooks', status: 'not_configured',
      checkedAt, details: null, message: t('health/stripe:missing') };
    const health = await options.webhooks.get(context.gymId);
    const status = health.failedCount ? 'error' : health.pendingCount ? 'warning' : health.lastReceivedAt ? 'healthy' : 'warning';
    return { id: 'stripe_webhooks', status, checkedAt, message: t('health/stripe:' +
      (health.failedCount ? 'failed' : health.pendingCount ? 'pending' : health.lastReceivedAt ? 'healthy' : 'waiting')),
      details: { lastReceivedAt: health.lastReceivedAt, lastProcessedAt: health.lastProcessedAt,
        pending: health.pendingCount, failed: health.failedCount } };
  });
}
