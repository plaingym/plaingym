// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, addressAllocator, type Program } from '../support.js';
import { fakeStripe, stripeSecret } from '../portal.js';
import { clearGymSteps, contextOf, createGym, gyms, stripeAs, stripeKeyOf } from './support.js';

test('client address blocks are disjoint and never wrap', () => {
  const main = addressAllocator(), worker = addressAllocator('0');
  const mainAddresses = new Set(Array.from({ length: 4096 }, main));
  const workerAddresses = Array.from({ length: 4096 }, worker);
  expect(mainAddresses.size).toBe(4096);
  expect(new Set(workerAddresses).size).toBe(4096);
  expect(workerAddresses.some(address => mainAddresses.has(address))).toBe(false);
  expect(main).toThrow('exhausted');
  expect(worker).toThrow('exhausted');
  expect(addressAllocator('30')).not.toThrow();
  expect(addressAllocator('31')).toThrow('No client address block');
  expect(addressAllocator('-1')).toThrow('No client address block');
});

test('the fake Stripe rejects unissued keys without creating an account', async () => {
  const madeUp = 'rk_test_0123456789abcdef0123456789abcdef';
  const rejected = await stripeAs(madeUp).request('/v1/customers');
  expect(rejected.status).toBe(401);
  expect(rejected.text).toContain('Fake Stripe key mismatch');
  expect((await fakeStripe().request('/test/sign-webhook', 'POST', { key: madeUp, body: '{}' })).status).toBe(404);
  expect((await stripeAs(madeUp).request('/v1/customers')).status).toBe(401);
  for (const key of [stripeSecret('E2E_STRIPE_KEY'), stripeSecret('E2E_STRIPE_RESTRICTED_KEY'), ...gyms.map(gym => stripeKeyOf(gym.slug))]) {
    expect((await stripeAs(key).request('/v1/customers')).status).toBe(200);
  }
});

for (const pass of [1, 2]) test(`fixture resumes after coach acceptance and program creation without duplicate writes (pass ${pass})`, async () => {
  test.setTimeout(180_000);
  await clearGymSteps(gyms[0], ['coach', 'ranks']);
  for (const failAt of ['coach', 'ranks'] as const) {
    await expect(createGym(gyms[0], step => {
      if (step === failAt) throw new Error('Injected failure after ' + step);
    })).rejects.toThrow('Injected failure after ' + failAt);
  }
  const gym = contextOf(await createGym(gyms[0]));
  const roles = await gym.owner.json<{ data: { role: string }[] }>('/api/staff/roles?limit=100');
  expect(roles.data.filter(role => role.role === 'coach')).toHaveLength(1);
  const programs = await gym.owner.json<{ data: Program[] }>('/api/programs?limit=100');
  expect(programs.data.filter(program => program.name === gym.program.name)).toEqual([gym.program]);
  const systems = await gym.owner.json<{ data: { id: string; name: string }[] }>('/api/rank-systems?limit=100');
  expect(systems.data.filter(system => system.name === gym.name + ' belts')).toHaveLength(1);
});
