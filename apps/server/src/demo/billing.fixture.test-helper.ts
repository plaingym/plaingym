// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { TestClock } from '../core/clock.js';
import { parseEncryptionKey } from '../core/secrets.js';
import { FakePayments, type CreateCharge } from '../infra/payments/index.js';
import { FakeUploads } from '../infra/storage/index.js';
import { authConfig } from '../infra/auth/config.js';
import { createAccountService } from '../infra/auth/accounts.js';
import { createAuthService } from '../infra/auth/service.js';
import { createGymDeleteService } from '../areas/settings/gym-delete.js';
import { demoBootCheck } from './config.js';
import { createDemoPayments } from './payments.js';
import { createDemoService } from './service.js';
import { createDemoIdentities } from './identities.js';
import { runSeeds } from './seed/index.js';
import type { BillingSeedProvider } from './seed/billing-payments.js';

import type { TestDatabase } from './seed/seeded-database.test-helper.js';

export const secret = 'whsec_SYNTHETIC';
export const baseEnv = { DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: 'demo.example.test',
  APP_ENCRYPTION_KEY: 'cd'.repeat(32), AUTH_SECRET: 'demo-billing-test-secret-with-more-than-32-characters', AUTH_PASSWORD_LOGIN: 'off' };
export function fixture(db: TestDatabase, configured: boolean) {
  const env = { ...baseEnv, ...(configured ? { DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: secret } : {}) };
  const config = demoBootCheck(env), clock = new TestClock('2026-10-26T12:00:00Z'), scope = db.forGym;
  const gateways = new Map<string, BillingSeedProvider>();
  const provider = vi.fn(async (gymId: string) => {
    let gateway = gateways.get(gymId);
    if (gateway) return gateway;
    const declined = new Set<string>();
    class TestPayments extends FakePayments {
      override async createCharge(input: CreateCharge) {
        const charge = await super.createCharge(input);
        this.respondNextConfirmation(declined.has(input.paymentMethodId) ? 'declined' : 'succeeded');
        return charge;
      }
    }
    const payments = new TestPayments(gymId, clock);
    gateway = { gymId, mode: 'test', payments, async seedCard(customerId, _householdId, fails) {
      const id = 'pm_' + uuidv7().replaceAll('-', '');
      payments.recordPaymentMethod({ id, customerId, last4: fails ? '0341' : '4242', expiresMonth: 12, expiresYear: 2030 });
      if (fails) declined.add(id);
      return id;
    } };
    gateways.set(gymId, gateway); return gateway;
  });
  const payments = createDemoPayments({ config, scope, system: db.forSystem, clock, provider });
  const authentication = authConfig(env, true);
  const identities = createDemoIdentities({ config, authConfig: authentication, clock, scope,
    accounts: createAccountService(authentication, () => db.system.db),
    authFactory: options => createAuthService({ ...options, database: () => db.system.db }) });
  const uploads = new Map<string, FakeUploads>(), log = vi.fn();
  const seedOptions = { env, scope, clock, pinSecret: null, log, billingPaymentsFor: payments.forSeed,
    uploadsFor: async (gymId: string) => {
      if (!uploads.has(gymId)) uploads.set(gymId, new FakeUploads(gymId, clock));
      return uploads.get(gymId)!;
    } };
  const seed: typeof runSeeds = (context, steps) => runSeeds(context, steps, seedOptions);
  const removeUploads = vi.fn(async (_gymId: string) => {});
  const deletion = createGymDeleteService({ clock, scope, system: db.forSystem, removeUploads });
  const service = createDemoService({ config, key: parseEncryptionKey(env.APP_ENCRYPTION_KEY), clock, scope, system: db.forSystem, identities, seed, deletion });
  return { service, seed, clock, config, payments, provider, gateways, log, deletion, removeUploads, authentication };
}
