// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import { route, type RouteRegistration } from '../../../core/registry.js';
import { PaymentWebhookError } from '../../../infra/payments/webhook-error.js';
import type { WebhookInbox } from './inbox.js';

/** Raw metadata is only a provider-selection hint. parseWebhook establishes ownership. */
function gymHint(body: Uint8Array): string | null {
  try {
    const input = z.object({ data: z.object({ object: z.object({ metadata: z.object({ gym_id: z.uuid() }) }) }) })
      .safeParse(JSON.parse(new TextDecoder().decode(body)));
    return input.success ? input.data.data.object.metadata.gym_id : null;
  } catch { return null; }
}
export function createWebhookInboxRoutes(inbox: Pick<WebhookInbox, 'receive'>, options: {
  /** Demo uses one install endpoint and one shared test account; no hostname selects the gym. */
  demoGyms?: () => Promise<readonly { gymId: string }[]>;
} = {}): readonly RouteRegistration[] {
  return [route({
    // TODO(CCR): promote this raw-body install/tenant endpoint to the shared HTTP contracts.
    method: 'post', path: '/webhooks/stripe', permission: { kind: 'public' },
    responses: {
      200: { description: 'Stored, duplicate, or unrelated event', content: { 'application/json': { schema: z.object({ received: z.literal(true) }) } } },
      400: { description: 'Invalid webhook', content: { 'application/json': { schema: z.object({ error: z.literal('webhook_invalid') }) } } },
    },
  }, async (context) => {
    const body = new Uint8Array(await context.req.arrayBuffer()), signature = context.req.header('stripe-signature') ?? '';
    const gyms = options.demoGyms ? await options.demoGyms() : [context.get('context').gym];
    if (!gyms.length) throw new AppError('unavailable', 'Payments are not set up for this gym');
    const hint = options.demoGyms ? gymHint(body) : null;
    const selected = hint ? [gyms.find((gym) => gym.gymId === hint) ?? gyms[0]!] : gyms;
    // Untagged refunds/disputes may need provider lookups; only the matching provider accepts.
    for (const gym of selected) {
      try { await inbox.receive(gym.gymId, body, signature); break; }
      catch (error) {
        if (!(error instanceof PaymentWebhookError)) throw error;
        if (error.code === 'webhook_invalid') return context.json({ error: 'webhook_invalid' as const }, 400);
        if (error.code !== 'webhook_not_for_gym') throw error;
      }
    }
    return context.json({ received: true as const }, 200);
  })];
}
let configured: readonly RouteRegistration[] | undefined;
const unavailable = createWebhookInboxRoutes({ async receive() { throw new AppError('unavailable', 'Webhook inbox is not configured'); } });
export function configureWebhookInboxRoutes(inbox: WebhookInbox, options: Parameters<typeof createWebhookInboxRoutes>[1] = {}) {
  configured = createWebhookInboxRoutes(inbox, options);
}
export const routes: readonly RouteRegistration[] = [{
  ...unavailable[0]!,
  mount(app, authorize) {
    for (const entry of configured ?? unavailable) entry.mount(app, authorize);
  },
}];
