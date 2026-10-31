// SPDX-License-Identifier: AGPL-3.0-only
import { TestClock } from '../core/clock.js';
import { demoServiceFixture } from './demo-service.test-helper.js';
import type { TestDatabase } from './seed/seeded-database.test-helper.js';

export const secret = 'whsec_SYNTHETIC';
export const baseEnv = { DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: 'demo.example.test',
  APP_ENCRYPTION_KEY: 'cd'.repeat(32), AUTH_SECRET: 'demo-billing-test-secret-with-more-than-32-characters', AUTH_PASSWORD_LOGIN: 'off' };
export function fixture(db: TestDatabase, configured: boolean) {
  const env = { ...baseEnv, ...(configured ? { DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: secret } : {}) };
  return demoServiceFixture(db, { env, clock: new TestClock('2026-10-26T12:00:00Z'), pinSecret: null, declineFailingCards: true });
}
