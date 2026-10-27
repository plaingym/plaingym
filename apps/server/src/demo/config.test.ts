// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { demoBootCheck } from './config.js';
import { startRuntime } from '../core/runtime.js';

const env = { DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: 'demo.example.test' };
it('accepts only test secret/restricted keys and requires the install webhook secret', () => {
  expect(demoBootCheck(env).stripe).toBeUndefined();
  for (const testKey of ['sk_test_SYNTHETIC', 'rk_test_SYNTHETIC']) {
    expect(demoBootCheck({ ...env, DEMO_STRIPE_TEST_KEY: testKey, DEMO_STRIPE_WEBHOOK_SECRET: 'whsec_SYNTHETIC' }).stripe)
      .toEqual({ testKey, webhookSecret: 'whsec_SYNTHETIC' });
  }
  for (const testKey of ['rk_other_SYNTHETIC', 'pk_test_SYNTHETIC', 'sk_test_', 'rk_test_bad value'])
    expect(() => demoBootCheck({ ...env, DEMO_STRIPE_TEST_KEY: testKey })).toThrow(/test-mode/);
  expect(() => demoBootCheck({ ...env, DEMO_STRIPE_TEST_KEY: 'sk_test_SYNTHETIC' })).toThrow(/DEMO_STRIPE_WEBHOOK_SECRET/);
});
it('refuses startup with live or non-test restricted keys before opening the database', async () => {
  for (const testKey of ['sk_live_SYNTHETIC', 'rk_live_SYNTHETIC', 'rk_other_SYNTHETIC'])
    await expect(startRuntime({ ...env, DEMO_STRIPE_TEST_KEY: testKey })).rejects.toThrow(/live|test-mode/);
});
