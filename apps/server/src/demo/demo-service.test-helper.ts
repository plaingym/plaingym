// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import type { TestClock } from '../core/clock.js';
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

/** `FakePayments` whose charges succeed unless `isDeclined` names the card, as the test processor would decide. */
export function chargingPayments(isDeclined: (paymentMethodId: string) => boolean = () => false) {
  return class TestPayments extends FakePayments {
    override async createCharge(input: CreateCharge) {
      const charge = await super.createCharge(input);
      this.respondNextConfirmation(isDeclined(input.paymentMethodId) ? 'declined' : 'succeeded');
      return charge;
    }
  };
}

/**
 * The demo service over a test database, wired the way the runtime wires it: the demo's payments, one-click
 * identities, the seeds (run with the test processor's gateways and fake uploads) and gym deletion. With
 * `declineFailingCards`, a card seeded as failing is declined when charged; otherwise every charge succeeds.
 */
export function demoServiceFixture(db: TestDatabase, options: {
  env: Record<string, string> & { APP_ENCRYPTION_KEY: string }; clock: TestClock; pinSecret: (() => Promise<Uint8Array>) | null;
  uploads?: Map<string, FakeUploads>; declineFailingCards?: boolean;
}) {
  const { env, clock } = options, uploads = options.uploads ?? new Map<string, FakeUploads>();
  const config = demoBootCheck(env), scope = db.forGym, gateways = new Map<string, BillingSeedProvider>();
  const provider = vi.fn(async (gymId: string) => {
    let gateway = gateways.get(gymId);
    if (gateway) return gateway;
    const declined = new Set<string>();
    const payments = new (chargingPayments(id => declined.has(id)))(gymId, clock);
    gateway = { gymId, mode: 'test', payments, async seedCard(customerId, _householdId, fails) {
      const id = 'pm_' + uuidv7().replaceAll('-', '');
      const declines = options.declineFailingCards === true && fails;
      payments.recordPaymentMethod({ id, customerId, last4: declines ? '0341' : '4242', expiresMonth: 12, expiresYear: 2030 });
      if (declines) declined.add(id);
      return id;
    } };
    gateways.set(gymId, gateway); return gateway;
  });
  const payments = createDemoPayments({ config, scope, system: db.forSystem, clock, provider });
  const authentication = authConfig(env, true);
  const identities = createDemoIdentities({ config, authConfig: authentication, clock, scope,
    accounts: createAccountService(authentication, () => db.system.db),
    authFactory: options => createAuthService({ ...options, database: () => db.system.db }) });
  const log = vi.fn();
  const seed: typeof runSeeds = (context, steps) => runSeeds(context, steps, { env, scope, clock, pinSecret: options.pinSecret, log,
    billingPaymentsFor: payments.forSeed, uploadsFor: async (gymId: string) => {
      if (!uploads.has(gymId)) uploads.set(gymId, new FakeUploads(gymId, clock));
      return uploads.get(gymId)!;
    } });
  const removeUploads = vi.fn(async (_gymId: string) => {});
  const deletion = createGymDeleteService({ clock, scope, system: db.forSystem, removeUploads });
  const service = createDemoService({ config, key: parseEncryptionKey(env.APP_ENCRYPTION_KEY), clock, scope, system: db.forSystem, identities, seed, deletion });
  return { service, seed, clock, config, payments, provider, gateways, log, deletion, removeUploads, authentication };
}
