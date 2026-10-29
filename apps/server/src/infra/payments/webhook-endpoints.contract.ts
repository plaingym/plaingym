// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { STRIPE_API_VERSION, STRIPE_EVENTS } from './stripe.js';
import { stripeProvisioner } from './setup.js';
import type { ObjectData, PaymentTransport } from './transport.js';

export interface EndpointHarness {
  transport: PaymentTransport;
  gymId: string;
  /** An origin no other test uses, so the run's endpoints never mix with anyone else's. */
  origin: string;
  /** Added to revisions so repeated runs never replay an earlier run's idempotency keys. */
  base: number;
}
const url = (origin: string) => origin + '/webhooks/stripe';
async function endpoints(transport: PaymentTransport): Promise<ObjectData[]> {
  const page = await transport.request({ method: 'GET', path: '/v1/webhook_endpoints', params: { limit: 100 } });
  return page.data as ObjectData[];
}
async function create(transport: PaymentTransport, params: ObjectData): Promise<string> {
  const created = await transport.request({ method: 'POST', path: '/v1/webhook_endpoints',
    params: { api_version: STRIPE_API_VERSION, enabled_events: [...STRIPE_EVENTS], ...params } });
  return created.id as string;
}
const exists = async (transport: PaymentTransport, id: string) => (await endpoints(transport)).some((endpoint) => endpoint.id === id);

/** Endpoint lifecycle scenarios shared by the offline fixtures and the opt-in test-API run. Each leaves nothing behind. */
export function webhookEndpointContract(name: string, create_harness: () => EndpointHarness) {
  async function scenario(run: (context: EndpointHarness & { provisioner: ReturnType<typeof stripeProvisioner>; extra: string[] }) => Promise<void>) {
    const harness = create_harness(), provisioner = stripeProvisioner(harness.transport), extra: string[] = [];
    try { await run({ ...harness, provisioner, extra }); }
    finally {
      await provisioner.retire(harness.gymId, harness.origin, 'we_none');
      for (const id of extra) await harness.transport.request({ method: 'DELETE', path: '/v1/webhook_endpoints/' + id }).catch(() => undefined);
    }
  }
  describe(name + ' webhook endpoints', () => {
    it('creates a tagged endpoint at the pinned version and keeps it on reconfigure with the same signing secret', () => scenario(async ({ base, provisioner, transport, gymId, origin }) => {
      const first = await provisioner.register(gymId, origin, base + 1);
      expect(first).toMatchObject({ reused: false, endpointId: expect.stringMatching(/^we_/), webhookSecret: expect.stringMatching(/\S/) });
      const again = await provisioner.register(gymId, origin, base + 2, first);
      expect(again).toEqual({ endpointId: first.endpointId, webhookSecret: first.webhookSecret, reused: true });
      const mine = (await endpoints(transport)).filter((endpoint) => endpoint.url === url(origin));
      expect(mine.map((endpoint) => endpoint.id)).toEqual([first.endpointId]);
      expect(mine[0]).toMatchObject({ api_version: STRIPE_API_VERSION, metadata: { gym_id: gymId } });
    }));
    it('brings a kept endpoint up to date with the subscribed events on reconfigure and on check', () => scenario(async ({ base, provisioner, transport, gymId, origin }) => {
      const stored = await provisioner.register(gymId, origin, base + 1);
      const trim = () => transport.request({ method: 'POST', path: '/v1/webhook_endpoints/' + stored.endpointId, params: { enabled_events: ['charge.refunded'] } });
      const events = async () => ((await transport.request({ method: 'GET', path: '/v1/webhook_endpoints/' + stored.endpointId })).enabled_events as string[]).sort();
      expect(await provisioner.check(gymId, origin, stored)).toEqual({ status: 'current' });
      await trim();
      expect(await provisioner.check(gymId, origin, stored)).toEqual({ status: 'updated' });
      expect(await events()).toEqual([...STRIPE_EVENTS].sort());
      await trim();
      expect(await provisioner.register(gymId, origin, base + 2, stored)).toMatchObject({ endpointId: stored.endpointId, reused: true });
      expect(await events()).toEqual([...STRIPE_EVENTS].sort());
    }));
    it('deletes only this gym\'s other endpoints at this install\'s URL', () => scenario(async ({ base, provisioner, transport, gymId, origin, extra }) => {
      const kept = await provisioner.register(gymId, origin, base + 1);
      const duplicate = await provisioner.register(gymId, origin, base + 2);
      expect(duplicate.endpointId).not.toBe(kept.endpointId);
      const otherGym = await create(transport, { url: url(origin), metadata: { gym_id: 'another-gym' } });
      const untagged = await create(transport, { url: url(origin) });
      const otherUrl = await create(transport, { url: origin + '/elsewhere', metadata: { gym_id: gymId } });
      extra.push(otherGym, untagged, otherUrl);
      const retired = await provisioner.retire(gymId, origin, kept.endpointId);
      expect(retired).toEqual({ deleted: [duplicate.endpointId], failures: [] });
      expect(await exists(transport, kept.endpointId)).toBe(true);
      expect(await exists(transport, duplicate.endpointId)).toBe(false);
      for (const id of [otherGym, untagged, otherUrl]) expect(await exists(transport, id)).toBe(true);
    }));
    it('recreates a stored endpoint that is gone, and removes only a tagged one by ID', () => scenario(async ({ base, provisioner, transport, gymId, origin, extra }) => {
      const stored = await provisioner.register(gymId, origin, base + 1);
      expect(await provisioner.remove(gymId, origin, stored.endpointId)).toBe(true);
      expect(await provisioner.remove(gymId, origin, stored.endpointId)).toBe(false);
      // The stored endpoint no longer exists: the check creates a tagged one, and a repeat returns that same endpoint.
      const recreated = await provisioner.check(gymId, origin, stored);
      expect(recreated).toMatchObject({ status: 'recreated', registration: { endpointId: expect.stringMatching(/^we_/), webhookSecret: expect.stringMatching(/\S/) } });
      if (recreated.status !== 'recreated') throw new Error('Expected a recreated endpoint');
      expect(recreated.registration.endpointId).not.toBe(stored.endpointId);
      expect(await provisioner.check(gymId, origin, stored)).toEqual(recreated);
      expect(await transport.request({ method: 'GET', path: '/v1/webhook_endpoints/' + recreated.registration.endpointId }))
        .toMatchObject({ url: url(origin), api_version: STRIPE_API_VERSION, metadata: { gym_id: gymId } });
      expect(await provisioner.check(gymId, origin, recreated.registration)).toEqual({ status: 'current' });
      const replacement = await provisioner.register(gymId, origin, base + 2, stored);
      expect(replacement).toMatchObject({ reused: false });
      expect(replacement.endpointId).not.toBe(stored.endpointId);
      const foreign = await create(transport, { url: url(origin), metadata: { gym_id: 'another-gym' } });
      extra.push(foreign);
      expect(await provisioner.remove(gymId, origin, foreign)).toBe(false);
      expect(await provisioner.check(gymId, origin, { endpointId: foreign, webhookSecret: 'x' })).toEqual({ status: 'skipped' });
      expect(await exists(transport, foreign)).toBe(true);
    }));
  });
}
