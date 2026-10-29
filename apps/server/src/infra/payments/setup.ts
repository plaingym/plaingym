// SPDX-License-Identifier: AGPL-3.0-only
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { STRIPE_API_VERSION, STRIPE_EVENTS } from './stripe.js';
import type { Json, ObjectData, PaymentTransport, ProviderRequest } from './transport.js';

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
  { resource: 'Webhook Endpoints', request: { method: 'POST', path: '/v1/webhook_endpoints/we_PlainGymPermissionProbe', params: { description: 'PlainGym permission probe' } } },
  { resource: 'Events', request: { method: 'GET', path: '/v1/events', params: { limit: 1 } } },
  { resource: 'Disputes', request: { method: 'GET', path: '/v1/disputes', params: { limit: 1 } } },
];
export class StripePermissionError extends Error {
  constructor(readonly resource: string) { super('Check the Stripe permission for ' + resource); }
}
export interface WebhookRegistration { endpointId: string; webhookSecret: string }
/**
 * What `check` did to a stored endpoint. `replaced` (another API version) and `recreated` (the endpoint no longer exists)
 * carry the new endpoint and its signing secret, which the caller must store.
 */
export type WebhookCheck = { status: 'current' | 'updated' | 'skipped' } | { status: 'replaced' | 'recreated'; registration: WebhookRegistration };

function webhookUrl(origin: string): string {
  const url = new URL('/webhooks/stripe', origin);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Stripe requires an HTTPS public origin');
  return url.toString();
}
function endpointPath(id: string): string {
  if (!/^we_[A-Za-z0-9_]+$/.test(id)) throw new Error('Invalid webhook endpoint ID');
  return '/v1/webhook_endpoints/' + id;
}
function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'resource_missing'
    && 'statusCode' in error && error.statusCode === 404;
}
function taggedFor(endpoint: ObjectData, gymId: string): boolean {
  const metadata = endpoint.metadata;
  return !!metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.gym_id === gymId;
}
function sameEvents(actual: Json | undefined): boolean {
  if (!Array.isArray(actual)) return false;
  const present = new Set(actual);
  return present.size === STRIPE_EVENTS.length && STRIPE_EVENTS.every((event) => present.has(event));
}

/**
 * Stripe returns an endpoint's signing secret only when it creates the endpoint, so an endpoint is reused rather than
 * recreated whenever its stored secret still applies. Only endpoints tagged with this gym's ID and pointing at this
 * install's `/webhooks/stripe` are ever updated or deleted.
 */
