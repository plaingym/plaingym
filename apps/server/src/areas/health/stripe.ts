// SPDX-License-Identifier: AGPL-3.0-only
import { createTranslator } from '@plaingym/shared';
import type { WebhookHealthQuery } from '../../core/interfaces/webhook-health.js';
import messages from '../../../../../locales/en/health/stripe.json' with { type: 'json' };
import { healthProvider } from './status.js';

const t = createTranslator({ 'health/stripe': messages });
const silenceWarningMs = 24 * 60 * 60 * 1000;
export function createStripeHealthProvider(options: {
  webhooks: WebhookHealthQuery;
  configured: (gymId: string) => Promise<boolean>;
}) {
  return healthProvider('stripe_webhooks', async context => {
    const checkedAt = context.clock.now().toISOString();
    if (!await options.configured(context.gymId)) return { id: 'stripe_webhooks', status: 'not_configured',
      checkedAt, details: null, message: t('health/stripe:missing') };
    const health = await options.webhooks.get(context.gymId);
    const silent = !health.lastReceivedAt && health.firstChargeAttemptAt != null
      && context.clock.now().getTime() - Date.parse(health.firstChargeAttemptAt) >= silenceWarningMs;
    // A failure from the last 7 days needs attention now; an older one that nobody replayed is a reminder, not an alarm.
    const message = health.recentFailedCount ? 'failed' : health.failedCount ? 'failedOlder'
      : health.pendingCount ? 'pending' : silent ? 'neverArrived' : health.lastReceivedAt ? 'healthy' : 'waiting';
    const status = health.recentFailedCount ? 'error' : health.failedCount || health.pendingCount || silent ? 'warning' : 'healthy';
    return { id: 'stripe_webhooks', status, checkedAt, message: t('health/stripe:' + message,
      { count: health.recentFailedCount || health.failedCount }),
      details: { lastReceivedAt: health.lastReceivedAt, lastProcessedAt: health.lastProcessedAt,
        pending: health.pendingCount, failed: health.failedCount } };
  });
}
