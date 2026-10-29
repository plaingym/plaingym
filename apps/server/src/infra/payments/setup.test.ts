// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { runInTransaction } from '@plaingym/shared/transaction';
import { STRIPE_API_VERSION, STRIPE_EVENTS } from './stripe.js';
import { StripeFixtures } from './stripe-fixtures.js';
import { permissionProbes, stripeProvisioner, StripePermissionError } from './setup.js';
import { webhookEndpointContract } from './webhook-endpoints.contract.js';
import type { PaymentTransport } from './transport.js';

const gymId = '00000000-0000-7000-8000-000000000001', origin = 'https://gym.invalid';

webhookEndpointContract('StripeFixtures', () => ({ transport: new StripeFixtures(gymId), gymId, origin, base: 0 }));

describe('webhook endpoint lifecycle', () => {
  it('replaces an endpoint created at another API version, since Stripe cannot change that version', async () => {
    const transport = new StripeFixtures(gymId), provisioner = stripeProvisioner(transport);
    const old = await transport.request({ method: 'POST', path: '/v1/webhook_endpoints', params: { url: origin + '/webhooks/stripe',
      api_version: '2025-01-01.old', enabled_events: [...STRIPE_EVENTS], metadata: { gym_id: gymId } } });
    const stored = { endpointId: old.id as string, webhookSecret: 'whsec_old' };
    const checked = await provisioner.check(gymId, origin, stored);
    expect(checked).toMatchObject({ status: 'replaced', registration: { endpointId: expect.stringMatching(/^we_/) } });
    if (checked.status !== 'replaced') throw new Error('Expected a replacement');
    expect(checked.registration.endpointId).not.toBe(stored.endpointId);
    expect((await transport.request({ method: 'GET', path: '/v1/webhook_endpoints/' + checked.registration.endpointId })).api_version).toBe(STRIPE_API_VERSION);
    // A retry after a lost response returns the same replacement rather than another endpoint.
    expect(await provisioner.check(gymId, origin, stored)).toEqual(checked);
    expect(await provisioner.retire(gymId, origin, checked.registration.endpointId)).toEqual({ deleted: [stored.endpointId], failures: [] });
    // Saving a key does the same: an endpoint at another version is never reused.
    const other = await transport.request({ method: 'POST', path: '/v1/webhook_endpoints', params: { url: origin + '/webhooks/stripe',
      api_version: '2025-01-01.old', enabled_events: [...STRIPE_EVENTS], metadata: { gym_id: gymId } } });
    expect(await provisioner.register(gymId, origin, 9, { endpointId: other.id as string, webhookSecret: 'x' })).toMatchObject({ reused: false });
  });
  it('leaves an endpoint at another URL or in the other mode alone, and never reuses one', async () => {
    const transport = new StripeFixtures(gymId), provisioner = stripeProvisioner(transport);
    const params = { api_version: STRIPE_API_VERSION, enabled_events: ['charge.refunded'], metadata: { gym_id: gymId } };
    const moved = (await transport.request({ method: 'POST', path: '/v1/webhook_endpoints', params: { ...params, url: 'https://old-host.invalid/webhooks/stripe' } })).id as string;
    expect(await provisioner.check(gymId, origin, { endpointId: moved, webhookSecret: 'x' })).toEqual({ status: 'skipped' });
    expect(await provisioner.register(gymId, origin, 1, { endpointId: moved, webhookSecret: 'x' })).toMatchObject({ reused: false });
    expect(await provisioner.remove(gymId, origin, moved)).toBe(false);
    expect(transport.objects.get(moved)).toMatchObject({ enabled_events: ['charge.refunded'] });
    // A live-mode provisioner does not see a test-mode endpoint as its own.
    const test = await stripeProvisioner(transport).register(gymId, origin, 2);
    expect(await stripeProvisioner(transport, 'live').check(gymId, origin, test)).toEqual({ status: 'skipped' });
  });
  it('pages through every endpoint when retiring', async () => {
    const transport = new StripeFixtures(gymId), provisioner = stripeProvisioner(transport);
    const ids: string[] = [];
    for (let index = 0; index < 105; index++) ids.push((await transport.request({ method: 'POST', path: '/v1/webhook_endpoints', params: {
      url: origin + '/webhooks/stripe', api_version: STRIPE_API_VERSION, enabled_events: [...STRIPE_EVENTS], metadata: { gym_id: gymId } } })).id as string);
    const retired = await provisioner.retire(gymId, origin, ids[3]!);
    expect(retired.failures).toEqual([]);
    expect(retired.deleted).toHaveLength(104);
    expect([...transport.objects.values()].filter((object) => object.object === 'webhook_endpoint').map((object) => object.id)).toEqual([ids[3]]);
  });
  it('reports a delete Stripe refuses without stopping the others, and ignores one that is already gone', async () => {
    const transport = new StripeFixtures(gymId);
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) ids.push((await transport.request({ method: 'POST', path: '/v1/webhook_endpoints', params: {
      url: origin + '/webhooks/stripe', api_version: STRIPE_API_VERSION, enabled_events: [...STRIPE_EVENTS], metadata: { gym_id: gymId } } })).id as string);
    const refusal = Object.assign(new Error('Permission denied'), { statusCode: 403 });
    const restricted: PaymentTransport = { request: (input) => input.method === 'DELETE' && input.path.endsWith(ids[0]!)
      ? Promise.reject(refusal) : transport.request(input) };
    const retired = await stripeProvisioner(restricted).retire(gymId, origin, ids[2]!);
    expect(retired).toEqual({ deleted: [ids[1]], failures: [refusal] });
  });
  it('refuses to run inside a transaction and rejects a non-HTTPS origin', async () => {
    const provisioner = stripeProvisioner(new StripeFixtures(gymId));
    await expect(runInTransaction(() => provisioner.retire(gymId, origin, 'we_1'))).rejects.toThrow();
    await expect(runInTransaction(() => provisioner.check(gymId, origin, { endpointId: 'we_1', webhookSecret: 'x' }))).rejects.toThrow();
    await expect(runInTransaction(() => provisioner.remove(gymId, origin, 'we_1'))).rejects.toThrow();
    await expect(provisioner.retire(gymId, 'http://gym.invalid', 'we_1')).rejects.toThrow('HTTPS');
    await expect(provisioner.remove(gymId, origin, '../customers')).rejects.toThrow('Invalid webhook endpoint ID');
  });
});