export function stripeProvisioner(transport: PaymentTransport, mode: 'test' | 'live' = 'test') {
  const live = mode === 'live';
  async function read(id: string): Promise<ObjectData | null> {
    try { return await transport.request({ method: 'GET', path: endpointPath(id) }); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }
  /** The endpoint belongs to this gym and install, in this key's mode. */
  const ours = (endpoint: ObjectData, gymId: string, url: string) =>
    taggedFor(endpoint, gymId) && endpoint.url === url && endpoint.livemode === live;
  async function updateEvents(id: string): Promise<void> {
    const updated = await transport.request({ method: 'POST', path: endpointPath(id), params: { enabled_events: [...STRIPE_EVENTS] } });
    if (!sameEvents(updated.enabled_events)) throw new Error('Webhook endpoint events were not updated');
  }
  async function create(gymId: string, url: string, idempotencyKey: string): Promise<WebhookRegistration> {
    const endpoint = await transport.request({ method: 'POST', path: '/v1/webhook_endpoints',
      params: { url, api_version: STRIPE_API_VERSION, enabled_events: [...STRIPE_EVENTS], metadata: { gym_id: gymId } }, idempotencyKey });
    if (endpoint.livemode !== live || endpoint.api_version !== STRIPE_API_VERSION || typeof endpoint.id !== 'string' || typeof endpoint.secret !== 'string')
      throw new Error('Invalid webhook endpoint');
    return { endpointId: endpoint.id, webhookSecret: endpoint.secret };
  }
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
    /**
     * Keeps `previous` when this key's account still has it, tagged for this gym, at this install's URL and API version,
     * subscribing it to any missing events; otherwise creates a new endpoint. Nothing is deleted here: call `retire`
     * after the new registration is saved.
     */
    async register(gymId: string, origin: string, revision: number, previous?: WebhookRegistration): Promise<WebhookRegistration & { reused: boolean }> {
      assertNoTransaction('payments.registerWebhook');
      const url = webhookUrl(origin);
      if (previous) {
        const endpoint = await read(previous.endpointId);
        if (endpoint && ours(endpoint, gymId, url) && endpoint.api_version === STRIPE_API_VERSION) {
          if (!sameEvents(endpoint.enabled_events)) await updateEvents(previous.endpointId);
          return { ...previous, reused: true };
        }
      }
      return { ...await create(gymId, url, gymId + ':webhook:' + revision), reused: false };
    },
    /** Deletes every other endpoint in this key's account that is tagged for this gym and points at this install. */
    async retire(gymId: string, origin: string, keep: string): Promise<{ deleted: string[]; failures: unknown[] }> {
      assertNoTransaction('payments.retireWebhooks');
      const url = webhookUrl(origin), stale: string[] = [];
      // Collect first: deleting while paging would invalidate the cursor.
      for (let after: string | undefined; ;) {
        const page = await transport.request({ method: 'GET', path: '/v1/webhook_endpoints', params: { limit: 100, ...(after ? { starting_after: after } : {}) } });
        const items = Array.isArray(page.data) ? page.data as ObjectData[] : [];
        for (const item of items) if (typeof item.id === 'string' && item.id !== keep && ours(item, gymId, url)) stale.push(item.id);
        const last = items.at(-1)?.id;
        if (page.has_more !== true || typeof last !== 'string') break;
        after = last;
      }
      const deleted: string[] = [], failures: unknown[] = [];
      for (const id of stale) {
        try { await transport.request({ method: 'DELETE', path: endpointPath(id) }); deleted.push(id); }
        catch (error) { if (!isMissing(error)) failures.push(error); }
      }
      return { deleted, failures };
    },
    /** Deletes one endpoint by ID, only if it is tagged for this gym and points at this install. Missing or foreign endpoints are left alone. */
    async remove(gymId: string, origin: string, endpointId: string): Promise<boolean> {
      assertNoTransaction('payments.removeWebhook');
      const endpoint = await read(endpointId);
      if (!endpoint || !ours(endpoint, gymId, webhookUrl(origin))) return false;
      try { await transport.request({ method: 'DELETE', path: endpointPath(endpointId) }); }
      catch (error) { if (isMissing(error)) return false; throw error; }
      return true;
    },
    /**
     * Compares the stored endpoint's events and API version with this release's. Stripe cannot change an endpoint's API
     * version, so a different version replaces the endpoint (a new signing secret the caller must store, then `retire`).
     * An endpoint that no longer exists (only a 404 resource_missing on its ID counts; any other read error is raised) is
     * recreated the same way. One not tagged for this gym, at another URL, or in the other mode is reported and left alone.
     */
    async check(gymId: string, origin: string, stored: WebhookRegistration): Promise<WebhookCheck> {
      assertNoTransaction('payments.checkWebhook');
      const url = webhookUrl(origin), endpoint = await read(stored.endpointId);
      if (!endpoint) return { status: 'recreated', registration: await create(gymId, url, gymId + ':webhook:recreate:' + stored.endpointId) };
      if (!ours(endpoint, gymId, url)) return { status: 'skipped' };
      if (endpoint.api_version !== STRIPE_API_VERSION)
        return { status: 'replaced', registration: await create(gymId, url, gymId + ':webhook:replace:' + stored.endpointId + ':' + STRIPE_API_VERSION) };
      if (sameEvents(endpoint.enabled_events)) return { status: 'current' };
      await updateEvents(stored.endpointId);
      return { status: 'updated' };
    },
  };
}
