// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { attendances, classBookings, classSessions, gyms, households, invoices, memberRanks, members, memberships, paymentMethods,
  uuidv7, waiverSignatures } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import { createGymDeleteService } from '../../areas/settings/gym-delete.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { FakePayments, type CreateCharge } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { authConfig } from '../../infra/auth/config.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { createAuthService } from '../../infra/auth/service.js';
import { demoBootCheck } from '../config.js';
import { createDemoPayments } from '../payments.js';
import { createDemoIdentities } from '../identities.js';
import { createDemoService } from '../service.js';
import type { BillingSeedProvider } from './billing-payments.js';
import { runSeeds } from './index.js';
import { demoStudent } from './portal.js';
import type { TestDatabase } from './seeded-database.test-helper.js';

export const pinKey = new Uint8Array(32).fill(7);
export const baseEnv = { DEMO_MODE: 'true', TENANCY: 'multi', DEMO_DOMAIN: 'demo.example.test',
  APP_ENCRYPTION_KEY: 'cd'.repeat(32), AUTH_SECRET: 'demo-portal-seed-secret-with-more-than-32-characters', AUTH_PASSWORD_LOGIN: 'off' };

// Monday noon: the next Competition Training (Tuesday) is cancelled by the mat seed, so Thursday's holds the waitlist.
export function portalFixture(db: TestDatabase, configured: boolean, clock = new TestClock('2026-10-26T12:00:00Z'), uploads = new Map<string, FakeUploads>()) {
  const env = { ...baseEnv, ...(configured ? { DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: 'whsec_SYNTHETIC' } : {}) };
  const config = demoBootCheck(env), scope = db.forGym, gateways = new Map<string, BillingSeedProvider>();
  const provider = vi.fn(async (gymId: string) => {
    let gateway = gateways.get(gymId);
    if (gateway) return gateway;
    class TestPayments extends FakePayments {
      override async createCharge(input: CreateCharge) {
        const charge = await super.createCharge(input);
        this.respondNextConfirmation('succeeded');
        return charge;
      }
    }
    const payments = new TestPayments(gymId, clock);
    gateway = { gymId, mode: 'test', payments, async seedCard(customerId) {
      const id = 'pm_' + uuidv7().replaceAll('-', '');
      payments.recordPaymentMethod({ id, customerId, last4: '4242', expiresMonth: 12, expiresYear: 2030 });
      return id;
    } };
    gateways.set(gymId, gateway); return gateway;
  });
  const payments = createDemoPayments({ config, scope, system: db.forSystem, clock, provider });
  const authentication = authConfig(env, true);
  const identities = createDemoIdentities({ config, authConfig: authentication, clock, scope,
    accounts: createAccountService(authentication, () => db.system.db),
    authFactory: options => createAuthService({ ...options, database: () => db.system.db }) });
  const seed: typeof runSeeds = (context, steps) => runSeeds(context, steps, { env, scope, clock, pinSecret: async () => pinKey, log: () => {},
    billingPaymentsFor: payments.forSeed, uploadsFor: async (gymId: string) => {
      if (!uploads.has(gymId)) uploads.set(gymId, new FakeUploads(gymId, clock));
      return uploads.get(gymId)!;
    } });
  const deletion = createGymDeleteService({ clock, scope, system: db.forSystem, removeUploads: async () => {} });
  const service = createDemoService({ config, key: parseEncryptionKey(env.APP_ENCRYPTION_KEY), clock, scope, system: db.forSystem, identities, seed, deletion });
  return { service, seed, clock, provider };
}
export async function studentRows(db: TestDatabase, gymId: string) {
  return db.forGym(gymId, async tx => {
    const [home] = await tx.select().from(households).where(eq(households.name, demoStudent.household));
    const [member] = await tx.select().from(members).where(eq(members.householdId, home!.id));
    const bookings = await tx.select({ booking: classBookings, session: classSessions }).from(classBookings)
      .innerJoin(classSessions, eq(classBookings.sessionId, classSessions.id)).where(eq(classBookings.memberId, member!.id));
    return { home: home!, member: member!, bookings,
      visits: await tx.select().from(attendances).where(eq(attendances.memberId, member!.id)),
      promotions: await tx.select().from(memberRanks).where(eq(memberRanks.memberId, member!.id)),
      signatures: await tx.select().from(waiverSignatures).where(eq(waiverSignatures.memberId, member!.id)),
      invoices: await tx.select().from(invoices).where(eq(invoices.householdId, home!.id)),
      cards: await tx.select().from(paymentMethods).where(eq(paymentMethods.householdId, home!.id)),
      memberships: await tx.select().from(memberships).where(eq(memberships.householdId, home!.id)),
      gym: (await tx.select().from(gyms))[0]! };
  });
}