describe('Webhook Endpoints write probe', () => {
  it('uses a nonexistent endpoint ID, so validation never changes a real endpoint', async () => {
    const probe = permissionProbes.find((entry) => entry.resource === 'Webhook Endpoints' && entry.request.method === 'POST')!;
    expect(probe.request.path).toBe('/v1/webhook_endpoints/we_PlainGymPermissionProbe');
    const transport = new StripeFixtures(gymId);
    const existing = (await transport.request({ method: 'POST', path: '/v1/webhook_endpoints', params: { url: origin + '/webhooks/stripe',
      api_version: STRIPE_API_VERSION, enabled_events: ['charge.refunded'], metadata: { gym_id: gymId } } })).id as string;
    const before = structuredClone(transport.objects.get(existing));
    await stripeProvisioner(transport).validate();
    expect(transport.objects.get(existing)).toEqual(before);
    expect(transport.requests.filter((input) => input.path.includes('PlainGymPermissionProbe') && input.method !== 'GET')
      .map((input) => input.method + ' ' + input.path)).toContain('POST /v1/webhook_endpoints/we_PlainGymPermissionProbe');
  });
  it('rejects a key that can read but not write Webhook Endpoints', async () => {
    const transport = new StripeFixtures(gymId);
    const readOnly: PaymentTransport = { request: (input) => input.method === 'POST' && input.path.startsWith('/v1/webhook_endpoints')
      ? Promise.reject(Object.assign(new Error('Permission denied'), { type: 'StripePermissionError', statusCode: 403 })) : transport.request(input) };
    const failure = await stripeProvisioner(readOnly).validate().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StripePermissionError);
    expect(failure).toMatchObject({ resource: 'Webhook Endpoints', message: 'Check the Stripe permission for Webhook Endpoints' });
  });
});
