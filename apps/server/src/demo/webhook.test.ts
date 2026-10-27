// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AppError } from '@plaingym/shared';
import { createApp } from '../core/app.js';
import type { RequestEnvironment } from '../core/context.js';
import type { MiddlewareHandler } from 'hono';
import { TestClock } from '../core/clock.js';
import { StripePayments } from '../infra/payments/stripe.js';
import { createWebhookInboxRoutes } from '../areas/billing/webhooks/inbox.routes.js';
import { demoWebhookMiddleware } from './webhook.js';

const gymId = '00000000-0000-7000-8000-000000000001', secret = 'whsec_SYNTHETIC';
const clock = new TestClock('2026-10-26T12:00:00Z');
function fixture(configured = true) {
  const transport = { request: vi.fn(async () => { throw new Error('Unexpected payment lookup'); }) };
  const provider = new StripePayments(gymId, { transport, webhookSecret: secret, mode: 'test', clock });
  const receive = vi.fn(async (_gymId: string, body: Uint8Array, signature: string) => { await provider.parseWebhook(body, signature); });
  const demoGyms = vi.fn(async () => [{ gymId }]);
  const tenant = vi.fn<MiddlewareHandler<RequestEnvironment>>(async (context, next) => {
    if (configured) throw new Error('Unexpected tenant middleware');
    context.set('context', { ...context.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } });
    await next();
  });
  const tenantReceive = vi.fn(async () => { throw new AppError('unavailable', 'Payments are not set up for this gym'); });
  let restoring = false;
  const gate = vi.fn(async (c: Parameters<ReturnType<typeof demoWebhookMiddleware>>[0], next: () => Promise<void>) => {
    if (restoring) return c.json({ restoring: true }, 503);
    await next();
  });
  const app = createApp({ resolveGym: tenant, session: tenant, authorize: () => tenant, clock,
    contributions: { routes: createWebhookInboxRoutes({ receive: tenantReceive }) },
    bodyLimits: { default: 1000, routes: {} }, restoreGate: demoWebhookMiddleware({ configured, inbox: { receive }, demoGyms, restoreGate: gate }) });
  const request = (body: string, signature?: string) => {
    const timestamp = Math.floor(clock.now().getTime() / 1000);
    const signed = signature ?? `t=${timestamp},v1=${createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')}`;
    return app.request('https://demo.example.test/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signed } });
  };
  return { request, receive, demoGyms, tenant, tenantReceive, gate, restore: () => { restoring = true; } };
}
const event = (gym = gymId) => JSON.stringify({ id: 'evt_demo', object: 'event', type: 'payment_intent.succeeded', livemode: false,
  data: { object: { id: 'pi_demo', object: 'payment_intent', metadata: { gym_id: gym } } } }, null, 2);
it('keeps exact signed bytes after body limiting and bypasses tenant/session middleware', async () => {
  const f = fixture(), body = event();
  expect((await f.request(body)).status).toBe(200);
  expect(new TextDecoder().decode(f.receive.mock.calls[0]![1])).toBe(body);
  expect(f.tenant).not.toHaveBeenCalled(); expect(f.gate).toHaveBeenCalledOnce();
});
it.each([false, true])('applies body limits and the restore gate before looking up destinations (configured=%s)', async configured => {
  const f = fixture(configured);
  expect((await f.request('x'.repeat(1001))).status).toBe(400);
  expect(f.gate).not.toHaveBeenCalled(); expect(f.demoGyms).not.toHaveBeenCalled();
  f.restore(); expect((await f.request(event())).status).toBe(503);
  expect(f.demoGyms).not.toHaveBeenCalled(); expect(f.receive).not.toHaveBeenCalled();
  expect(f.tenant).not.toHaveBeenCalled();
});
it('passes through to the tenant webhook route when the shared key is absent', async () => {
  const f = fixture(false), response = await f.request(event());
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('Payments are not set up for this gym');
  expect(f.tenant).toHaveBeenCalled(); expect(f.tenantReceive).toHaveBeenCalledOnce();
  expect(f.demoGyms).not.toHaveBeenCalled(); expect(f.receive).not.toHaveBeenCalled();
  expect(f.gate).toHaveBeenCalledOnce();
});
it('acknowledges unknown gyms and an empty sandbox pool, and rejects invalid signatures', async () => {
  const f = fixture();
  expect((await f.request(event('00000000-0000-7000-8000-000000000002'))).status).toBe(200);
  expect((await f.request(event(), 'invalid')).status).toBe(400);
  f.receive.mockClear(); f.demoGyms.mockResolvedValue([]);
  expect((await f.request(event())).status).toBe(200); expect(f.receive).not.toHaveBeenCalled();
});
