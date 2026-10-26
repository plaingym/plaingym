// SPDX-License-Identifier: AGPL-3.0-only
import type { forGym } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import type { Jobs } from '../../../../infra/jobs/index.js';
import type { GymSettingsAccessor } from '../../../../core/interfaces/gym-settings.js';
import { createMembershipService } from '../../memberships.js';
import { createInvoiceTransitions } from '../../transitions/index.js';
import { createTransitionEffects, type TransitionEffectOptions } from '../../transitions/effects.js';
import { createTransitionNotifications } from '../../transitions/notifications.js';
import { configureTransitionEffects } from '../../transitions/transitions.jobs.js';
import type { PaymentsResolver, WebhookInbox } from '../inbox.js';
import { registerBillingWebhookHandlers } from './index.js';

/** Call once before registering/starting the job worker. Share transitions with other billing consumers. */
export function composeBillingWebhooks(options: {
  inbox: WebhookInbox;
  jobs: Jobs;
  settings: GymSettingsAccessor;
  paymentsFor: PaymentsResolver;
  scope?: typeof forGym;
  clock?: Clock;
  prepare: Parameters<typeof createTransitionNotifications>[0]['prepare'];
  staffRecipients: Parameters<typeof createTransitionNotifications>[0]['staffRecipients'];
}) {
  let retry: TransitionEffectOptions['retry'] | undefined;
  const transitions = createInvoiceTransitions({ ...options, afterCommit: gymId => effects.publish(gymId) });
  const effects = createTransitionEffects({ ...options, transitions,
    memberships: createMembershipService(options), notifications: createTransitionNotifications(options),
    async payments(gymId) {
      const provider = await options.paymentsFor(gymId);
      if (!provider) throw new Error('Payments are not configured for this gym');
      return provider;
    },
    async retry(invoiceId, context) {
      if (!retry) throw new Error('Billing retry runner is not configured');
      await retry(invoiceId, context);
    },
  });
  registerBillingWebhookHandlers(options.inbox, { ...options, transitions });
  configureTransitionEffects(effects);
  return { transitions, effects, attachRetry(handler: TransitionEffectOptions['retry']) { retry = handler; } };
}
