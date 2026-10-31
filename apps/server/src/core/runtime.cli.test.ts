// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Assembly test inspects queued jobs and the gym's Stripe settings in real PostgreSQL.
import { gyms, jobs } from '@plaingym/db';
import * as stripeAdapter from '../infra/payments/stripe.js';
import { StripeFixtures } from '../infra/payments/stripe-fixtures.js';
import { runCommandLine } from './runtime.js';
import { demoStripeEnv, useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database } = app;

it('registers seed and webhook replay in the real CLI', async () => {
  const sandbox = app.sandbox;
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  const cliEnv = { ...app.env(), ...demoStripeEnv };
  // The inbox holds one delivered event for the replay to queue again.
  const delivered = vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(new StripeFixtures(sandbox.gymId));
  try {
    await app.restart(demoStripeEnv);
    expect((await app.deliverStripeEvent('evt_runtime')).status).toBe(200);
  } finally { delivered.mockRestore(); }
  // Start past the payment intent IDs the sandbox may already hold.
  const transport = new StripeFixtures(sandbox.gymId, undefined, 1000);
  const request = transport.request.bind(transport);
  // StripeFixtures covers billing; add only the named test-token operations used by demo seeding.
  vi.spyOn(transport, 'request').mockImplementation(async input => {
    if (input.method === 'POST' && input.path === '/v1/payment_methods') {
      const params = input.params!, card = params.card as { token: string };
      expect(['tok_visa', 'tok_chargeCustomerFail']).toContain(card.token);
      const last4 = card.token === 'tok_visa' ? '4242' : '0341';
      const method = { id: 'pm_' + String((params.metadata as { household_id: string }).household_id).replaceAll('-', '') + last4,
        object: 'payment_method', customer: null, metadata: params.metadata, livemode: false,
        created: transport.now, card: { last4, exp_month: 12, exp_year: 2030 } };
      transport.objects.set(method.id, method);
      return method;
    }
    if (input.method === 'POST' && /^\/v1\/payment_methods\/pm_[A-Za-z0-9]+\/attach$/.test(input.path)) {
      const method = transport.objects.get(input.path.split('/')[3]!)!;
      method.customer = input.params!.customer;
      return method;
    }
    return request(input);
  });
  const provider = vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(transport);
  await app.runtime.stop();
  // A real CLI process reads these settings from its environment as well as
  // passing them into runtime preparation. Seed storage now uses them too.
  for (const [name, value] of Object.entries(cliEnv)) vi.stubEnv(name, value);
  try {
    expect(await runCommandLine(['seed', sandbox.gymId], io, cliEnv)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith('Seed complete');
    expect(await runCommandLine(['replay', '--gym', sandbox.gymId, 'evt_runtime'], io, cliEnv)).toBe(0);
    expect(io.stdout).toHaveBeenCalledWith(expect.stringMatching(/^Webhook replay queued: /));
    expect(await database.forSystem((tx) => tx.select().from(jobs).where(eq(jobs.name, 'billing.webhooks.dispatch')))).toHaveLength(2);
    expect((await database.forGym(sandbox.gymId, tx => tx.select().from(gyms)))[0]!.stripeConfig).toBeNull();
  } finally { vi.unstubAllEnvs(); provider.mockRestore(); }
}, 90_000);
