// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { STRIPE_API_VERSION, STRIPE_EVENTS } from './stripe.js';
import type { PaymentTransport, ProviderRequest } from './transport.js';

/** Invalid IDs are deliberately used for write probes: validation must never move money or mutate a real object. */
export const permissionProbes: readonly { resource: string; request: ProviderRequest }[] = [
  { resource: 'Customers', request: { method: 'GET', path: '/v1/customers', params: { limit: 1 } } },
  { resource: 'Customers', request: { method: 'POST', path: '/v1/customers/cus_PlainGymPermissionProbe', params: { metadata: { gym_id: 'probe' } } } },
  { resource: 'Payment Intents', request: { method: 'GET', path: '/v1/payment_intents', params: { limit: 1 } } },
  { resource: 'Payment Intents', request: { method: 'POST', path: '/v1/payment_intents/pi_PlainGymPermissionProbe/confirm', params: {} } },
  { resource: 'Checkout Sessions', request: { method: 'GET', path: '/v1/checkout/sessions', params: { limit: 1 } } },
  { resource: 'Checkout Sessions', request: { method: 'POST', path: '/v1/checkout/sessions/cs_PlainGymPermissionProbe/expire', params: {} } },
  { resource: 'Setup Intents', request: { method: 'GET', path: '/v1/setup_intents', params: { limit: 1 } } },
  { resource: 'Payment Methods', request: { method: 'GET', path: '/v1/payment_methods', params: { type: 'card', limit: 1 } } },
  { resource: 'Payment Methods', request: { method: 'POST', path: '/v1/payment_methods/pm_PlainGymPermissionProbe/detach', params: {} } },
  { resource: 'Charges and Refunds', request: { method: 'GET', path: '/v1/charges', params: { limit: 1 } } },
  { resource: 'Charges and Refunds', request: { method: 'GET', path: '/v1/refunds', params: { limit: 1 } } },
  { resource: 'Charges and Refunds', request: { method: 'POST', path: '/v1/refunds', params: { payment_intent: 'pi_PlainGymPermissionProbe', amount: 1 } } },
  { resource: 'Webhook Endpoints', request: { method: 'GET', path: '/v1/webhook_endpoints', params: { limit: 1 } } },
  { resource: 'Events', request: { method: 'GET', path: '/v1/events', params: { limit: 1 } } },
  { resource: 'Disputes', request: { method: 'GET', path: '/v1/disputes', params: { limit: 1 } } },
];
export class StripePermissionError extends Error {
  constructor(readonly resource: string) { super('Check the Stripe permission for ' + resource); }
}
export function stripeProvisioner(transport: PaymentTransport, mode: 'test' | 'live' = 'test') {
  return {
    async validate(): Promise<void> {
      assertNoTransaction('payments.validate');
      for (const probe of permissionProbes) {
        try { await transport.request(probe.request); }
        catch (error) {
          const value = error as { type?: string; statusCode?: number; code?: string };
          if (probe.request.method === 'POST' && value.type === 'StripeInvalidRequestError'
            && value.code === 'resource_missing' && [400, 404].includes(value.statusCode ?? 0)) continue;
          throw new StripePermissionError(probe.resource);
        }
      }
    },
    async register(gymId: string, origin: string, revision: number): Promise<{ endpointId: string; webhookSecret: string }> {
      assertNoTransaction('payments.registerWebhook');
      const url = new URL('/webhooks/stripe', origin);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Stripe requires an HTTPS public origin');
      const endpoint = await transport.request({ method: 'POST', path: '/v1/webhook_endpoints',
        params: { url: url.toString(), api_version: STRIPE_API_VERSION, enabled_events: [...STRIPE_EVENTS], metadata: { gym_id: gymId } },
        idempotencyKey: gymId + ':webhook:' + revision });
      if (endpoint.livemode !== (mode === 'live') || endpoint.api_version !== STRIPE_API_VERSION || typeof endpoint.id !== 'string' || typeof endpoint.secret !== 'string')
        throw new Error('Invalid webhook endpoint');
      return { endpointId: endpoint.id, webhookSecret: endpoint.secret };
    },
  };
}
